import { afterEach, describe, expect, it, vi } from 'vitest'
import { keywordSearch, rerank, searchCatalog } from '../src/matcher.ts'
import type { CatalogEntry, RerankMatcherConfig } from '../src/types.ts'

const MATCHER: RerankMatcherConfig = { endpoint: 'https://example.test/rerank', apiKey: 'sk-test', model: 'reranker', topN: 5 }

const entries: CatalogEntry[] = [
  { name: 'git_status', description: 'shows git status', parameters: { type: 'object', properties: {} }, group: 'git' },
  { name: 'web_search', description: 'searches the web', parameters: { type: 'object', properties: {} }, group: 'web' },
  { name: 'send_mail', description: 'sends an email', parameters: { type: 'object', properties: {} }, group: undefined },
]

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('rerank', () => {
  it('posts the rerank request and returns sorted hits', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.4 }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const hits = await rerank(MATCHER, 'send an email', ['a', 'b', 'c'], 5000)
    expect(hits).toEqual([{ index: 2, score: 0.9 }, { index: 0, score: 0.4 }])

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(MATCHER.endpoint)
    expect(init.headers).toMatchObject({ authorization: 'Bearer sk-test' })
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toMatchObject({ model: 'reranker', query: 'send an email', documents: ['a', 'b', 'c'], top_n: 5 })
  })

  it('returns empty hits for no documents', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await rerank(MATCHER, 'q', [], 5000)).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'denied' }))
    await expect(rerank(MATCHER, 'q', ['a'], 5000)).rejects.toThrow(/rerank HTTP 401/)
  })

  it('drops hits with missing indexes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ relevance_score: 1 }] }),
    }))
    expect(await rerank(MATCHER, 'q', ['a'], 5000)).toEqual([])
  })
})

describe('searchCatalog', () => {
  it('maps ranked hits back onto catalog entries, capped at limit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ index: 2, relevance_score: 0.95 }, { index: 1, relevance_score: 0.8 }, { index: 0, relevance_score: 0.7 }] }),
    }))
    const matches = await searchCatalog(MATCHER, 'send mail', entries, 2, 5000)
    expect(matches).toHaveLength(2)
    expect(matches[0]).toMatchObject({ name: 'send_mail', group: undefined, score: 0.95 })
    expect(matches[1]).toMatchObject({ name: 'web_search', score: 0.8 })
  })

  it('returns [] for an empty catalog', async () => {
    expect(await searchCatalog(MATCHER, 'q', [], 5, 5000)).toEqual([])
  })
})

describe('keywordSearch', () => {
  it('ranks exact name matches above name substrings and descriptions', () => {
    const matches = keywordSearch('git_status', entries, 10)
    expect(matches[0]?.name).toBe('git_status')
    expect(matches[0]?.score).toBeGreaterThan(100)
  })

  it('matches name tokens and description tokens, capped at limit', () => {
    const matches = keywordSearch('send email', entries, 1)
    expect(matches).toHaveLength(1)
    expect(matches[0]?.name).toBe('send_mail')
  })

  it('returns no matches for unrelated queries', () => {
    expect(keywordSearch('zzz nothing here', entries, 10)).toEqual([])
  })

  it('returns [] for an empty catalog', () => {
    expect(keywordSearch('q', [], 5)).toEqual([])
  })
})
