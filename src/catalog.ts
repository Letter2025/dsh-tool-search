import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { CatalogEntry, CatalogView, ToolGroupSpec } from './types.ts'
import { groupFor } from './groups.ts'

/**
 * Estimate the token cost of manifest text. Conservative upper bound: CJK
 * characters at 1.5 chars/token, everything else at 4 chars/token (the same
 * rule of thumb as the cx-ai TokenEstimationMiddleware).
 * @param text - the manifest text to budget.
 * @returns an estimated token count.
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (/[\u3000-\u9fff\uf900-\ufaff]/.test(char)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk / 1.5 + other / 4)
}

/**
 * Snapshot the model-visible tool catalog as group-annotated rows.
 * @param schemas - the registry's visible schemas (`ctx.tools.schemas(scope)`).
 * @param groups - the configured groups used to annotate each tool.
 * @returns catalog rows in schema order.
 */
export function snapshotCatalog(schemas: readonly ToolSchema[], groups: readonly ToolGroupSpec[]): CatalogEntry[] {
  return schemas.map(schema => ({
    name: schema.name,
    description: schema.description ?? '',
    parameters: schema.parameters,
    group: groupFor(schema.name, groups),
  }))
}

/**
 * Resolve the full schema for one catalog tool.
 * @param entries - the catalog snapshot.
 * @param name - the tool name to look up.
 * @returns the model-facing schema fields, or `undefined` when unknown.
 */
export function describeTool(entries: readonly CatalogEntry[], name: string): { name: string; description: string; parameters: ToolSchema['parameters'] } | undefined {
  const entry = entries.find(candidate => candidate.name === name)
  if (entry === undefined) return undefined
  return { name: entry.name, description: entry.description, parameters: entry.parameters }
}

/**
 * Build the setup-facing catalog view: per-group counts plus every tool row,
 * annotated with whether each tool is currently deferred (folded behind the
 * bridge) so the setup skill and the model can tell registry from visibility.
 * @param entries - the catalog snapshot.
 * @param deferredNames - tool names currently folded; omitted marks none.
 * @returns the grouped view the setup skill reads.
 */
export function buildCatalogView(entries: readonly CatalogEntry[], deferredNames?: ReadonlySet<string>): CatalogView {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const key = entry.group ?? 'ungrouped'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return {
    count: entries.length,
    groups: [...counts.entries()].map(([name, count]) => ({ name, count })),
    tools: entries.map(entry => ({
      name: entry.name,
      description: entry.description,
      group: entry.group ?? null,
      deferred: deferredNames?.has(entry.name) ?? false,
    })),
  }
}
