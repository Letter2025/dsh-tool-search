/**
 * dsh-tool-search: Hermes-style tool search & slimming for DeepSeek Harness.
 *
 * When the model-visible tool catalog is large, the `system-prompt/assemble`
 * waterfall replaces the visible tool schemas with three bridge tools
 * (`tool_search` / `tool_describe` / `tool_call`) plus a tiered grouped
 * manifest; long-tail tools are discovered through a configured rerank model
 * and invoked by real name through `ctx.tools.execute`, so approvals, guards,
 * and session events all reference the underlying tool. Core tools stay
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
import type { ToolSearchConfig } from './types.ts'

export const name = 'dsh-tool-search'
export const inject = ['tools', 'skills']

export const Config = ToolSearchConfigSchema

const BLOCKED_FROM_BRIDGE = new Set<string>([...BRIDGE_NAMES, ...MANAGEMENT_NAMES, 'skill'])

/**
 * Apply the plugin: register the assemble waterfall transform, the three
 * bridge tools, the setup/management tools, and the onboarding skill.
 * @param ctx - the plugin context.
 * @param config - validated static tuning from cordis.yml.
 */
export function apply(ctx: Context, config: ToolSearchConfig): void {
  const store = new RuntimeConfigStore(message => ctx.logger.warn(message))
  const engine = new ToolSearchEngine(ctx, config, store)

  // Transform the settled assembly last so earlier listeners keep their turn;
  // a later-registered listener inside next() may still override this result.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const settled = await next()
    if (config.enabled === 'off') return settled
    return engine.assemble(settled, context.scope)
  })

  const deps: BridgeDeps = {
    search: (query, limit, agent) => engine.search(query, limit, agent),
    describe: (name, agent) => engine.describe(name, agent),
    canCall: (name, agent) => {
      if (BLOCKED_FROM_BRIDGE.has(name)) return false
      return ctx.tools.get(name, agent) !== undefined
    },
  }
  registerBridgeTools(ctx, deps)
  registerManagementTools(ctx, engine)
  registerSetupSkill(ctx)
}
