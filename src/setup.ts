import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import type { ToolSearchEngine } from './engine.ts'
import type { PreloadConfig, RerankMatcherConfig, RuntimeScope, ToolGroupSpec, UpdateConfigInput } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    skills: SkillRegistry
  }
}

/** The setup/management tool names; always eager and never bridged. */
export const MANAGEMENT_NAMES = ['tool_slimmer_catalog', 'tool_slimmer_update_config'] as const

function textRender(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Shape-validate the update input before it reaches the engine. */
function validateUpdateInput(input: Record<string, unknown>): UpdateConfigInput {
  let scope: RuntimeScope | undefined
  let groups: ToolGroupSpec[] | undefined
  let matcher: RerankMatcherConfig | undefined
  let preload: PreloadConfig | undefined
  let core: string[] | undefined
  if (input.scope !== undefined) {
    if (input.scope !== 'user' && input.scope !== 'project') {
      throw new Error('"scope" must be "user" or "project"')
    }
    scope = input.scope
  }
  if (input.groups !== undefined) {
    if (!Array.isArray(input.groups)) throw new Error('"groups" must be an array')
    groups = input.groups.map(group => {
      if (group === null || typeof group !== 'object' || Array.isArray(group)) {
        throw new Error('each group must be an object with a "name"')
      }
      const record = group as Record<string, unknown>
      if (typeof record.name !== 'string' || record.name === '') throw new Error('each group needs a non-empty string "name"')
      const tools = arrayOfStrings(record.tools, 'tools')
      const prefixes = arrayOfStrings(record.prefixes, 'prefixes')
      return {
        name: record.name,
        ...tools !== undefined ? { tools } : {},
        ...prefixes !== undefined ? { prefixes } : {},
      }
    })
  }
  if (input.matcher !== undefined) {
    if (input.matcher === null || typeof input.matcher !== 'object' || Array.isArray(input.matcher)) {
      throw new Error('"matcher" must be an object with endpoint, apiKey, and model')
    }
    const record = input.matcher as Record<string, unknown>
    for (const key of ['endpoint', 'apiKey', 'model'] as const) {
      if (typeof record[key] !== 'string' || record[key] === '') {
        throw new Error(`matcher "${key}" must be a non-empty string`)
      }
    }
    const topN = record.topN
    if (topN !== undefined && (typeof topN !== 'number' || !Number.isInteger(topN) || topN <= 0)) {
      throw new Error('matcher "topN" must be a positive integer')
    }
    matcher = {
      endpoint: record.endpoint as string,
      apiKey: record.apiKey as string,
      model: record.model as string,
      ...topN !== undefined ? { topN } : {},
    }
  }
  if (input.preload !== undefined) {
    if (input.preload === null || typeof input.preload !== 'object' || Array.isArray(input.preload)) {
      throw new Error('"preload" must be an object with "enabled" and "topK"')
    }
    const record = input.preload as Record<string, unknown>
    if (typeof record.enabled !== 'boolean') throw new Error('preload "enabled" must be a boolean')
    if (typeof record.topK !== 'number' || !Number.isInteger(record.topK) || record.topK <= 0) {
      throw new Error('preload "topK" must be a positive integer')
    }
    preload = { enabled: record.enabled, topK: record.topK }
  }
  if (input.core !== undefined) {
    core = arrayOfStrings(input.core, 'core')
  }
  return {
    ...scope !== undefined ? { scope } : {},
    ...groups !== undefined ? { groups } : {},
    ...matcher !== undefined ? { matcher } : {},
    ...preload !== undefined ? { preload } : {},
    ...core !== undefined ? { core } : {},
  }
}

function arrayOfStrings(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`"${where}" must be an array of strings`)
  }
  return value as string[]
}

/**
 * Register the setup/management tools the bundled skill drives: a catalog
 * reader and a config writer.
 * @param ctx - the plugin context.
 * @param engine - the engine backing catalog reads and config writes.
 * @returns the combined disposer for both registrations.
 */
