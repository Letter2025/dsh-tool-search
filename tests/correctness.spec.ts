import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../src/index.ts'
import { keywordSearch, rerank } from '../src/matcher.ts'
import { RUNTIME_FILE, ToolSearchConfigSchema } from '../src/config.ts'
import { MANIFEST_CONTEXT } from '../src/disclosure.ts'
import type { ToolSearchConfig } from '../src/types.ts'
const previousHome = process.env.DSH_HOME
let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'tool-search-correctness-')); process.env.DSH_HOME = home })
afterEach(async () => { vi.unstubAllGlobals(); if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; await rm(home, { recursive: true, force: true }) })
async function fixture(maxWarmTools = 2, overrides: Partial<ToolSearchConfig> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(SkillRegistry)
  const config: ToolSearchConfig = { enabled: 'on', thresholdPct: 50, listingMaxTokens: 10000, contextWindow: 128000, searchDefaultLimit: 5, maxSearchLimit: 20, minCatalogSize: 0, configScope: 'user', core: [], matcherTimeoutMs: 100, maxWarmTools, ...overrides }
  const engine = apply(ctx, config)
  for (const name of ['visible', 'hidden', 'third']) ctx.tools.register(defineTool({ name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: name }] }, async execute() { return name } }))
  const agent = { session: { id: 'isolated', header: { cwd: home } } } as unknown as Agent
  const input = () => ({ sections: [], contexts: [], variables: {}, tools: ctx.tools.schemas(agent) })
  const call = (name: string, args: Record<string, unknown> = {}) => ctx.tools.execute({ callId: ToolCallId(name), name, arguments: args, signal: new AbortController().signal, agent })
  return { ctx, engine, agent, input, call }
}
describe('approved correctness regressions', () => {
  it('does not search or dispatch registry tools before a snapshot', async () => {
    const { engine, agent, call } = await fixture()
    expect((await engine.search('visible', 5, agent)).matches).toEqual([])
    expect((await call('tool_call', { name: 'visible' })).isError).toBe(true)
  })
  it('does not restore or expose tools removed upstream', async () => {
    const { engine, agent, input, call } = await fixture()
    const source = input(); source.tools = source.tools.filter(t => t.name !== 'hidden')
    const slim = await engine.assemble(source, agent)
    expect(slim.tools.some(t => t.name === 'hidden')).toBe(false)
    expect((await engine.search('hidden', 5, agent)).matches).toEqual([])
    expect(engine.describe('hidden', agent)).toBeUndefined()
    expect((await call('tool_call', { name: 'hidden' })).isError).toBe(true)
  })
  it('preserves images, metadata, contexts and terminal success without Base64 text', async () => {
    const { ctx, engine, agent, input, call } = await fixture()
    ctx.tools.register(defineTool({ name: 'picture', description: 'picture', parameters: {}, output: { schema: { type: 'string' }, render: () => [{ type: 'image', attachment: { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: 5, width: 1, height: 1 } }], presentationMeta: () => ({ kind: 'fixture' }) }, async execute(_a, exec) { exec.deferContext(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'extra' }] })); exec.concludeTurn(); return 'image value' } }))
    await engine.assemble(input(), agent)
    const result = await call('tool_call', { name: 'picture' })
    expect(result.isError).toBe(false)
    expect(result.content[0]?.type).toBe('image')
    expect(result.content.some(b => b.type === 'text' && b.text.includes('aGVsbG8='))).toBe(false)
    expect(result.meta).toEqual({ kind: 'fixture' })
    expect(result.additionalContexts).toHaveLength(1)
    expect(result.concludesTurn).toBe(true)
    expect(JSON.parse(result.value as string)).toMatchObject({ ok: true, value: 'image value' })
  })
  it('propagates final structured failure and omits successful value', async () => {
    const { ctx, engine, agent, input, call } = await fixture()
    ctx.tools.guard(exec => exec.name === 'visible' ? 'fixture denial' : undefined)
    await engine.assemble(input(), agent)
    const result = await call('tool_call', { name: 'visible' })
    expect(result.isError).toBe(true); expect(result.value).toBeUndefined(); expect(result.error?.message).toContain('fixture denial')
  })
  it('keeps highest ranking warm names, supports zero, and observes native success', async () => {
    const { engine, agent, input, call } = await fixture()
    await engine.assemble(input(), agent)
    engine.warmTools(agent, ['visible', 'hidden', 'third'])
    expect(engine.warmNamesFor(agent)).toEqual(['hidden', 'visible'])
    await call('third'); expect(engine.warmNamesFor(agent)).toContain('third')
    const zero = await fixture(0); await zero.engine.assemble(zero.input(), zero.agent); zero.engine.warmTools(zero.agent, ['visible']); expect(zero.engine.warmNamesFor(zero.agent)).toEqual([])
  })
  it('keeps manifest stable for 30 offline rounds and replaces its context', async () => {
    const { engine, agent, input } = await fixture()
    const source = input(); let first = ''; const manifests: string[] = []
    for (let i = 0; i < 30; i++) {
      engine.warmTools(agent, [i % 2 ? 'visible' : 'hidden'])
      const result = await engine.assemble({ ...source, contexts: first ? [{ name: MANIFEST_CONTEXT, text: first }] : [] }, agent)
      const contexts = result.contexts.filter(c => c.name === MANIFEST_CONTEXT)
      expect(contexts).toHaveLength(1); first = contexts[0]!.text; manifests.push(first)
    }
    expect(new Set(manifests).size).toBe(1)
  })
  it('searches Unicode, group text and small bilingual synonyms', () => {
    const entries = [{ name: 'capture', description: 'take screenshot', group: '浏览器', parameters: {} }, { name: 'repository', description: 'repository issue', group: undefined, parameters: {} }]
    expect(keywordSearch('截图', entries, 5)[0]?.name).toBe('capture')
    expect(keywordSearch('浏览器', entries, 5)[0]?.name).toBe('capture')
    expect(keywordSearch('仓库问题', entries, 5)[0]?.name).toBe('repository')
  })
  it.each([null, {}, { results: {} }])('rejects malformed rerank root %j', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }))
    await expect(rerank({ endpoint: 'https://example.test/rerank', apiKey: 'fixture', model: 'fixture' }, 'x', ['x'], 100)).rejects.toThrow()
  })
})

