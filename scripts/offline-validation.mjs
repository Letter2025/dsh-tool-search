/** Run after npm run build. Synthetic tools only; no accounts, model, or network. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { apply } from '../lib/index.js'
import { ToolSearchConfigSchema } from '../lib/config.js'
import { FORCED_EAGER, buildGroupedManifest } from '../lib/groups.js'
import { snapshotCatalog, estimateTokens } from '../lib/catalog.js'
import { MANIFEST_CONTEXT, MANIFEST_HEADER } from '../lib/disclosure.js'

const previousHome = process.env.DSH_HOME
const previousFetch = globalThis.fetch
const home = await mkdtemp(join(tmpdir(), 'dsh-tool-search-offline-'))
process.env.DSH_HOME = home
globalThis.fetch = async () => { throw new Error('network is disabled for offline validation') }
const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  const config = { ...ToolSearchConfigSchema(), enabled: 'on', listingMaxTokens: 100000, maxWarmTools: 8 }
  const engine = apply(ctx, config)
  const syntheticNames = [...config.core, ...Array.from({ length: 60 }, (_, i) => `fixture_${String(i).padStart(2, '0')}`), 'fixture_removed_upstream']
  for (const name of syntheticNames) ctx.tools.register(defineTool({
    name, description: `Synthetic offline tool ${name}`, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() { return `synthetic:${name}` },
  }))
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const settled = await next()
    return { ...settled, tools: settled.tools.filter(tool => tool.name !== 'fixture_removed_upstream') }
  })
  const agent = { session: { id: 'offline-synthetic', header: { cwd: home } } }
  const allowedEntries = snapshotCatalog(ctx.tools.schemas(agent).filter(tool => tool.name !== 'fixture_removed_upstream'), [])
  const core = new Set([...config.core, ...FORCED_EAGER, 'run_code'])
  const actions = ['search', 'describe', 'native', 'bridge']
  const rounds = []
  for (let i = 0; i < 30; i++) {
    await ctx.systemPrompt.assemble({ scope: agent })
    const name = `fixture_${String(i % 20).padStart(2, '0')}`
    const action = actions[i % actions.length]
    const dispatch = action === 'search' ? { name: 'tool_search', arguments: { query: name, limit: 1 } }
      : action === 'describe' ? { name: 'tool_describe', arguments: { name } }
      : action === 'bridge' ? { name: 'tool_call', arguments: { name } }
      : { name, arguments: {} }
    const result = await ctx.tools.execute({ ...dispatch, callId: ToolCallId(`offline-${i}`), signal: new AbortController().signal, agent })
    assert.equal(result.isError, false)
    assert.equal(engine.canCall('fixture_removed_upstream', agent), false)
    const assembly = await ctx.systemPrompt.assemble({ scope: agent })
    const contexts = assembly.contexts.filter(context => context.name === MANIFEST_CONTEXT)
    assert.equal(contexts.length, 1)
    assert.ok(engine.warmNamesFor(agent).includes(name))
    const warm = new Set(engine.warmNamesFor(agent))
    // Controlled comparison: reproduce the old warm-dependent listing projection,
    // using this same synthetic allowed catalog, core, tier and current warm state.
    const baselineManifest = `${MANIFEST_HEADER}\n\n${buildGroupedManifest(allowedEntries.filter(entry => !core.has(entry.name) && !warm.has(entry.name)), 'full')}`
    const visibleJson = JSON.stringify(assembly.tools)
    rounds.push({ round: i + 1, action, manifest: contexts[0].text, baselineManifest, contexts: contexts.length,
      visibleSchemaChars: visibleJson.length, visibleSchemaEstimatedTokens: estimateTokens(visibleJson),
      warmCount: warm.size, visibleTools: assembly.tools.length })
  }
  const distinct = key => new Set(rounds.map(round => round[key])).size
  const changes = key => rounds.slice(1).filter((round, i) => round[key] !== rounds[i][key]).length
  const range = key => ({ min: Math.min(...rounds.map(round => round[key])), max: Math.max(...rounds.map(round => round[key])) })
  assert.equal(distinct('manifest'), 1)
  assert.ok(distinct('baselineManifest') > 1)
  assert.ok(rounds.every(round => round.warmCount <= config.maxWarmTools))
  console.log(JSON.stringify({
    validation: 'compiled lib, synthetic tools, isolated temporary DSH_HOME, network disabled',
    comparison: 'old warm-dependent manifest projection; not a replay of old host/model behavior',
    rounds: rounds.length, actions: Object.fromEntries(actions.map(action => [action, rounds.filter(round => round.action === action).length])),
    fixedManifest: { distinct: distinct('manifest'), changes: changes('manifest'), chars: rounds[0].manifest.length, estimatedTokens: estimateTokens(rounds[0].manifest) },
    baselineProjection: { distinct: distinct('baselineManifest'), changes: changes('baselineManifest') },
    maximumCatalogContexts: Math.max(...rounds.map(round => round.contexts)),
    visibleSchemaChars: range('visibleSchemaChars'), visibleSchemaEstimatedTokens: range('visibleSchemaEstimatedTokens'),
    visibleTools: range('visibleTools'), maximumWarmTools: Math.max(...rounds.map(round => round.warmCount)),
  }, null, 2))
} finally {
  globalThis.fetch = previousFetch
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
}
