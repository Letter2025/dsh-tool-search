import { describe, expect, it } from 'vitest'
import { buildGroupSummary, buildGroupedManifest, groupFor, validateGroups } from '../src/groups.ts'
import type { CatalogEntry, ToolGroupSpec } from '../src/types.ts'

const GROUPS: ToolGroupSpec[] = [
  { name: 'git', tools: ['git_status', 'git_diff'] },
  { name: 'mcp-github', prefixes: ['mcp_github_'] },
]

function entry(name: string, description = 'does something'): CatalogEntry {
  return { name, description, parameters: { type: 'object', properties: {} }, group: groupFor(name, GROUPS) }
}

describe('groupFor', () => {
  it('matches exact tool names first', () => {
    expect(groupFor('git_status', GROUPS)).toBe('git')
  })

  it('matches prefixes', () => {
    expect(groupFor('mcp_github_create_issue', GROUPS)).toBe('mcp-github')
  })

  it('returns undefined for ungrouped tools', () => {
    expect(groupFor('random_tool', GROUPS)).toBeUndefined()
  })

  it('exact name wins over a later prefix match', () => {
    const groups: ToolGroupSpec[] = [
      { name: 'prefixed', prefixes: ['git_'] },
      { name: 'exact', tools: ['git_status'] },
    ]
    expect(groupFor('git_status', groups)).toBe('prefixed')
  })
})

describe('validateGroups', () => {
  it('accepts valid groups', () => {
    expect(validateGroups(GROUPS)).toBeUndefined()
  })

  it('rejects a missing name', () => {
    expect(validateGroups([{ name: '' }])).toBe('every group needs a non-empty name')
  })

  it('rejects duplicate names', () => {
    expect(validateGroups([{ name: 'a', tools: ['x'] }, { name: 'a', tools: ['y'] }]))
      .toBe('duplicate group name "a"')
  })

  it('rejects an empty group', () => {
    expect(validateGroups([{ name: 'a' }])).toBe('group "a" lists no tools or prefixes')
  })
})

describe('buildGroupedManifest', () => {
  it('renders grouped name-description lines in full mode', () => {
    const text = buildGroupedManifest([entry('git_status', 'shows status'), entry('mcp_github_issue', 'creates issue'), entry('loose')], 'full')
    expect(text).toContain('## git')
    expect(text).toContain('- git_status: shows status')
    expect(text).toContain('## mcp-github')
    expect(text).toContain('- mcp_github_issue: creates issue')
    expect(text).toContain('## ungrouped')
    expect(text).toContain('- loose: does something')
  })

  it('renders names only in names mode', () => {
    const text = buildGroupedManifest([entry('git_status')], 'names')
    expect(text).toContain('## git')
    expect(text).toContain('- git_status')
    expect(text).not.toContain(':')
  })

  it('renders empty for an empty catalog', () => {
    expect(buildGroupedManifest([], 'full')).toBe('')
  })
})

describe('buildGroupSummary', () => {
  it('renders one line per group with counts', () => {
    const text = buildGroupSummary([entry('git_status'), entry('git_diff'), entry('mcp_github_issue')])
    expect(text).toContain('- git: 2 tools')
    expect(text).toContain('- mcp-github: 1 tool')
  })
})
