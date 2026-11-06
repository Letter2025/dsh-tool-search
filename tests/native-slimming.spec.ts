import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { apply as applyNativeExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../src/index.ts'
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
  applyNativeExecutor(ctx)
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
    parameters: { value: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args: any) {
      return `ok:${args?.value ?? index}`
    },
  })
}

function registerCatalog(ctx: Context, count = 10) {
  ctx.tools.register(echoTool)
  for (let i = 1; i <= count; i += 1) ctx.tools.register(filler(i))
}

function fakeAgent(id = 'native-test-agent', cwd?: string): Agent {
  return {
    id: SessionId(id),
    session: {
      header: { id: SessionId(id), ...cwd !== undefined ? { cwd } : {} },
      id: SessionId(id),
    },
  } as unknown as Agent
}

async function executeOne(ctx: Context, input: { callId: ReturnType<typeof ToolCallId>; name: string; arguments: unknown; signal: AbortSignal; agent?: Agent; [key: string]: unknown }) {
  const batch = await ctx.tools.execute({
    calls: [
      {
        type: 'tool-call',
        id: input.callId,
        name: input.name,
        arguments: typeof input.arguments === 'string' ? input.arguments : JSON.stringify(input.arguments),
      },
    ],
    signal: input.signal,
    ...input.agent !== undefined ? { agent: input.agent } : {},
    maxParallelToolCalls: 1,
  })
  const first = batch.results[0]
  if (first === undefined) throw new Error('no result')
  return first.result
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-tool-search-native-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (realDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = realDshHome
  await rm(home, { recursive: true, force: true })
})

describe('native tool slimming in modern DSH (0.2.1-rc.3+ / 0.2.2-rc.1)', () => {
  it('slims native tool declarations for an agent while providing manifest', async () => {
    const { ctx } = await harness(baseConfig({ enabled: 'on' }))
    registerCatalog(ctx, 10)

    const agent = fakeAgent()
    const toolSet = await ctx.tools.resolve({ agent, signal: new AbortController().signal, modelSelection: { provider: 'test', model: 'test' } as any })
    const assembly = await ctx.systemPrompt.assemble({ scope: agent, toolSet })
    const toolNames = assembly.tools.map(tool => tool.name)

    // Bridge and core tools must be present
    expect(toolNames).toContain('tool_search')
    expect(toolNames).toContain('tool_describe')
    expect(toolNames).toContain('tool_call')

    // Deferred tools must NOT be present in native tool schemas
    expect(toolNames).not.toContain('filler_01')
    expect(toolNames).not.toContain('filler_02')
    expect(toolNames).not.toContain('filler_10')

    // Manifest context must be present with deferred tools
    const manifest = assembly.contexts.find(context => context.name === MANIFEST_CONTEXT)
    expect(manifest).toBeDefined()
    expect(manifest?.text).toContain('filler_01')
    expect(manifest?.text).toContain('filler_10')
  })

  it('allows tool_call to execute a deferred tool and warms it for next turn', async () => {
    const { ctx } = await harness(baseConfig({ enabled: 'on' }))
    registerCatalog(ctx, 5)

    const agent = fakeAgent()

    // 1. First assemble: filler_01 is deferred
    const toolSet1 = await ctx.tools.resolve({ agent, signal: new AbortController().signal, modelSelection: { provider: 'test', model: 'test' } as any })
    const firstAssembly = await ctx.systemPrompt.assemble({ scope: agent, toolSet: toolSet1 })
    expect(firstAssembly.tools.map(t => t.name)).not.toContain('filler_01')

    // 2. Invoke filler_01 through tool_call
    const result = await executeOne(ctx, {
      callId: ToolCallId('c1'),
      name: 'tool_call',
      arguments: { name: 'filler_01', arguments: { value: 'test-val' } },
      signal: new AbortController().signal,
      agent,
    })

    const parsed = JSON.parse(result.value as string)
    expect(parsed).toEqual({ ok: true, value: 'ok:test-val' })

    // 3. Second assemble: filler_01 is now warmed and present in native tool declarations
    const toolSet2 = await ctx.tools.resolve({ agent, signal: new AbortController().signal, modelSelection: { provider: 'test', model: 'test' } as any })
    const secondAssembly = await ctx.systemPrompt.assemble({ scope: agent, toolSet: toolSet2 })
    expect(secondAssembly.tools.map(t => t.name)).toContain('filler_01')
  })

  it('warms searched tools so they become visible on next assemble', async () => {
    const { ctx } = await harness(baseConfig({ enabled: 'on' }))
    registerCatalog(ctx, 5)

    const agent = fakeAgent()

    // Search for filler_02
    const result = await executeOne(ctx, {
      callId: ToolCallId('s1'),
      name: 'tool_search',
      arguments: { query: 'filler_02' },
      signal: new AbortController().signal,
      agent,
    })

    expect(JSON.parse(result.value as string)).toMatchObject({ mode: 'keyword' })

    // Second assemble: filler_02 is warmed
    const secondAssembly = await ctx.systemPrompt.assemble({ scope: agent })
    expect(secondAssembly.tools.map(t => t.name)).toContain('filler_02')
  })
})