describe('result and authority boundary regressions', () => {
  it('keeps concurrent success and failures tied to execution tokens', async () => {
    const { ctx, engine, agent, input, call } = await fixture()
    ctx.tools.register(defineTool({ name: 'concurrent', description: 'fixture', parameters: { n: { type: 'integer', required: true } }, output: { schema: { type: 'integer' }, render: (_a, value) => [{ type: 'text', text: `value:${value}` }], presentationMeta: (_a, value) => ({ n: value }) }, async execute(args) { const n = (args as { n: number }).n; await new Promise(resolve => setTimeout(resolve, (12 - n) % 3)); if (n % 2) throw new Error(`failure:${n}`); return n } }))
    await engine.assemble(input(), agent)
    const outcomes = await Promise.all(Array.from({ length: 12 }, (_, n) => call('tool_call', { name: 'concurrent', arguments: { n } })))
    for (const [n, result] of outcomes.entries()) {
      expect(result.isError).toBe(Boolean(n % 2))
      if (result.isError) { expect(result.value).toBeUndefined(); expect(result.error.message).toBe(`failure:${n}`) }
      else { expect(JSON.parse(result.value as string).value).toBe(n); expect(result.meta).toEqual({ n }); expect(result.content).toEqual([{ type: 'text', text: `value:${n}` }]) }
    }
  })
  it('keeps large encoded values out of rendered text and uses null for absent metadata', async () => {
    const { ctx, engine, agent, input, call } = await fixture()
    const encoded = 'aGVsbG8='.repeat(10000)
    ctx.tools.register(defineTool({ name: 'encoded', description: 'fixture', parameters: {}, output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'image saved' }] }, async execute() { return encoded } }))
    await engine.assemble(input(), agent)
    const result = await call('tool_call', { name: 'encoded' })
    expect(result.isError).toBe(false); expect(JSON.parse(result.value as string).value).toBe(encoded)
    expect(result.content).toEqual([{ type: 'text', text: 'image saved' }]); expect(result.meta).toBeNull()
  })
  it('respects outer post-execute content replacement and denial', async () => {
    const { ctx, engine, agent, input, call } = await fixture()
    await engine.assemble(input(), agent)
    const replace = ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'tool_call' ? { kind: 'accept', content: [{ type: 'text', text: 'outer replacement' }] } : next())
    expect((await call('tool_call', { name: 'visible' })).content).toEqual([{ type: 'text', text: 'outer replacement' }])
    replace()
    ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'tool_call' ? { kind: 'block', feedback: [{ type: 'text', text: 'outer denial' }] } : next())
    const denied = await call('tool_call', { name: 'visible' })
    expect(denied.isError).toBe(true); expect(denied.value).toBeUndefined(); expect(denied.content).toEqual([{ type: 'text', text: 'outer denial' }])
  })
  it('preserves an already-failed outer execution instead of cached nested failure', async () => {
    const { ctx, engine, agent, input, call } = await fixture()
    ctx.tools.guard(exec => exec.name === 'visible' ? 'nested failure' : undefined)
    ctx.on('tools/execute', async (exec, next) => { const result = await next(); return exec.name === 'tool_call' ? { isError: true, error: { message: 'outer timeout' }, content: [{ type: 'text', text: 'outer timeout' }] } : result })
    await engine.assemble(input(), agent)
    const result = await call('tool_call', { name: 'visible' })
    expect(result.isError).toBe(true); expect(result.error?.message).toBe('outer timeout')
  })
  it('propagates cancellation through the caller signal', async () => {
    const { ctx, engine, agent, input } = await fixture()
    const controller = new AbortController()
    ctx.tools.register(defineTool({ name: 'cancelled', description: 'fixture', parameters: {}, output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'done' }] }, async execute(_args, exec) { expect(exec.signal).toBe(controller.signal); controller.abort(); return 'done' } }))
    await engine.assemble(input(), agent)
    const result = await ctx.tools.execute({ callId: ToolCallId('cancel'), name: 'tool_call', arguments: { name: 'cancelled' }, signal: controller.signal, agent })
    expect(result.isError).toBe(true); expect(result.value).toBeUndefined(); expect(result.concludesTurn).toBeUndefined()
  })
  it('forwards failed contexts and metadata exactly once without a terminal marker', async () => {
    const { ctx, engine, agent, input, call } = await fixture()
    const context = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'failure context' }] })
    ctx.on('tools/execute', async (exec, next) => exec.name === 'visible' ? { isError: true, error: { message: 'structured failure', info: { name: 'FixtureError', code: 'FIXTURE_FAILURE' } }, content: [{ type: 'text', text: 'original failure' }], meta: { fixture: true }, additionalContexts: [context] } : next())
    await engine.assemble(input(), agent)
    const result = await call('tool_call', { name: 'visible' })
    expect(result.isError).toBe(true); expect(result.error).toEqual({ message: 'structured failure', info: { name: 'FixtureError', code: 'FIXTURE_FAILURE' } })
    expect(result.content).toEqual([{ type: 'text', text: 'original failure' }]); expect(result.meta).toEqual({ fixture: true })
    expect(result.additionalContexts).toEqual([context]); expect(result.concludesTurn).toBeUndefined()
  })
  it('isolates two Agents sharing a session and follows registry removals', async () => {
    const { ctx, engine, agent, input } = await fixture()
    const other = { session: agent.session } as Agent
    const allowed = input(); allowed.tools = allowed.tools.filter(tool => tool.name !== 'hidden')
    await engine.assemble(allowed, agent); await engine.assemble(input(), other)
    engine.warmTools(other, ['hidden'])
    expect(engine.canCall('hidden', agent)).toBe(false); expect(engine.canCall('hidden', other)).toBe(true)
    expect(engine.warmNamesFor(agent)).not.toContain('hidden')
    const dispose = ctx.tools.register(defineTool({ name: 'transient', description: 'fixture', parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, async execute() { return 'ok' } }))
    await engine.assemble(input(), agent); expect(engine.canCall('transient', agent)).toBe(true); dispose()
    expect(engine.canCall('transient', agent)).toBe(false); expect(engine.describe('transient', agent)).toBeUndefined()
    expect((await engine.search('transient', 5, agent)).matches).toEqual([])
  })
  it('does not infer an Agent snapshot from a global assembly', async () => {
    const { ctx, engine, agent, input } = await fixture()
    await ctx.systemPrompt.assemble()
    expect(engine.canCall('visible', undefined)).toBe(true); expect(engine.canCall('visible', agent)).toBe(false)
    await engine.assemble(input(), agent)
    expect(engine.canCall('visible', agent)).toBe(true)
  })
  it('keeps strict PTC untouched and disables every generic bridge discovery route', async () => {
    const { engine, agent, input, call } = await fixture()
    const source = { ...input(), sections: [{ name: 'tools:ptc-only', text: 'only run_code' }, { name: 'tools:sdk', text: 'fixture SDK' }], tools: [{ name: 'run_code', description: 'transport', parameters: {} }] }
    expect(await engine.assemble(source, agent)).toBe(source)
    expect(engine.canCall('visible', agent)).toBe(false); expect(engine.describe('visible', agent)).toBeUndefined()
    expect(await engine.search('visible', 5, agent)).toMatchObject({ matches: [], hint: expect.stringContaining('strict PTC') })
    expect((await call('tool_call', { name: 'visible' })).isError).toBe(true)
    expect(JSON.parse((await call('tool_describe', { name: 'visible' })).value as string).error).toContain('strict PTC')
  })
  it('retains both-mode transport and SDK section while slimming native tools', async () => {
    const { engine, agent, input } = await fixture()
    const source = { ...input(), sections: [{ name: 'tools:ptc-only', text: '' }, { name: 'tools:sdk', text: 'fixture SDK unchanged' }] }
    source.tools.push({ name: 'run_code', description: 'transport', parameters: {} })
    const result = await engine.assemble(source, agent)
    expect(result.tools.some(tool => tool.name === 'run_code')).toBe(true); expect(result.sections).toEqual(source.sections)
    expect(result.tools.some(tool => tool.name === 'visible')).toBe(false)
  })
  it('records authority when disabled without transforming the assembly', async () => {
    const { engine, agent, input, call } = await fixture(2, { enabled: 'off' })
    const source = input(); expect(await engine.assemble(source, agent)).toBe(source)
    expect((await call('tool_call', { name: 'visible' })).isError).toBe(false)
  })
  it('excludes configured static/runtime core from warm capacity and refreshes native LRU', async () => {
    const { ctx, engine, agent, input, call } = await fixture(2, { core: ['visible'] })
    await writeFile(join(home, RUNTIME_FILE), JSON.stringify({ core: ['hidden'] }))
    await engine.assemble(input(), agent)
    await call('visible'); await call('hidden'); engine.warmTools(agent, ['visible', 'hidden', 'third', 'third'])
    expect(engine.warmNamesFor(agent)).toEqual(['third'])
    await rm(join(home, RUNTIME_FILE))
    const second = await fixture(2); await second.engine.assemble(second.input(), second.agent)
    second.engine.warmTools(second.agent, ['visible', 'hidden']); await second.call('hidden'); await second.call('third')
    expect(second.engine.warmNamesFor(second.agent)).toEqual(['hidden', 'third'])
    ctx.tools.guard(exec => exec.name === 'third' ? 'fixture failure' : undefined)
    expect((await call('third')).isError).toBe(true); expect(engine.warmNamesFor(agent)).toEqual(['third'])
  })
  it('uses the nine default core names but honors an explicit static override', () => {
    expect(ToolSearchConfigSchema().core).toEqual(['read', 'write', 'edit', 'bash', 'glob', 'grep', 'ask_user_question', 'todo_write', 'read_image'])
    expect(ToolSearchConfigSchema({ ...ToolSearchConfigSchema(), core: ['custom'] }).core).toEqual(['custom'])
  })
  it('falls back on malformed rerank responses at the engine boundary', async () => {
    const { engine, agent, input } = await fixture()
    await writeFile(join(home, RUNTIME_FILE), JSON.stringify({ matcher: { endpoint: 'https://example.test/rerank', apiKey: 'fixture', model: 'fixture' } }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ unexpected: [] }) }))
    await engine.assemble(input(), agent)
    expect(await engine.search('visible', 5, agent)).toMatchObject({ mode: 'keyword', matches: [{ name: 'visible' }], hint: expect.stringContaining('malformed rerank') })
  })
  it('uses Chinese word segmentation beyond the small synonym dictionary', () => {
    const entries = [{ name: 'weather', description: '天气 查询', group: undefined, parameters: {} }]
    expect(keywordSearch('查询天气', entries, 5)[0]?.name).toBe('weather')
  })
})

