import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { Session } from '@deepseek-ai/dsh-session'
import { snapshotCatalog, describeTool, buildCatalogView } from './catalog.ts'
import { FORCED_EAGER } from './groups.ts'
import { BRIDGE_NAMES } from './bridge.ts'
import { searchCatalog } from './matcher.ts'
import { RuntimeConfigStore } from './config.ts'
import { applyDisclosure, budgetFor, computeDisclosure, computeTier } from './disclosure.ts'
import { estimateTokens } from './catalog.ts'
import { buildGroupedManifest } from './groups.ts'
import type {
  CatalogEntry,
  CatalogView,
  RuntimeFileConfig,
  SearchMatch,
  ToolSearchConfig,
  UpdateConfigInput,
  UpdateConfigResult,
} from './types.ts'
import { validateGroups } from './groups.ts'

/** Extract the last non-empty user text from a session, or `''` when none. */
function lastUserText(session: Session): string {
  const derive = (session as unknown as { deriveMessages?: () => readonly unknown[] }).deriveMessages
  if (derive === undefined) return ''
  const messages = derive.call(session)
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; content?: unknown } | null | undefined
    if (message?.role !== 'user') continue
    const content = message.content
    if (!Array.isArray(content)) continue
    for (let j = content.length - 1; j >= 0; j -= 1) {
      const block = content[j] as { type?: unknown; text?: unknown } | null | undefined
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        return block.text
      }
    }
  }
  return ''
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** The agent behind a scope key, when the runtime supplied one. */
function agentOf(scope: object | undefined): Agent | undefined {
  if (scope === undefined || scope === null) return undefined
  const candidate = scope as Partial<Agent>
  return candidate.session !== undefined ? (scope as Agent) : undefined
}

/** The session workspace of an agent, when the session carries one. */
function cwdOf(agent: Agent | undefined): string | undefined {
  return (agent?.session as unknown as { cwd?: string } | undefined)?.cwd
}

/**
 * The dsh-tool-search engine: resolves runtime config, computes the slimmed
 * model-visible tool surface per assembly, and serves the bridge and setup
 * tools. One instance per plugin load.
 */
export class ToolSearchEngine {
  /** Session id → preloaded eager tool names (preload cache). */
  private readonly preloaded = new Map<string, string[]>()

  constructor(
    private readonly ctx: Context,
    private readonly config: ToolSearchConfig,
    private readonly store: RuntimeConfigStore,
  ) {}

  /**
   * Transform one settled assembly: replace `assembly.tools` with the eager
   * core plus bridge tools and append the tiered manifest section. Tier 0 and
   * `enabled: off` return the assembly untouched. Idempotent: the catalog is
   * re-read from the registry on every call.
   * @param assembly - the settled assembly from the waterfall chain.
   * @param scope - the calling agent (or undefined for the global view).
   * @returns the transformed assembly.
   */
  async assemble(assembly: PromptAssembly, scope: object | undefined): Promise<PromptAssembly> {
    const agent = agentOf(scope)
    const runtime = await this.store.resolve(this.config.configScope, cwdOf(agent))
    const groups = runtime.config.groups ?? []
    const entries = snapshotCatalog(this.ctx.tools.schemas(agent ?? undefined), groups)
    const eager = await this.eagerNames(agent, entries, runtime.config)
    const deferred = entries.filter(entry => !eager.has(entry.name))
    if (deferred.length === 0) return assembly
    const forced = this.config.enabled === 'on'
    if (!forced && entries.length <= this.config.minCatalogSize) return assembly
    const budget = budgetFor(this.config.thresholdPct, this.config.contextWindow, this.config.listingMaxTokens)
    const tier = computeTier({
      catalogSize: entries.length,
      deferredSize: deferred.length,
      manifestTokens: estimateTokens(buildGroupedManifest(deferred, 'full')),
      namesOnlyTokens: estimateTokens(buildGroupedManifest(deferred, 'names')),
      budget,
      minCatalogSize: this.config.minCatalogSize,
      forced,
    })
    const disclosure = computeDisclosure(entries, eager, new Set<string>(BRIDGE_NAMES), tier)
    return applyDisclosure(assembly, disclosure)
  }

