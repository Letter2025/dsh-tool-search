import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { Session } from '@deepseek-ai/dsh-session'
import { snapshotCatalog, describeTool, buildCatalogView } from './catalog.ts'
import { FORCED_EAGER } from './groups.ts'
import { BRIDGE_NAMES } from './bridge.ts'
import { keywordSearch, searchCatalog } from './matcher.ts'
import { RuntimeConfigStore } from './config.ts'
import { applyDisclosure, budgetFor, computeDisclosure, computeTier, withManifest } from './disclosure.ts'
import { isPtcOnlyAssembly, transportNamesIn } from './ptc.ts'
import { applySdkSection, PTC_MANIFEST_HEADER, sdkSchemas } from './sdk.ts'
import { estimateTokens } from './catalog.ts'
import { buildGroupedManifest } from './groups.ts'
import type {
  CatalogEntry,
  CatalogView,
  RuntimeFileConfig,
  SearchOutcome,
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
  return agent?.session.header.cwd
}

/**
 * The dsh-tool-search engine: resolves runtime config, computes the slimmed
 * model-visible tool surface per assembly, serves the bridge and setup tools,
 * and maintains the per-session warm set that dynamically injects discovered
 * tools back into the visible context. One instance per plugin load.
 */
export class ToolSearchEngine {
  /** Session id → tool name → last-use sequence (warm set, LRU-bounded). */
  private readonly warm = new Map<string, Map<string, number>>()
  /** Sessions whose preload already ran. */
  private readonly preloadedSessions = new Set<string>()
  private warmSeq = 0

  constructor(
    private readonly ctx: Context,
    private readonly config: ToolSearchConfig,
    private readonly store: RuntimeConfigStore,
  ) {}

  /**
   * Transform one settled assembly: replace `assembly.tools` with the eager
   * core, bridge tools, and warm tools, re-render the `tools:sdk` declarations
   * for that same surface, and append the tiered manifest as a runtime context
   * (sections may be clobbered by a complete prompt; contexts survive). A strict
   * `ptc` scope keeps its collapsed tool table — the `run_code` transport — and
   * is slimmed through the SDK section instead. Tier 0 returns the assembly
   * untouched. Idempotent: the catalog is re-read from the registry on every
   * call.
   * @param assembly - the settled assembly from the waterfall chain.
   * @param scope - the calling agent (or undefined for the global view).
   * @returns the transformed assembly.
   */
  async assemble(assembly: PromptAssembly, scope: object | undefined): Promise<PromptAssembly> {
    // A strict `ptc` scope owns its tool table: `dsh-tools` collapses it to the
    // `run_code` transport and moves every declaration into `tools:sdk`.
    // Replacing the table would delete `run_code` from the prompt, so that path
    // keeps the table and slims the declarations instead.
    const ptc = isPtcOnlyAssembly(assembly)
    // From dsh 0.2.1-rc.3 the waterfall receives the presentation alone and the
    // host appends its own tool table afterwards, so a scope without a table of
    // its own keeps the declarations it was given: only the sections and
    // contexts this hook returns are authoritative, and a table rewrite is a
    // silent no-op the plugin must not rely on.
    const ownsTable = Array.isArray(assembly.tools)
    const agent = agentOf(scope)
    const runtime = await this.store.resolve(this.config.configScope, cwdOf(agent))
    const groups = runtime.config.groups ?? []
    const entries = snapshotCatalog(this.ctx.tools.schemas(agent ?? undefined), groups)
    const eager = await this.eagerNames(agent, entries, runtime.config, transportNamesIn(assembly))
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
    const disclosure = computeDisclosure(entries, eager, new Set<string>(BRIDGE_NAMES), tier, ptc ? PTC_MANIFEST_HEADER : undefined)
    const declared = sdkSchemas(disclosure.tools, name => this.ctx.tools.get(name, agent ?? undefined)?.output.schema)
    if (ptc) return withManifest(await applySdkSection(assembly, declared), disclosure.manifest)
    if (!ownsTable) return assembly
    return await applySdkSection(applyDisclosure(assembly, disclosure), declared)
  }

  /**
   * Search the deferred catalog. Uses the configured rerank matcher when
   * present; falls back to keyword matching when absent or on rerank failure,
   * so `tool_search` never dead-ends. Also warms the matched tools into the
   * session's visible set (dynamic injection).
   * @param query - the model's search query.
   * @param limit - requested result count (clamped to config bounds).
   * @param scope - the calling agent.
   * @returns matches plus the ranking mode used.
   */
  async search(query: string, limit: number | undefined, scope: object | undefined): Promise<SearchOutcome> {
    const agent = agentOf(scope)
    const runtime = await this.store.resolve(this.config.configScope, cwdOf(agent))
    const entries = snapshotCatalog(this.ctx.tools.schemas(agent ?? undefined), runtime.config.groups ?? [])
    const eager = await this.eagerNames(agent, entries, runtime.config)
    const deferred = entries.filter(entry => !eager.has(entry.name))
    const bounded = Math.min(Math.max(limit ?? this.config.searchDefaultLimit, 1), this.config.maxSearchLimit)
    const matcher = runtime.config.matcher
    if (matcher === undefined) {
      const matches = keywordSearch(query, deferred, bounded)
      this.warmTools(agent, matches.map(match => match.name))
      return {
        matches,
        mode: 'keyword',
        hint: 'no rerank matcher configured: run the tool-slimmer-setup skill to configure one for semantic ranking',
      }
    }
    try {
      const matches = await searchCatalog(matcher, query, deferred, bounded, this.config.matcherTimeoutMs)
      this.warmTools(agent, matches.map(match => match.name))
      return { matches, mode: 'rerank' }
    } catch (error) {
      this.ctx.logger.warn(`dsh-tool-search: rerank failed, falling back to keyword matching: ${errorMessage(error)}`)
      const matches = keywordSearch(query, deferred, bounded)
      this.warmTools(agent, matches.map(match => match.name))
      return {
        matches,
        mode: 'keyword',
        hint: `rerank failed (${errorMessage(error)}); fell back to keyword matching`,
      }
    }
  }

