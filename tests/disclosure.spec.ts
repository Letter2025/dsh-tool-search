import { describe, expect, it } from 'vitest'
import { applyDisclosure, budgetFor, computeDisclosure, computeTier, MANIFEST_CONTEXT } from '../src/disclosure.ts'
import type { CatalogEntry } from '../src/types.ts'

function entry(name: string, description: string): CatalogEntry {
  return { name, description, parameters: { type: 'object', properties: {} }, group: undefined }
}

function tierInput(overrides: Partial<Parameters<typeof computeTier>[0]> = {}) {
  return {
    catalogSize: 20,
    deferredSize: 17,
    manifestTokens: 300,
    namesOnlyTokens: 60,
    budget: 200,
    minCatalogSize: 5,
    forced: false,
    ...overrides,
  }
}

describe('budgetFor', () => {
  it('caps the listing at listingMaxTokens', () => {
    expect(budgetFor(50, 128000, 4000)).toBe(4000)
  })

  it('uses the percentage when smaller', () => {
    expect(budgetFor(1, 128000, 4000)).toBe(1280)
  })
})

describe('computeTier', () => {
  it('returns 0 when nothing is deferred', () => {
    expect(computeTier(tierInput({ deferredSize: 0 }))).toBe(0)
  })

  it('returns 0 under auto when the catalog is small', () => {
    expect(computeTier(tierInput({ catalogSize: 4, deferredSize: 2 }))).toBe(0)
  })

  it('ignores the catalog gate when forced', () => {
    expect(computeTier(tierInput({ catalogSize: 4, deferredSize: 2, forced: true, manifestTokens: 100 }))).toBe(1)
  })

  it('returns 1 when the full manifest fits', () => {
    expect(computeTier(tierInput({ manifestTokens: 200 }))).toBe(1)
  })

  it('returns 2 when only names fit', () => {
    expect(computeTier(tierInput({ manifestTokens: 300, namesOnlyTokens: 200 }))).toBe(2)
  })

  it('returns 3 when names also overflow', () => {
    expect(computeTier(tierInput({ manifestTokens: 300, namesOnlyTokens: 250, budget: 100 }))).toBe(3)
  })
})

describe('computeDisclosure', () => {
  const entries = [
    entry('core_tool', 'core'),
    entry('tail_one', 'first tail tool'),
    entry('tail_two', 'second tail tool'),
  ]
  const eager = new Set<string>(['core_tool'])
  const bridges = new Set<string>(['tool_search', 'tool_describe', 'tool_call'])

  it('returns every schema unchanged at tier 0', () => {
    const result = computeDisclosure(entries, eager, bridges, 0)
    expect(result.tools.map(tool => tool.name)).toEqual(['core_tool', 'tail_one', 'tail_two'])
    expect(result.manifest).toBe('')
  })

  it('keeps eager tools and bridges at tier 1 with a full manifest', () => {
    const result = computeDisclosure(entries, eager, bridges, 1)
    expect(result.tools.map(tool => tool.name)).toEqual(['core_tool', 'tool_search', 'tool_describe', 'tool_call'])
    expect(result.manifest).toContain('tail_one: first tail tool')
  })

  it('includes missing bridges with fallback descriptions', () => {
    const result = computeDisclosure([entry('core_tool', 'core')], eager, bridges, 1)
    const names = result.tools.map(tool => tool.name)
    expect(names).toEqual(['core_tool', 'tool_search', 'tool_describe', 'tool_call'])
    expect(result.tools.find(tool => tool.name === 'tool_search')?.description).toContain('Search')
  })
})

describe('applyDisclosure', () => {
  const assembly = { sections: [], contexts: [], tools: [], variables: {} }

  it('leaves the assembly untouched at tier 0', () => {
    expect(applyDisclosure(assembly, { tier: 0, tools: [], manifest: '' })).toBe(assembly)
  })

  it('replaces tools and appends the manifest as a runtime context', () => {
    const out = applyDisclosure(assembly, {
      tier: 1,
      tools: [{ name: 'tool_search', description: 'd', parameters: { type: 'object', properties: {} } }],
      manifest: '## git\n- git_status',
    })
    expect(out.tools.map(tool => tool.name)).toEqual(['tool_search'])
    expect(out.contexts).toEqual([{ name: MANIFEST_CONTEXT, text: '## git\n- git_status' }])
  })
})
