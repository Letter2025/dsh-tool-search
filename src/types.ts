import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/** Where the runtime config file lives: user-global or per-project. */
export type RuntimeScope = 'user' | 'project'

/** Which runtime config file the engine reads; `auto` prefers the project file. */
export type ConfigScope = RuntimeScope | 'auto'

/** When the bridge activates: `auto` gates on catalog size. */
export type EnableMode = 'auto' | 'on' | 'off'

/** One user-defined tool group: exact names and/or name prefixes. */
export interface ToolGroupSpec {
  readonly name: string
  readonly tools?: readonly string[]
  readonly prefixes?: readonly string[]
}

/** Rerank matcher (OpenAI-compatible `/v1/rerank` shape). The only matcher type. */
export interface RerankMatcherConfig {
  readonly endpoint: string
  readonly apiKey: string
  readonly model: string
  readonly topN?: number
}

/** Optional session-start semantic preload; requires a configured matcher. */
export interface PreloadConfig {
  readonly enabled: boolean
  readonly topK: number
}

/** The runtime `dsh-tool-search.json` file written by the setup skill. */
export interface RuntimeFileConfig {
  readonly version?: number
  readonly groups?: readonly ToolGroupSpec[]
  readonly matcher?: RerankMatcherConfig
  readonly preload?: PreloadConfig
  readonly core?: readonly string[]
  readonly scope?: RuntimeScope
}

/** Static engine tuning from cordis.yml (restart to change). */
export interface ToolSearchConfig {
  enabled: EnableMode
  thresholdPct: number
  listingMaxTokens: number
  contextWindow: number
  searchDefaultLimit: number
  maxSearchLimit: number
  minCatalogSize: number
  configScope: ConfigScope
  core: string[]
  matcherTimeoutMs: number
}

/** One catalog row: schema fields plus its resolved group (if any). */
export interface CatalogEntry {
  readonly name: string
  readonly description: string
  readonly parameters: ToolSchema['parameters']
  readonly group: string | undefined
}

/** One rerank result projected back onto its catalog entry. */
export interface SearchMatch {
  readonly name: string
  readonly description: string
  readonly group: string | undefined
  readonly score: number
}

/** The full catalog the setup skill reads to propose grouping. */
export interface CatalogView {
  readonly count: number
  readonly groups: readonly { readonly name: string; readonly count: number }[]
  readonly tools: readonly { readonly name: string; readonly description: string; readonly group: string | null }[]
}

/** What the setup skill writes through `tool_slimmer_update_config`. */
export interface UpdateConfigInput {
  readonly scope?: RuntimeScope
  readonly groups?: readonly ToolGroupSpec[]
  readonly matcher?: RerankMatcherConfig
  readonly preload?: PreloadConfig
  readonly core?: readonly string[]
}

/** Result of `tool_slimmer_update_config`. */
export interface UpdateConfigResult {
  readonly path: string
  readonly scope: RuntimeScope
  readonly groups: readonly { readonly name: string; readonly tools: readonly string[] }[]
  readonly matcherConfigured: boolean
  readonly preloadEnabled: boolean
}