  /**
   * Resolve the full schema of one catalog tool and warm it into the session.
   * @param name - the tool name.
   * @param scope - the calling agent.
   * @returns the model-facing schema fields, or `undefined` when unknown.
   */
  describe(name: string, scope: object | undefined): { name: string; description: string; parameters: ToolSchema['parameters'] } | undefined {
    const agent = agentOf(scope)
    const entries = snapshotCatalog(this.ctx.tools.schemas(agent ?? undefined), [])
    const schema = describeTool(entries, name)
    if (schema !== undefined) this.warmTools(agent, [name])
    return schema
  }

  /** The grouped catalog view the setup skill reads to propose grouping. */
  async catalogView(scope: object | undefined): Promise<CatalogView> {
    const agent = agentOf(scope)
    const runtime = await this.store.resolve(this.config.configScope, cwdOf(agent))
    const entries = snapshotCatalog(this.ctx.tools.schemas(agent ?? undefined), runtime.config.groups ?? [])
    const eager = await this.eagerNames(agent, entries, runtime.config)
    const deferredNames = new Set(entries.filter(entry => !eager.has(entry.name)).map(entry => entry.name))
    return buildCatalogView(entries, deferredNames)
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
    this.warm.clear()
    this.preloadedSessions.clear()
    return {
      path,
      scope: target,
      groups: (next.groups ?? []).map(group => ({ name: group.name, tools: [...(group.tools ?? []), ...(group.prefixes ?? [])] })),
      matcherConfigured: next.matcher !== undefined,
      preloadEnabled: next.preload?.enabled === true,
    }
  }

  /**
   * Add tools to a session's warm set, LRU-bounded by `maxWarmTools`. Warm
   * tools are injected into the visible context on subsequent assemblies.
   * @param agent - the owning agent (warmth is per session).
   * @param names - tool names to warm.
   */
  warmTools(agent: Agent | undefined, names: readonly string[]): void {
    const session = agent?.session
    if (session === undefined || names.length === 0) return
    let set = this.warm.get(session.id)
    if (set === undefined) {
      set = new Map<string, number>()
      this.warm.set(session.id, set)
    }
    for (const name of names) {
      set.set(name, ++this.warmSeq)
    }
    while (set.size > this.config.maxWarmTools) {
      let oldest: string | undefined
      let oldestSeq = Number.POSITIVE_INFINITY
      for (const [name, seq] of set) {
        if (seq < oldestSeq) {
          oldestSeq = seq
          oldest = name
        }
      }
      if (oldest === undefined) break
      set.delete(oldest)
    }
  }

  /** The names of a session's warm tools, in warm order (oldest first). */
  warmNamesFor(agent: Agent | undefined): readonly string[] {
    if (agent === undefined) return []
    return [...(this.warm.get(agent.session.id) ?? new Map<string, number>()).keys()]
  }

  private async eagerNames(
    agent: Agent | undefined,
    entries: readonly CatalogEntry[],
    runtime: RuntimeFileConfig,
    transport: readonly string[] = [],
  ): Promise<Set<string>> {
    const preload = await this.preloadNames(agent, entries, runtime)
    return new Set<string>([...this.config.core, ...(runtime.core ?? []), ...FORCED_EAGER, ...transport, ...this.warmNamesFor(agent), ...preload])
  }

  private async preloadNames(agent: Agent | undefined, entries: readonly CatalogEntry[], runtime: RuntimeFileConfig): Promise<string[]> {
    const preload = runtime.preload
    if (preload?.enabled !== true || runtime.matcher === undefined) return []
    const session = agent?.session
    if (session === undefined || this.preloadedSessions.has(session.id)) return []
    const query = lastUserText(session)
    if (query === '') return []
    this.preloadedSessions.add(session.id)
    try {
      const matches = await searchCatalog(runtime.matcher, query, entries, preload.topK, this.config.matcherTimeoutMs)
      const names = matches.map(match => match.name)
      this.warmTools(agent, names)
      return names
    } catch (error) {
      this.ctx.logger.warn(`dsh-tool-search: preload failed: ${errorMessage(error)}`)
      return []
    }
  }
}
