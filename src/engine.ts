import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { Session } from '@deepseek-ai/dsh-session'
import { snapshotCatalog, describeTool, buildCatalogView } from './catalog.ts'
import { FORCED_EAGER } from './groups.ts'
import { BRIDGE_NAMES } from './bridge.ts'
import { MANAGEMENT_NAMES } from './setup.ts'
import { keywordSearch, searchCatalog } from './matcher.ts'
import { RuntimeConfigStore } from './config.ts'
import { applyDisclosure, budgetFor, computeDisclosure, computeTier, withManifest } from './disclosure.ts'
import { isPtcOnlyAssembly, PTC_TRANSPORT_TOOL } from './ptc.ts'
import { applySdkSection, PTC_MANIFEST_HEADER, sdkSchemas } from './sdk.ts'
import { estimateTokens } from './catalog.ts'
import { buildGroupedManifest } from './groups.ts'
import type {
  CatalogEntry,
  CatalogView,
  RuntimeFileConfig,
  SearchOutcome,
  ToolGroupSpec,
  ToolSearchConfig,
  UpdateConfigInput,
  UpdateConfigResult,
} from './types.ts'
import { validateGroups } from './groups.ts'

/** Names that stay directly visible whatever the tier decides. */
const ALWAYS_VISIBLE: readonly string[] = [...BRIDGE_NAMES, ...MANAGEMENT_NAMES, PTC_TRANSPORT_TOOL]

/** One agent's applied surface: the restriction hiding its deferred tools. */
interface SurfaceState {
  /** Whether the agent presents tools through the generated SDK instead of the native table. */
  ptc: boolean
  /** Tool names the live restriction denies, sorted. */
  deny: readonly string[]
  /** Lifts the restriction; absent when nothing is denied. */
  lift?: () => void
}

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

/** Whether two name lists hold the same names. */
function sameNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((name, index) => name === right[index])
}

/**
 * The dsh-tool-search engine: resolves runtime config, hides the deferred
 * catalog behind a scoped `ctx.tools.restrict()` registration, serves the
 * bridge and setup tools, and maintains the per-session warm set that brings
 * discovered tools back into the agent's visible surface. One instance per
 * plugin load.
 */
export class ToolSearchEngine {
  /** Session id → tool name → last-use sequence (warm set, LRU-bounded). */
  private readonly warm = new Map<string, Map<string, number>>()
  /** Sessions whose preload already ran. */
  private readonly preloadedSessions = new Set<string>()
  /** Live surface per agent; a weak key so a disposed agent's entry dies with it. */
  private readonly surfaces = new WeakMap<Agent, SurfaceState>()
  private warmSeq = 0

  constructor(
    private readonly ctx: Context,
    private readonly config: ToolSearchConfig,
    private readonly store: RuntimeConfigStore,
  ) {}

  /**
   * The catalog this plugin reasons about: every globally registered tool
   * (restriction-independent, so hiding one never removes it from the search
   * index) plus the tools that only this agent's own scope registers.
   * @param agent - the viewing agent, or undefined for the global view.
   * @param groups - the configured groups used to annotate each tool.
   * @returns the catalog rows in registration order.
   */
  private entries(agent: Agent | undefined, groups: readonly ToolGroupSpec[]): CatalogEntry[] {
    const global = this.ctx.tools.schemas()
    if (agent === undefined) return snapshotCatalog(global, groups)
    const globalNames = new Set(global.map(schema => schema.name))
    // A scoped view applies this plugin's own restriction to inherited tools;
    // the agent's own registrations stay visible and are the only extra rows.
    const scoped = this.ctx.tools.schemas(agent).filter(schema => !globalNames.has(schema.name))
    return snapshotCatalog([...global, ...scoped], groups)
  }

  /**
   * Recompute one agent's visible surface and (re)install its restriction.
   *
   * The restriction hides every catalog tool that is not eager, so it must be
   * in place before the step's tool admission resolves; callers run it on
   * `agent/created`, on each claimed turn, and after every tool result.
   * @param agent - the agent whose surface is refreshed.
   * @param ptc - whether the agent presents tools through the generated SDK
   *   (a strict `ptc` scope declares through `tools:sdk`, so nothing is hidden).
   */
  async refresh(agent: Agent | undefined, ptc?: boolean): Promise<void> {
    if (agent === undefined) return
    const runtime = await this.store.resolve(this.config.configScope, cwdOf(agent))
    const entries = this.entries(agent, runtime.config.groups ?? [])
    const state = this.surfaces.get(agent)
    const presenting = ptc ?? state?.ptc ?? false
    // A catalog this plugin leaves alone must keep every tool visible: hiding
    // below the activation size would slim a surface nothing discloses.
    const active = this.config.enabled !== 'off'
      && (this.config.enabled === 'on' || entries.length > this.config.minCatalogSize)
    const hidden = active && !presenting
      ? this.hiddenNames(entries, await this.eagerNames(agent, entries, runtime.config))
      : []
    if (state !== undefined && state.ptc === presenting && sameNames(state.deny, hidden)) return
    state?.lift?.()
    const next: SurfaceState = { ptc: presenting, deny: hidden }
    if (hidden.length > 0) {
      try {
        next.lift = agent.ctx.tools.restrict({ deny: [...hidden] })
      } catch (error) {
        // A catalog observed mid-registration can name a tool the registry no
        // longer holds; the next refresh retries from a fresh snapshot.
        this.ctx.logger.warn(`dsh-tool-search: tool restriction skipped: ${errorMessage(error)}`)
      }
    }
    this.surfaces.set(agent, next)
  }

