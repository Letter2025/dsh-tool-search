import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RUNTIME_FILE, RuntimeConfigStore, parseRuntimeFile, projectConfigPath, resolveDshHome, userConfigPath } from '../src/config.ts'
import type { RuntimeFileConfig } from '../src/types.ts'

const realDshHome = process.env.DSH_HOME
let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-tool-search-config-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  if (realDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = realDshHome
  await rm(home, { recursive: true, force: true })
})

function store(): RuntimeConfigStore {
  return new RuntimeConfigStore(() => {})
}

describe('resolveDshHome', () => {
  it('prefers $DSH_HOME', () => {
    expect(resolveDshHome()).toBe(home)
  })

  it('falls back to ~/.dsh when unset', () => {
    delete process.env.DSH_HOME
    expect(resolveDshHome()).toBe(join(process.env.USERPROFILE ?? '', '.dsh'))
  })
})

describe('parseRuntimeFile', () => {
  it('parses a full valid config', () => {
    const config = parseRuntimeFile(JSON.stringify({
      version: 1,
      scope: 'user',
      groups: [{ name: 'git', tools: ['git_status'] }, { name: 'mcp', prefixes: ['mcp_'] }],
      matcher: { endpoint: 'https://x/rerank', apiKey: 'sk-1', model: 'qwen3-reranker', topN: 10 },
      preload: { enabled: true, topK: 3 },
      core: ['read_file'],
    }), 'path')
    expect(config.groups).toHaveLength(2)
    expect(config.matcher?.model).toBe('qwen3-reranker')
    expect(config.preload?.topK).toBe(3)
  })

  it('accepts a minimal config', () => {
    expect(parseRuntimeFile('{}', 'path')).toEqual({})
  })

  it('rejects invalid JSON', () => {
    expect(() => parseRuntimeFile('{oops', 'path')).toThrow(/not valid JSON/)
  })

  it('rejects a duplicate group name', () => {
    expect(() => parseRuntimeFile(JSON.stringify({ groups: [{ name: 'a', tools: ['x'] }, { name: 'a', tools: ['y'] }] }), 'p'))
      .toThrow(/duplicate group name "a"/)
  })

  it('rejects a matcher missing apiKey', () => {
    expect(() => parseRuntimeFile(JSON.stringify({ matcher: { endpoint: 'e', model: 'm' } }), 'p'))
      .toThrow(/matcher "apiKey" must be a non-empty string/)
  })
})

describe('RuntimeConfigStore', () => {
  it('resolves the user config when no project file exists', async () => {
    const resolved = await store().resolve('auto', join(home, 'proj'))
    expect(resolved.scope).toBe('user')
    expect(resolved.path).toBe(userConfigPath())
  })

  it('prefers the project file under auto', async () => {
    const proj = join(home, 'proj')
    await mkdir(join(proj, '.dsh'), { recursive: true })
    await writeFile(join(proj, '.dsh', RUNTIME_FILE), JSON.stringify({ groups: [{ name: 'p', tools: ['x'] }] }))
    const resolved = await store().resolve('auto', proj)
    expect(resolved.scope).toBe('project')
    expect(resolved.path).toBe(projectConfigPath(proj))
    expect(resolved.config.groups).toHaveLength(1)
  })

  it('uses only the user file under user scope', async () => {
    const proj = join(home, 'proj')
    await mkdir(join(proj, '.dsh'), { recursive: true })
    await writeFile(join(proj, '.dsh', RUNTIME_FILE), JSON.stringify({ groups: [{ name: 'p', tools: ['x'] }] }))
    const resolved = await store().resolve('user', proj)
    expect(resolved.scope).toBe('user')
  })

  it('writes a project config and reloads it', async () => {
    const proj = join(home, 'proj')
    const s = store()
    const data: RuntimeFileConfig = { groups: [{ name: 'git', tools: ['git_status'] }] }
    const path = await s.write('project', proj, data)
    expect(path).toBe(projectConfigPath(proj))
    const resolved = await s.resolve('project', proj)
    expect(resolved.scope).toBe('project')
    expect(resolved.config.groups?.[0]?.name).toBe('git')
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as RuntimeFileConfig
    expect(onDisk.version).toBe(1)
    expect(onDisk.scope).toBe('project')
  })

  it('treats a malformed file as absent with a warning', async () => {
    await writeFile(userConfigPath(), '{broken')
    const warns: string[] = []
    const s = new RuntimeConfigStore(message => warns.push(message))
    const resolved = await s.resolve('user', undefined)
    expect(resolved.config).toEqual({})
    expect(warns.some(message => message.includes('ignoring unreadable runtime config'))).toBe(true)
  })

  it('caches reads and invalidates on write', async () => {
    const s = store()
    expect((await s.resolve('user', undefined)).config).toEqual({})
    await s.write('user', undefined, { core: ['a'] })
    expect((await s.resolve('user', undefined)).config.core).toEqual(['a'])
  })
})
