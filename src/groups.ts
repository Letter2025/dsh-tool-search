import type { CatalogEntry, ToolGroupSpec } from './types.ts'

/** Names that must never be deferred: the bridge and management tools. */
export const FORCED_EAGER = ['tool_search', 'tool_describe', 'tool_call', 'tool_slimmer_catalog', 'tool_slimmer_update_config', 'skill'] as const

/**
 * Resolve the group a tool belongs to: first exact-name match, then first
 * prefix match, in declaration order.
 * @param toolName - the registered tool name.
 * @param groups - the configured groups (may be empty).
 * @returns the owning group name, or `undefined` when ungrouped.
 */
export function groupFor(toolName: string, groups: readonly ToolGroupSpec[]): string | undefined {
  for (const group of groups) {
    if (group.tools?.includes(toolName)) return group.name
    if (group.prefixes?.some(prefix => toolName.startsWith(prefix))) return group.name
  }
  return undefined
}

/**
 * Validate group declarations. Returns a human-readable reason when invalid,
 * or `undefined` when the groups are usable.
 * @param groups - the candidate groups from config or the update tool.
 * @returns an error message, or `undefined` when valid.
 */
export function validateGroups(groups: readonly ToolGroupSpec[]): string | undefined {
  const names = new Set<string>()
  for (const group of groups) {
    if (typeof group.name !== 'string' || group.name.trim() === '') {
      return 'every group needs a non-empty name'
    }
    if (names.has(group.name)) {
      return `duplicate group name "${group.name}"`
    }
    names.add(group.name)
    const tools = group.tools ?? []
    const prefixes = group.prefixes ?? []
    if (tools.length === 0 && prefixes.length === 0) {
      return `group "${group.name}" lists no tools or prefixes`
    }
    for (const tool of tools) {
      if (typeof tool !== 'string' || tool.trim() === '') {
        return `group "${group.name}" contains an empty tool name`
      }
    }
    for (const prefix of prefixes) {
      if (typeof prefix !== 'string' || prefix.trim() === '') {
        return `group "${group.name}" contains an empty prefix`
      }
    }
  }
  return undefined
}

/** Stable key used to name the group a tool belongs to; `null` when ungrouped. */
function groupKey(entry: CatalogEntry): string | null {
  return entry.group ?? null
}

/**
 * Render a grouped manifest of deferred tools for the model. Full mode is
 * "group / name - description"; names mode is "group / name" only.
 * @param entries - the deferred catalog rows (grouped already resolved).
 * @param mode - `full` includes descriptions, `names` lists names only.
 * @returns the manifest text, or an empty string for an empty catalog.
 */
export function buildGroupedManifest(entries: readonly CatalogEntry[], mode: 'full' | 'names'): string {
  const byGroup = new Map<string, CatalogEntry[]>()
  for (const entry of entries) {
    const key = groupKey(entry) ?? 'ungrouped'
    const bucket = byGroup.get(key)
    if (bucket === undefined) byGroup.set(key, [entry])
    else bucket.push(entry)
  }
  const lines: string[] = []
  for (const [group, members] of byGroup) {
    lines.push(`## ${group}`)
    for (const entry of members) {
      lines.push(mode === 'full' ? `- ${entry.name}: ${entry.description}` : `- ${entry.name}`)
    }
  }
  return lines.join('\n')
}

/**
 * Render the tier-3 fallback: one summary line per group plus ungrouped.
 * @param entries - the deferred catalog rows.
 * @returns one line per group ("group name: N tools"), or an empty string.
 */
export function buildGroupSummary(entries: readonly CatalogEntry[]): string {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const key = groupKey(entry) ?? 'ungrouped'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([group, count]) => `- ${group}: ${count} tool${count === 1 ? '' : 's'}`)
    .join('\n')
}
