import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile, rm, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../src/index.ts'
import { RUNTIME_FILE, userConfigPath } from '../src/config.ts'
import { MANIFEST_CONTEXT } from '../src/disclosure.ts'
import type { ToolSearchConfig } from '../src/types.ts'

const realDshHome = process.env.DSH_HOME
let home: string

function baseConfig(overrides: Partial<ToolSearchConfig> = {}): ToolSearchConfig {
  return {
    enabled: 'auto',
    thresholdPct: 50,
    listingMaxTokens: 100000,
    contextWindow: 128000,
    searchDefaultLimit: 5,
    maxSearchLimit: 20,
    minCatalogSize: 2,
    configScope: 'user',
    core: ['todo_write'],
    matcherTimeoutMs: 5000,
    maxWarmTools: 8,
    ...overrides,
  }
}

async function harness(cfg: ToolSearchConfig = baseConfig()) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  const engine = apply(ctx, cfg)
  return { ctx, engine }
}

const echoTool = defineTool({
  name: 'echo_test',
  description: 'echo text back',
  parameters: { text: { type: 'string' } },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
  async execute(args: unknown) {
    return (args as { text?: string }).text ?? ''
  },
})

function filler(index: number) {
  return defineTool({
    name: `filler_${String(index).padStart(2, '0')}`,
    description: `filler tool number ${index} with a description long enough to matter`,
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute() {
      return 'ok'
    },
  })
}

function registerCatalog(ctx: Context, count = 10) {
  ctx.tools.register(echoTool)
  for (let i = 1; i <= count; i += 1) ctx.tools.register(filler(i))
}

function callSignal() {
  return new AbortController().signal
}

function fakeAgent(id = 'warm-session'): Agent {
  return { session: { id: SessionId(id) } } as unknown as Agent
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-tool-search-engine-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (realDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = realDshHome
  await rm(home, { recursive: true, force: true })
})

describe('plugin assembly transform', () => {
  it('replaces the model-visible surface with eager tools plus the bridge', async () => {
    const { ctx } = await harness()
    registerCatalog(ctx)
    const assembly = await ctx.systemPrompt.assemble()
    const names = assembly.tools.map(tool => tool.name)
    expect(names).toContain('tool_search')
    expect(names).toContain('tool_slimmer_catalog')
    expect(names).not.toContain('echo_test')
    expect(names).not.toContain('filler_01')
    expect(assembly.tools).toHaveLength(5) // 3 bridges + 2 management tools
    // The manifest rides a runtime context so a complete prompt cannot drop it.
    const manifest = assembly.contexts.find(context => context.name === MANIFEST_CONTEXT)
    expect(manifest?.text).toContain('echo_test')
  })

  it('leaves a small catalog untouched under auto', async () => {
    const { ctx } = await harness(baseConfig({ minCatalogSize: 100 }))
    ctx.tools.register(echoTool)
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toContain('echo_test')
    expect(assembly.contexts.find(context => context.name === MANIFEST_CONTEXT)).toBeUndefined()
  })

  it('stays untouched when disabled', async () => {
    const { ctx } = await harness(baseConfig({ enabled: 'off' }))
    registerCatalog(ctx)
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toContain('echo_test')
  })

  it('falls back to a group summary when even names overflow the budget', async () => {
    const { ctx } = await harness(baseConfig({ contextWindow: 2000, thresholdPct: 1, listingMaxTokens: 100 }))
    registerCatalog(ctx, 12)
    const assembly = await ctx.systemPrompt.assemble()
    const manifest = assembly.contexts.find(context => context.name === MANIFEST_CONTEXT)
    expect(manifest?.text).toContain('ungrouped')
  })
})

describe('tool_call bridge', () => {
  it('executes the real tool by name and surfaces it to guards', async () => {
    const { ctx } = await harness()
    ctx.tools.register(echoTool)
    const seen: string[] = []
    ctx.tools.guard(exec => { seen.push(exec.name); return undefined })
    const result = await ctx.tools.execute({
      callId: CallId('c1'),
      name: 'tool_call',
      arguments: { name: 'echo_test', arguments: { text: 'hi' } },
      signal: callSignal(),
    })
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.value as string)).toEqual({ ok: true, value: 'hi' })
    expect(seen).toContain('echo_test')
  })

  it('rejects calls to bridge tools themselves', async () => {
    const { ctx } = await harness()
    const result = await ctx.tools.execute({
      callId: CallId('c2'),
      name: 'tool_call',
      arguments: { name: 'tool_search', arguments: {} },
      signal: callSignal(),
    })
    expect(JSON.parse(result.value as string)).toMatchObject({ ok: false })
  })

  it('rejects unknown tool names', async () => {
    const { ctx } = await harness()
    const result = await ctx.tools.execute({
      callId: CallId('c3'),
      name: 'tool_call',
      arguments: { name: 'no_such_tool' },
      signal: callSignal(),
    })
    expect(JSON.parse(result.value as string)).toMatchObject({ ok: false, error: expect.stringContaining('no_such_tool') })
  })
})