export function registerManagementTools(ctx: Context, engine: ToolSearchEngine): () => void {
  const disposers = [
    ctx.tools.register(defineTool({
      name: 'tool_slimmer_catalog',
      description: 'List the full tool registry catalog (every tool, visible or deferred). Use this to plan tool groups with the user. The model-visible set may be smaller when the bridge is active.',
      parameters: {},
      output: { schema: { type: 'string' }, render: textRender },
      async execute(_args: unknown, exec: ToolRunContext): Promise<string> {
        try {
          return JSON.stringify(await engine.catalogView(exec.agent))
        } catch (error) {
          return JSON.stringify({ error: errorMessage(error) })
        }
      },
    })),
    ctx.tools.register(defineTool({
      name: 'tool_slimmer_update_config',
      description: 'Validate and persist dsh-tool-search configuration (groups, rerank matcher, optional preload, extra core tools) to the user or project config file.',
      parameters: {
        scope: { type: 'string', enum: ['user', 'project'] },
        groups: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              name: { type: 'string' },
              tools: { type: 'array', items: { type: 'string' } },
              prefixes: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        matcher: {
          type: 'object',
          additionalProperties: true,
          properties: {
            endpoint: { type: 'string' },
            apiKey: { type: 'string' },
            model: { type: 'string' },
            topN: { type: 'integer' },
          },
        },
        preload: {
          type: 'object',
          additionalProperties: true,
          properties: {
            enabled: { type: 'boolean' },
            topK: { type: 'integer' },
          },
        },
        core: { type: 'array', items: { type: 'string' } },
      },
      output: { schema: { type: 'string' }, render: textRender },
      async execute(args: unknown, exec: ToolRunContext): Promise<string> {
        try {
          const input = validateUpdateInput((args ?? {}) as Record<string, unknown>)
          return JSON.stringify(await engine.updateConfig(input, exec.agent))
        } catch (error) {
          return JSON.stringify({ error: errorMessage(error) })
        }
      },
    })),
  ]
  return () => { for (const dispose of disposers) dispose() }
}

/** The bundled onboarding skill body (registered at plugin load). */
export const SETUP_SKILL_CONTENT = `# tool-slimmer-setup

Configure the dsh-tool-search plugin: group tools conversationally, configure the rerank matcher, and optionally enable per-session preload.

## When to use
- The user asks to group tools, set up tool search, configure the rerank model, enable preload, or change where the tool-search config lives.
- \`tool_search\` reports "no rerank matcher configured" or "fell back to keyword matching" and the user wants semantic ranking.

## Workflow
1. Call \`tool_slimmer_catalog\` to read the current tool registry catalog (names, descriptions, and existing groups). It lists EVERY tool — the model-visible set may be smaller when the bridge is active.
2. Propose a grouping in the conversation: group tools by domain (git, web, mcp-*, media, data, ...), using exact tool names or shared name prefixes. Keep the number of groups small (5-12) and every tool in at most one group.
3. Present the proposal and ask the user to confirm or adjust. Iterate until the user accepts.
4. Ask whether the config should be global (user-level) or per-project. When per-project, the config is written to \`.dsh/dsh-tool-search.json\` under the current project.
5. ALWAYS explain and offer the rerank matcher before writing the config: \`tool_search\` ranks with it, and it is required for preload. Describe what it is — an OpenAI-compatible \`/v1/rerank\` endpoint (for example DashScope compatible-mode with \`qwen3-reranker\`) — and ask the user for \`endpoint\`, \`apiKey\`, and \`model\`. If they cannot provide one now, proceed without it: \`tool_search\` then uses the built-in keyword fallback (exact-name and token matches), which works but ranks less well.
6. If the user wants preload, set \`preload: { enabled: true, topK: 5 }\` and confirm the matcher is configured (preload without a matcher stays inactive).
7. Write the confirmed configuration with \`tool_slimmer_update_config\` (groups, optional matcher, optional preload), then confirm the written path and the returned summary with the user. Mention that searched/described/called tools are automatically injected into the context for later turns.`

/**
 * Register the bundled onboarding skill so the model can run conversational
 * grouping and matcher setup on request.
 * @param ctx - the plugin context.
 * @returns the skill registration disposer.
 */
export function registerSetupSkill(ctx: Context): () => void {
  return ctx.skills.register({
    name: 'tool-slimmer-setup',
    description: 'Configure dsh-tool-search: group tools conversationally, configure the rerank matcher, optional preload.',
    content: SETUP_SKILL_CONTENT,
    source: 'bundled',
  })
}
