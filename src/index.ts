/**
 * dsh-tool-search: Hermes-style tool search & slimming for DeepSeek Harness.
 *
 * When the model-visible tool catalog is large, the plugin hides the long tail
 * behind three bridge tools (`tool_search` / `tool_describe` / `tool_call`)
 * plus a tiered grouped manifest. Hiding uses a scoped `ctx.tools.restrict()`
 * registration, so the registry — not a rewritten prompt — owns the visible
 * set and discovered tools become visible by lifting their entry from the
 * deny list. Long-tail tools are found through a configured rerank model and
 * invoked by real name through `ctx.tools.execute`, so approvals, guards, and
 * session events all reference the underlying tool. Core tools stay eager.
 * Tool groups, the rerank matcher, and optional preload live in a runtime
 * config file (`~/.dsh/dsh-tool-search.json` or
 * `<workspace>/.dsh/dsh-tool-search.json`) that the bundled
 * `tool-slimmer-setup` skill writes after conversational setup.
 * @module dsh-tool-search
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { RuntimeConfigStore, ToolSearchConfigSchema } from './config.ts'
import { ToolSearchEngine } from './engine.ts'
import { registerBridgeTools, BRIDGE_NAMES, type BridgeDeps } from './bridge.ts'
import { registerManagementTools, registerSetupSkill } from './setup.ts'
import type { ToolSearchConfig } from './types.ts'

export const name = 'dsh-tool-search'
export const inject = ['tools', 'skills', 'systemPrompt']

export const Config = ToolSearchConfigSchema

/**
 * Apply the plugin: register the assemble waterfall that appends the catalog
 * manifest, the three bridge tools, the setup/management tools, the onboarding
 * skill, and the lifecycle hooks that keep each agent's tool restriction in
 * step with its warm set.
 * @param ctx - the plugin context.
 * @param config - validated static tuning from cordis.yml.
 * @returns the engine instance (usable by the runtime and tests).
 */
export function apply(ctx: Context, config: ToolSearchConfig): ToolSearchEngine {
  const store = new RuntimeConfigStore(message => ctx.logger.warn(message))
  const engine = new ToolSearchEngine(ctx, config, store)

  // Transform the settled assembly last so earlier listeners keep their turn.
  // Tool declarations are the registry's; the waterfall only contributes text.
  ctx.on('system-prompt/assemble', async (__assembly, context, next) => {
    const settled = await next()
    if (config.enabled === 'off') return settled
    return engine.assemble(settled, context.scope)
  })

  // The restriction must exist before a step's tool admission resolves, which
  // happens after these events: a fresh agent, each claimed turn, and after a
  // result that may have warmed tools (a bridge search or describe).
  const refresh = (agent: Agent | undefined): void => {
    if (config.enabled === 'off' || agent === undefined) return
    void engine.refresh(agent).catch(error => {
      ctx.logger.warn(`dsh-tool-search: surface refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  ctx.on('agent/created', ({ agent }) => { refresh(agent); return undefined })
  ctx.on('agent/inbox/claimed', ({ agent }) => { refresh(agent) })
  ctx.on('tools/result', exec => { refresh(exec.agent) })

  const deps: BridgeDeps = {
    search: (query, limit, agent) => engine.search(query, limit, agent),
    describe: (name, agent) => engine.describe(name, agent),
    warm: (names, agent) => engine.warmAndRefresh(agent, names),
    canCall: name => engine.canCall(name),
  }
  registerBridgeTools(ctx, deps)
  registerManagementTools(ctx, engine)
  registerSetupSkill(ctx)
  return engine
}

export { BRIDGE_NAMES }