describe('live scope and preload regressions', () => {
  it('honors actual scoped restrictions added after discovery', async () => {
    const { ctx, engine, agent, input, call } = await fixture()
    await engine.assemble(input(), agent)
    engine.warmTools(agent, ['hidden'])
    const scope = createScope(ctx, agent)
    let restriction = () => {}
    await scope.ctx.plugin({ inject: ['tools'], apply(scoped: Context) { restriction = scoped.tools.restrict({ deny: ['hidden'] }) } })
    expect(engine.canCall('hidden', agent)).toBe(false); expect(engine.warmNamesFor(agent)).not.toContain('hidden')
    expect(engine.describe('hidden', agent)).toBeUndefined(); expect((await call('tool_call', { name: 'hidden' })).isError).toBe(true)
    expect((await engine.search('hidden', 5, agent)).matches).toEqual([])
    restriction(); expect(engine.canCall('hidden', agent)).toBe(true)
    await scope.dispose()
  })
  it('keeps the waterfall-filtered source authoritative for all discovery routes', async () => {
    const { ctx, engine, agent, call } = await fixture()
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const settled = await next(); return { ...settled, tools: settled.tools.filter(tool => !['hidden', 'tool_describe'].includes(tool.name)) }
    })
    const assembled = await ctx.systemPrompt.assemble({ scope: agent })
    expect(assembled.tools.some(tool => tool.name === 'tool_describe')).toBe(false)
    expect(assembled.contexts.find(context => context.name === MANIFEST_CONTEXT)?.text).not.toContain('hidden')
    expect(engine.describe('hidden', agent)).toBeUndefined(); expect((await call('tool_call', { name: 'hidden' })).isError).toBe(true)
    expect((await engine.search('hidden', 5, agent)).matches).toEqual([])
  })
  it.each([0, 2])('bounds preloaded visibility by maxWarmTools=%i', async capacity => {
    const { engine, agent, input } = await fixture(capacity)
    Object.assign(agent.session, { deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'fixture query' }] }] })
    await writeFile(join(home, RUNTIME_FILE), JSON.stringify({ matcher: { endpoint: 'https://example.test/rerank', apiKey: 'fixture', model: 'fixture' }, preload: { enabled: true, topK: 3 } }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [{ index: 0, relevance_score: 1 }, { index: 1, relevance_score: .8 }, { index: 2, relevance_score: .5 }] }) }))
    const result = await engine.assemble(input(), agent)
    expect(engine.warmNamesFor(agent)).toHaveLength(capacity)
    expect(result.tools.filter(tool => ['visible', 'hidden', 'third'].includes(tool.name))).toHaveLength(capacity)
    if (capacity === 2) expect(engine.warmNamesFor(agent)).toEqual(['hidden', 'visible'])
  })
  it('clears newly configured core out of old warm slots on the next assembly', async () => {
    const { engine, agent, input, call } = await fixture()
    await engine.assemble(input(), agent); engine.warmTools(agent, ['visible', 'hidden'])
    await writeFile(join(home, RUNTIME_FILE), JSON.stringify({ core: ['visible'] }))
    await engine.assemble(input(), agent); await call('third')
    expect(engine.warmNamesFor(agent)).toEqual(['hidden', 'third'])
  })
  it('does not refresh failed native calls in the LRU cache', async () => {
    const { ctx, engine, agent, input, call } = await fixture()
    await engine.assemble(input(), agent); engine.warmTools(agent, ['visible', 'hidden'])
    ctx.tools.guard(exec => exec.name === 'hidden' ? 'fixture failure' : undefined)
    await call('hidden'); await call('third')
    expect(engine.warmNamesFor(agent)).toEqual(['visible', 'third'])
  })
  it('preserves finalized nested content but only runs the leaf finalizer once', async () => {
    const { ctx, engine, agent, input, call } = await fixture()
    let finalized = 0
    ctx.tools.register(defineTool({ name: 'finalized', description: 'fixture', parameters: {}, output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'initial' }] }, finalizeContent: () => { finalized++; return [{ type: 'text', text: 'leaf final' }] }, async execute() { return 'ok' } }))
    await engine.assemble(input(), agent)
    expect((await call('tool_call', { name: 'finalized' })).content).toEqual([{ type: 'text', text: 'leaf final' }]); expect(finalized).toBe(1)
  })
  it('keeps exact-name matches ahead of many weaker description/group matches', () => {
    const entries = [{ name: 'repo', description: '', group: undefined, parameters: {} }, { name: 'repo_repository_screenshot_snapshot_issue', description: 'repo repository repo', group: 'repo', parameters: {} }]
    expect(keywordSearch('repo', entries, 5)[0]?.name).toBe('repo')
  })
})