describe('tool_search bridge', () => {
  it('falls back to keyword matching when no matcher is configured', async () => {
    const { ctx } = await harness()
    ctx.tools.register(echoTool)
    const result = await ctx.tools.execute({
      callId: CallId('c4'),
      name: 'tool_search',
      arguments: { query: 'echo' },
      signal: callSignal(),
    })
    const parsed = JSON.parse(result.value as string) as { mode: string; matches: Array<{ name: string }>; hint?: string }
    expect(parsed.mode).toBe('keyword')
    expect(parsed.matches[0]?.name).toBe('echo_test')
    expect(parsed.hint).toContain('rerank matcher')
  })

  it('returns reranked matches once a matcher is configured', async () => {
    const { ctx } = await harness()
    registerCatalog(ctx)
    await writeFile(join(home, RUNTIME_FILE), JSON.stringify({
      matcher: { endpoint: 'https://example.test/rerank', apiKey: 'sk', model: 'reranker' },
    }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ index: 0, relevance_score: 0.99 }] }),
    }))
    const result = await ctx.tools.execute({
      callId: CallId('c5'),
      name: 'tool_search',
      arguments: { query: 'echo something' },
      signal: callSignal(),
    })
    const parsed = JSON.parse(result.value as string) as { mode: string; matches: Array<{ name: string }> }
    expect(parsed.mode).toBe('rerank')
    expect(parsed.matches[0]?.name).toBe('echo_test')
  })

  it('falls back to keyword matching when the rerank call fails', async () => {
    const { ctx } = await harness()
    ctx.tools.register(echoTool)
    await writeFile(join(home, RUNTIME_FILE), JSON.stringify({
      matcher: { endpoint: 'https://example.test/rerank', apiKey: 'sk', model: 'reranker' },
    }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const result = await ctx.tools.execute({
      callId: CallId('c6'),
      name: 'tool_search',
      arguments: { query: 'echo' },
      signal: callSignal(),
    })
    const parsed = JSON.parse(result.value as string) as { mode: string; matches: Array<{ name: string }>; hint?: string }
    expect(parsed.mode).toBe('keyword')
    expect(parsed.matches[0]?.name).toBe('echo_test')
    expect(parsed.hint).toContain('network down')
  })
})

describe('dynamic injection (warm set)', () => {
  it('injects searched tools into the visible context of the next assembly', async () => {
    const { ctx, engine } = await harness()
    registerCatalog(ctx)
    const agent = fakeAgent()
    const assembly = await engine.assemble({ sections: [], contexts: [], tools: [], variables: {} }, agent)
    expect(assembly.tools.map(tool => tool.name)).not.toContain('echo_test')

    const result = await ctx.tools.execute({
      callId: CallId('w1'),
      name: 'tool_search',
      arguments: { query: 'echo' },
      signal: callSignal(),
      agent,
    })
    expect(JSON.parse(result.value as string)).toMatchObject({ mode: 'keyword' })

    const warmed = await engine.assemble({ sections: [], contexts: [], tools: [], variables: {} }, agent)
    expect(warmed.tools.map(tool => tool.name)).toContain('echo_test')
  })

  it('injects described tools into the visible context', async () => {
    const { ctx, engine } = await harness()
    registerCatalog(ctx)
    const agent = fakeAgent()
    await ctx.tools.execute({
      callId: CallId('w2'),
      name: 'tool_describe',
      arguments: { name: 'echo_test' },
      signal: callSignal(),
      agent,
    })
    const warmed = await engine.assemble({ sections: [], contexts: [], tools: [], variables: {} }, agent)
    expect(warmed.tools.map(tool => tool.name)).toContain('echo_test')
  })

  it('evicts the least-recently-warmed tool beyond maxWarmTools', async () => {
    const { ctx, engine } = await harness(baseConfig({ maxWarmTools: 2 }))
    registerCatalog(ctx)
    const agent = fakeAgent()
    engine.warmTools(agent, ['filler_01', 'filler_02', 'filler_03'])
    expect(engine.warmNamesFor(agent)).toEqual(['filler_02', 'filler_03'])
    const assembly = await engine.assemble({ sections: [], contexts: [], tools: [], variables: {} }, agent)
    const names = assembly.tools.map(tool => tool.name)
    expect(names).toContain('filler_02')
    expect(names).not.toContain('filler_01')
  })
})

describe('setup tools and skill', () => {
  it('tool_slimmer_update_config persists groups to the user file', async () => {
    const { ctx } = await harness()
    const result = await ctx.tools.execute({
      callId: CallId('c7'),
      name: 'tool_slimmer_update_config',
      arguments: { scope: 'user', groups: [{ name: 'git', tools: ['echo_test'] }] },
      signal: callSignal(),
    })
    const parsed = JSON.parse(result.value as string) as { path: string; groups: Array<{ name: string }> }
    expect(parsed.path).toBe(userConfigPath())
    expect(parsed.groups[0]?.name).toBe('git')
    const onDisk = JSON.parse(await readFile(userConfigPath(), 'utf8')) as { groups: Array<{ tools: string[] }> }
    expect(onDisk.groups[0]?.tools).toEqual(['echo_test'])
  })

  it('tool_slimmer_update_config rejects invalid input', async () => {
    const { ctx } = await harness()
    const result = await ctx.tools.execute({
      callId: CallId('c8'),
      name: 'tool_slimmer_update_config',
      arguments: { scope: 'banana' },
      signal: callSignal(),
    })
    // The enum in the tool schema rejects the value before the body runs.
    expect(result.isError).toBe(true)
  })

  it('registers the onboarding skill', async () => {
    const { ctx } = await harness()
    const skills = await ctx.skills.list({ cwd: home })
    expect(skills.map(skill => skill.name)).toContain('tool-slimmer-setup')
  })
})