  /**
   * Refresh one agent's surface and bring its visible set up to date for the
   * assembly about to be returned. Keeps only textual contributions: tool
   * declarations belong to the registry, so the waterfall adds the manifest
   * (and, in a strict `ptc` scope, re-renders the generated declarations).
   * @param assembly - the settled assembly from the waterfall chain.
   * @param scope - the calling agent (or undefined for the global view).
   * @returns the transformed assembly.
   */
  async assemble(assembly: PromptAssembly, scope: object | undefined): Promise<PromptAssembly> {
    const agent = agentOf(scope)
    // A strict `ptc` scope declares tools through the generated SDK section, so
    // it keeps its whole visible set and is slimmed by re-rendering that text.
    const ptc = isPtcOnlyAssembly(assembly)
    await this.refresh(agent, ptc)
    const runtime = await this.store.resolve(this.config.configScope, cwdOf(agent))
    const entries = this.entries(agent, runtime.config.groups ?? [])
    const eager = await this.eagerNames(agent, entries, runtime.config)
    const deferred = this.hiddenEntries(entries, eager)
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
    if (ptc) {
      const declared = sdkSchemas(disclosure.tools, name => this.ctx.tools.get(name)?.output.schema)
      return withManifest(applySdkSection(assembly, declared), disclosure.manifest)
    }
    return applyDisclosure(assembly, disclosure)
  }

  /**
   * Whether a name may be invoked through the `tool_call` bridge: it must be a
   * registered tool that is not itself part of the bridge or the setup surface.
   * @param name - the tool name the model asked for.
   * @returns whether the bridge may run it.
   */
  canCall(name: string): boolean {
    if (ALWAYS_VISIBLE.includes(name)) return false
    return this.ctx.tools.get(name) !== undefined
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
    const entries = this.entries(agent, runtime.config.groups ?? [])
    const eager = await this.eagerNames(agent, entries, runtime.config)
    const deferred = this.hiddenEntries(entries, eager)
    const bounded = Math.min(Math.max(limit ?? this.config.searchDefaultLimit, 1), this.config.maxSearchLimit)
    const matcher = runtime.config.matcher
    if (matcher === undefined) {
      const matches = keywordSearch(query, deferred, bounded)
      await this.warmAndRefresh(agent, matches.map(match => match.name))
      return {
        matches,
        mode: 'keyword',
        hint: 'no rerank matcher configured: run the tool-slimmer-setup skill to configure one for semantic ranking',
      }
    }
    try {
      const matches = await searchCatalog(matcher, query, deferred, bounded, this.config.matcherTimeoutMs)
      await this.warmAndRefresh(agent, matches.map(match => match.name))
      return { matches, mode: 'rerank' }
    } catch (error) {
      this.ctx.logger.warn(`dsh-tool-search: rerank failed, falling back to keyword matching: ${errorMessage(error)}`)
      const matches = keywordSearch(query, deferred, bounded)
      await this.warmAndRefresh(agent, matches.map(match => match.name))
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
  async describe(name: string, scope: object | undefined): Promise<{ name: string; description: string; parameters: ToolSchema['parameters'] } | undefined> {
    const agent = agentOf(scope)
    const entries = this.entries(agent, [])
    const schema = describeTool(entries, name)
    if (schema !== undefined) await this.warmAndRefresh(agent, [name])
    return schema
  }

  /** The grouped catalog view the setup skill reads to propose grouping. */
  async catalogView(scope: object | undefined): Promise<CatalogView> {
    const agent = agentOf(scope)
    const runtime = await this.store.resolve(this.config.configScope, cwdOf(agent))
    const entries = this.entries(agent, runtime.config.groups ?? [])
    const eager = await this.eagerNames(agent, entries, runtime.config)
    const deferredNames = new Set(this.hiddenEntries(entries, eager).map(entry => entry.name))
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
    await this.refresh(agent)
    return {
      path,
      scope: target,
      groups: (next.groups ?? []).map(group => ({ name: group.name, tools: [...(group.tools ?? []), ...(group.prefixes ?? [])] })),
      matcherConfigured: next.matcher !== undefined,
      preloadEnabled: next.preload?.enabled === true,
    }
  }

  /**
   * Add tools to a session's warm set, LRU-bounded by `maxWarmTools`, then
   * refresh the agent's surface so a warmed tool stops being hidden.
   * @param agent - the owning agent (warmth is per session).
   * @param names - tool names to warm.
   */
  async warmAndRefresh(agent: Agent | undefined, names: readonly string[]): Promise<void> {
    this.warmTools(agent, names)
    await this.refresh(agent)
  }

  /**
   * Add tools to a session's warm set, LRU-bounded by `maxWarmTools`.
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

  /** Catalog rows the current surface hides: neither eager nor a bridge/transport. */
  private hiddenEntries(entries: readonly CatalogEntry[], eager: ReadonlySet<string>): CatalogEntry[] {
    return entries.filter(entry => !eager.has(entry.name) && !ALWAYS_VISIBLE.includes(entry.name))
  }

  /** The names {@link hiddenEntries} covers, sorted for stable comparison. */
  private hiddenNames(entries: readonly CatalogEntry[], eager: ReadonlySet<string>): readonly string[] {
    return this.hiddenEntries(entries, eager).map(entry => entry.name).sort()
  }

  private async eagerNames(
    agent: Agent | undefined,
    entries: readonly CatalogEntry[],
    runtime: RuntimeFileConfig,
  ): Promise<Set<string>> {
    const preload = await this.preloadNames(agent, entries, runtime)
    return new Set<string>([
      ...this.config.core,
      ...(runtime.core ?? []),
      ...FORCED_EAGER,
      ...ALWAYS_VISIBLE,
      ...this.warmNamesFor(agent),
      ...preload,
    ])
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
