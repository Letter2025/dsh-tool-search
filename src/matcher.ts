import type { CatalogEntry, RerankMatcherConfig, SearchMatch } from './types.ts'

/** One scored hit from a rerank response. */
export interface RerankHit {
  readonly index: number
  readonly score: number
}

/** OpenAPI-compatible `/v1/rerank` response projection. */
export interface RerankResponse {
  readonly results?: ReadonlyArray<{ readonly index?: number; readonly relevance_score?: number }>
}

/**
 * Call an OpenAI-compatible rerank endpoint (e.g. DashScope compatible-mode
 * `qwen3-reranker`). The endpoint receives `{ model, query, documents, top_n }`
 * and returns `{ results: [{ index, relevance_score }] }`.
 * @param matcher - endpoint/apiKey/model and optional topN.
 * @param query - the search query.
 * @param documents - one text per candidate (name + description + group).
 * @param timeoutMs - abort deadline for the request.
 * @returns hits sorted by relevance score, highest first.
 */
export async function rerank(
  matcher: RerankMatcherConfig,
  query: string,
  documents: readonly string[],
  timeoutMs: number,
): Promise<RerankHit[]> {
  if (documents.length === 0) return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(matcher.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${matcher.apiKey}`,
      },
      body: JSON.stringify({
        model: matcher.model,
        query,
        documents,
        ...matcher.topN !== undefined ? { top_n: matcher.topN } : {},
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`rerank HTTP ${response.status}: ${detail.slice(0, 300)}`)
    }
    const data = (await response.json()) as RerankResponse
    const hits = (data.results ?? [])
      .filter((result): result is { index: number; relevance_score?: number } => typeof result.index === 'number')
      .map(result => ({ index: result.index, score: result.relevance_score ?? 0 }))
      .sort((a, b) => b.score - a.score)
    return hits
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Semantically search the catalog through the configured rerank matcher.
 * @param matcher - the rerank configuration.
 * @param query - the model's search query.
 * @param entries - the deferred catalog rows.
 * @param limit - how many matches to return.
 * @param timeoutMs - rerank request deadline.
 * @returns matches sorted by relevance, capped at `limit`.
 */
export async function searchCatalog(
  matcher: RerankMatcherConfig,
  query: string,
  entries: readonly CatalogEntry[],
  limit: number,
  timeoutMs: number,
): Promise<SearchMatch[]> {
  if (entries.length === 0) return []
  const documents = entries.map(entry => `${entry.group !== undefined ? `[${entry.group}] ` : ''}${entry.name}: ${entry.description}`)
  const hits = await rerank(matcher, query, documents, timeoutMs)
  const matches: SearchMatch[] = []
  for (const hit of hits) {
    if (matches.length >= limit) break
    const entry = entries[hit.index]
    if (entry === undefined) continue
    matches.push({ name: entry.name, description: entry.description, group: entry.group, score: hit.score })
  }
  return matches
}

/**
 * Keyword fallback search over the catalog: exact-name matches rank highest,
 * then name substring hits, then description hits, scored per query token.
 * Deterministic and dependency-free; used when no rerank matcher is
 * configured or the rerank call fails, so `tool_search` never dead-ends.
 * @param query - the model's search query.
 * @param entries - the deferred catalog rows.
 * @param limit - how many matches to return.
 * @returns matches with a keyword score, sorted descending, capped at `limit`.
 */
export function keywordSearch(query: string, entries: readonly CatalogEntry[], limit: number): SearchMatch[] {
  if (entries.length === 0) return []
  const normalized = query.trim().toLowerCase()
  const tokens = normalized.split(/[^a-z0-9_]+/i).filter(token => token.length > 0)
  const scored: Array<{ entry: CatalogEntry; score: number }> = []
  for (const entry of entries) {
    const name = entry.name.toLowerCase()
    const description = entry.description.toLowerCase()
    let score = 0
    if (name === normalized) score += 100
    for (const token of tokens) {
      if (name.includes(token)) score += 10
      if (description.includes(token)) score += 1
    }
    if (score > 0) scored.push({ entry, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(({ entry, score }) => ({
    name: entry.name,
    description: entry.description,
    group: entry.group,
    score,
  }))
}
