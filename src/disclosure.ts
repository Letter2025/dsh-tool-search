import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { CatalogEntry } from './types.ts'
import { buildGroupSummary, buildGroupedManifest } from './groups.ts'
import { estimateTokens } from './catalog.ts'

/** Disclosure tier of the model-visible tool surface (Hermes tiers). */
export type DisclosureTier = 0 | 1 | 2 | 3

export const MANIFEST_SECTION = 'tool-search:catalog'

/** Inputs the tier decision needs; all sizes in tokens except the sizes. */
export interface TierInput {
  /** Total catalog rows (deferred + eager). */
  readonly catalogSize: number
  /** Rows hidden behind the bridge. */
  readonly deferredSize: number
  /** Estimated tokens of the full grouped manifest. */
  readonly manifestTokens: number
  /** Estimated tokens of the names-only grouped manifest. */
  readonly namesOnlyTokens: number
  /** `min(thresholdPct% × contextWindow, listingMaxTokens)`. */
  readonly budget: number
  /** Below this catalog size the bridge never activates under `auto`. */
  readonly minCatalogSize: number
  /** Whether the bridge must activate regardless of catalog size (`on`). */
  readonly forced: boolean
}

/**
 * Decide the disclosure tier. Tier 0 keeps the surface untouched; tiers 1-3
 * replace it with the bridge plus progressively cheaper listings.
 * @param input - the tier inputs.
 * @returns the tier for this assembly.
 */
export function computeTier(input: TierInput): DisclosureTier {
  if (input.deferredSize === 0) return 0
  if (!input.forced && input.catalogSize <= input.minCatalogSize) return 0
  if (input.manifestTokens <= input.budget) return 1
  if (input.namesOnlyTokens <= input.budget) return 2
  return 3
}

/** The listing budget: `min(thresholdPct% × contextWindow, listingMaxTokens)`. */
export function budgetFor(thresholdPct: number, contextWindow: number, listingMaxTokens: number): number {
  return Math.min((thresholdPct / 100) * contextWindow, listingMaxTokens)
}

export interface DisclosureResult {
  readonly tier: DisclosureTier
  readonly tools: ToolSchema[]
  readonly manifest: string
}

/**
 * Compute the slimmed model surface for one assembly: eager schemas plus the
 * three bridge schemas, and the manifest text for the current tier.
 * @param entries - the full catalog snapshot.
 * @param eagerNames - tool names that stay directly visible (core + preload).
 * @param bridgeNames - the bridge tool names (always visible).
 * @param tier - the resolved disclosure tier.
 * @returns the slimmed tools and manifest text (empty for tier 0).
 */
export function computeDisclosure(
  entries: readonly CatalogEntry[],
  eagerNames: ReadonlySet<string>,
  bridgeNames: ReadonlySet<string>,
  tier: DisclosureTier,
): DisclosureResult {
  if (tier === 0) {
    return { tier, tools: entries.map(schemaOf), manifest: '' }
  }
  const seen = new Set<string>()
  const tools: ToolSchema[] = []
  for (const entry of entries) {
    if (eagerNames.has(entry.name) || bridgeNames.has(entry.name)) {
      seen.add(entry.name)
      tools.push(schemaOf(entry))
    }
  }
  for (const name of bridgeNames) {
    if (!seen.has(name)) {
      // The bridge schema is normally part of the catalog; this guard covers
      // an assembly where the registry was observed mid-registration.
      tools.push({ name, description: bridgeFallbackDescription(name), parameters: { type: 'object', properties: {} } })
    }
  }
  const deferred = entries.filter(entry => !eagerNames.has(entry.name) && !bridgeNames.has(entry.name))
  let manifest = ''
  if (deferred.length > 0) {
    if (tier === 1) manifest = buildGroupedManifest(deferred, 'full')
    else if (tier === 2) manifest = buildGroupedManifest(deferred, 'names')
    else manifest = buildGroupSummary(deferred)
  }
  return { tier, tools, manifest }
}

function bridgeFallbackDescription(name: string): string {
  switch (name) {
    case 'tool_search': return 'Search the deferred tool catalog semantically and return ranked matches.'
    case 'tool_describe': return 'Load the full schema of one deferred tool.'
    case 'tool_call': return 'Invoke a deferred tool by name with its arguments.'
    default: return 'Tool search bridge.'
  }
}

/**
 * Apply the slimmed surface to an assembly: replace `assembly.tools` and, for
 * tiers 1-3, append the manifest as a prompt section. Pure and idempotent —
 * the catalog comes from the registry, never from the incoming assembly.
 * @param assembly - the settled assembly from the waterfall chain.
 * @param disclosure - the computed slimmed surface.
 * @returns the transformed assembly.
 */
export function applyDisclosure(assembly: PromptAssembly, disclosure: DisclosureResult): PromptAssembly {
  if (disclosure.tier === 0) return assembly
  const sections = [...assembly.sections]
  if (disclosure.manifest !== '') {
    sections.push({ name: MANIFEST_SECTION, text: disclosure.manifest })
  }
  return { ...assembly, tools: disclosure.tools, sections }
}

function schemaOf(entry: CatalogEntry): ToolSchema {
  return { name: entry.name, description: entry.description, parameters: entry.parameters }
}

/** Token estimate helpers reused by the engine's tier decision. */
export { estimateTokens }
