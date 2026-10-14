/**
 * dsh-tool-search: Hermes-style tool search & slimming for DeepSeek Harness.
 *
 * When the model-visible tool catalog is large, the `system-prompt/assemble`
 * waterfall replaces the visible tool schemas with three bridge tools
 * (`tool_search` / `tool_describe` / `tool_call`) plus a tiered grouped
 * manifest; long-tail tools are discovered through a configured rerank model
 * and invoked by real name through `ctx.tools.execute`, so underlying approvals
 * and guards retain that identity; the outer session call remains `tool_call`. Core tools stay
 * eager. Tool groups, the rerank matcher, and optional preload live in a
 * runtime config file (`~/.dsh/dsh-tool-search.json` or
 * `<workspace>/.dsh/dsh-tool-search.json`) that the bundled
 * `tool-slimmer-setup` skill writes after conversational setup.
 * @module dsh-tool-search
 */

import type { Context } from '@deepseek-ai/cordis'
import { RuntimeConfigStore, ToolSearchConfigSchema } from './config.ts'
import { ToolSearchEngine } from './engine.ts'
import { registerBridgeTools, BRIDGE_NAMES, type BridgeDeps } from './bridge.ts'
import { registerManagementTools, registerSetupSkill, MANAGEMENT_NAMES } from './setup.ts'
import { PTC_TRANSPORT_TOOL } from './ptc.ts'
import type { ToolSearchConfig } from './types.ts'

export const name = 'dsh-tool-search'
export const inject = ['tools', 'skills']

export const Config = ToolSearchConfigSchema

// `run_code` is a direct-call transport, never a deferred catalog entry the
// bridge may invoke by name.
const BLOCKED_FROM_BRIDGE = new Set<string>([...BRIDGE_NAMES, ...MANAGEMENT_NAMES, 'skill', PTC_TRANSPORT_TOOL])

/**
 * Apply the plugin: register the assemble waterfall transform, the three
 * bridge tools, the setup/management tools, and the onboarding skill.
 * @param ctx - the plugin context.
 * @param config - validated static tuning from cordis.yml.
 * @returns the engine instance (usable by the runtime and tests).
 */
export function apply(ctx: Context, config: ToolSearchConfig): ToolSearchEngine {
  const store = new RuntimeConfigStore(message => ctx.logger.warn(message))
  const engine = new ToolSearchEngine(ctx, config, store)

  // Transform the settled assembly last so earlier listeners keep their turn;
  // a later-registered listener inside next() may still override this result.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const settled = await next()
    return engine.assemble(settled, context.scope)
  })

  const deps: BridgeDeps = {
    search: (query, limit, agent) => engine.search(query, limit, agent),
    describe: (name, agent) => engine.describe(name, agent),
    unavailableReason: agent => engine.unavailableReason(agent),
    canCall: (name, agent) => {
      if (BLOCKED_FROM_BRIDGE.has(name)) return false
      return engine.canCall(name, agent)
    },
  }
  ctx.on('tools/result', (exec, result) => {
    if (!result.isError && !BLOCKED_FROM_BRIDGE.has(exec.name)) engine.warmTools(exec.agent, [exec.name])
  })
  registerBridgeTools(ctx, deps)
  registerManagementTools(ctx, engine)
  registerSetupSkill(ctx)
  return engine
}