  /**
   * Semantic search over the deferred catalog. Requires a configured matcher;
   * throws with setup guidance when absent.
   * @param query - the model's search query.
   * @param limit - requested result count (clamped to config bounds).
   * @param scope - the calling agent.
   * @returns matches sorted by relevance.
   */
  async search(query: string, limit: number | undefined, scope: object | undefined): Promise<SearchMatch[]> {
    const agent = agentOf(scope)
    const runtime = await this.store.resolve(this.config.configScope, cwdOf(agent))
    if (runtime.config.matcher === undefined) {
      throw new Error('no rerank matcher configured: run the tool-slimmer-setup skill to configure one')
    }
    const entries = snapshotCatalog(this.ctx.tools.schemas(agent ?? undefined), runtime.config.groups ?? [])
    const eager = await this.eagerNames(agent, entries, runtime.config)
    const deferred = entries.filter(entry => !eager.has(entry.name))
    const bounded = Math.min(Math.max(limit ?? this.config.searchDefaultLimit, 1), this.config.maxSearchLimit)
    return searchCatalog(runtime.config.matcher, query, deferred, bounded, this.config.matcherTimeoutMs)
  }

  /**
   * Resolve the full schema of one catalog tool.
   * @param name - the tool name.
   * @param scope - the calling agent.
   * @returns the model-facing schema fields, or `undefined` when unknown.
   */
  describe(name: string, scope: object | undefined): { name: string; description: string; parameters: ToolSchema['parameters'] } | undefined {
    const entries = snapshotCatalog(this.ctx.tools.schemas(agentOf(scope) ?? undefined), [])
    return describeTool(entries, name)
  }

  /** The grouped catalog view the setup skill reads to propose grouping. */
  async catalogView(scope: object | undefined): Promise<CatalogView> {
    const agent = agentOf(scope)
    const runtime = await this.store.resolve(this.config.configScope, cwdOf(agent))
    const entries = snapshotCatalog(this.ctx.tools.schemas(agent ?? undefined), runtime.config.groups ?? [])
    return buildCatalogView(entries)
  }

  /**
   * Validate and persist a runtime config update, then drop stale caches.
   * @param input - groups/matcher/preload/core changes and the target scope.
   * @param scope - the calling agent (drives the default scope and workspace).
   * @returns the written path, effective scope, and a summary for the model.
   */
  async updateConfig(input: UpdateConfigInput, scope: object | undefined): Promise<UpdateConfigResult> {
    const agent = agentOf(scope)
    const current = await this.store.resolve(this.config.configScope, cwdOf(agent))
    const target = input.scope ?? current.scope
    if (input.groups !== undefined) {
      const reason = validateGroups(input.groups)
      if (reason !== undefined) throw new Error(`invalid groups: ${reason}`)
    }
    const next: RuntimeFileConfig = {
      ...current.config,
      ...input.groups !== undefined ? { groups: input.groups } : {},
      ...input.matcher !== undefined ? { matcher: input.matcher } : {},
      ...input.preload !== undefined ? { preload: input.preload } : {},
      ...input.core !== undefined ? { core: input.core } : {},
    }
    const path = await this.store.write(target, cwdOf(agent), next)
    this.preloaded.clear()
    return {
      path,
      scope: target,
      groups: (next.groups ?? []).map(group => ({ name: group.name, tools: [...(group.tools ?? []), ...(group.prefixes ?? [])] })),
      matcherConfigured: next.matcher !== undefined,
      preloadEnabled: next.preload?.enabled === true,
    }
  }

  private async eagerNames(agent: Agent | undefined, entries: readonly CatalogEntry[], runtime: RuntimeFileConfig): Promise<Set<string>> {
    const preload = await this.preloadNames(agent, entries, runtime)
    return new Set<string>([...this.config.core, ...(runtime.core ?? []), ...FORCED_EAGER, ...preload])
  }

  private async preloadNames(agent: Agent | undefined, entries: readonly CatalogEntry[], runtime: RuntimeFileConfig): Promise<string[]> {
    const preload = runtime.preload
    if (preload?.enabled !== true || runtime.matcher === undefined) return []
    const session = agent?.session
    if (session === undefined) return []
    const cached = this.preloaded.get(session.id)
    if (cached !== undefined) return cached
    const query = lastUserText(session)
    if (query === '') return []
    try {
      const matches = await searchCatalog(runtime.matcher, query, entries, preload.topK, this.config.matcherTimeoutMs)
      const names = matches.map(match => match.name)
      this.preloaded.set(session.id, names)
      return names
    } catch (error) {
      this.ctx.logger.warn(`dsh-tool-search: preload failed: ${errorMessage(error)}`)
      this.preloaded.set(session.id, [])
      return []
    }
  }
}