describe('asynchronous revocation and transport exclusion', () => {
  it('does not return revoked tools when rerank fails after dispatch', async () => {
    const { ctx, engine, agent, input } = await fixture()
    const dispose = ctx.tools.register(defineTool({ name: 'revoked', description: 'fixture', parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, async execute() { return 'ok' } }))
    await writeFile(join(home, RUNTIME_FILE), JSON.stringify({ matcher: { endpoint: 'https://example.test/rerank', apiKey: 'fixture', model: 'fixture' } }))
    await engine.assemble(input(), agent)
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => { await Promise.resolve(); dispose(); throw new Error('rerank failed after revocation') }))
    const result = await engine.search('revoked', 5, agent)
    expect(result.mode).toBe('keyword'); expect(result.matches).toEqual([]); expect(engine.warmNamesFor(agent)).not.toContain('revoked')
  })
  it('does not search the reserved transport in a both-mode registry', async () => {
    const { ctx, engine, agent, input } = await fixture()
    const scope = createScope(ctx, agent)
    await scope.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(scoped: Context) { scoped.tools.presentAs('both') } })
    expect(ctx.tools.schemas(agent).some(tool => tool.name === 'run_code')).toBe(true)
    await engine.assemble(input(), agent)
    expect((await engine.search('run_code', 5, agent)).matches).toEqual([])
    expect((await engine.catalogView(agent)).tools.find(tool => tool.name === 'run_code')?.deferred).toBe(false)
    await scope.dispose()
  })
})
