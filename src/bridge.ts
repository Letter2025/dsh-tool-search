import type { Context } from '@deepseek-ai/cordis'
// dsh-llm 0.1.2 renamed the call-id brand `CallId` -> `ToolCallId`.
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecutionInput, type ToolRunContext, type ToolExecutionFailure, type ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { SearchOutcome } from './types.ts'

/** The three bridge tool names; always eager and never callable through `tool_call`. */
export const BRIDGE_NAMES = ['tool_search', 'tool_describe', 'tool_call'] as const

/** Services the bridge tools need; implemented by the engine. */
export interface BridgeDeps {
  /** Search over the deferred catalog (rerank with keyword fallback). */
  search(query: string, limit: number | undefined, agent: ToolRunContext['agent']): Promise<SearchOutcome>
  /** Full schema of one catalog tool, or undefined when unknown. */
  describe(name: string, agent: ToolRunContext['agent']): { name: string; description: string } | undefined
  unavailableReason(agent: ToolRunContext['agent']): string | undefined
  /** Whether a name may be executed through the bridge (registered, not a bridge/management tool). */
  canCall(name: string, agent: ToolRunContext['agent']): boolean
}

function textRender(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Search/describe render JSON text. Calls retain their canonical JSON string
 * while projecting native content and propagating real failures.
 * @param ctx - the plugin context.
 * @param deps - engine-backed search/describe/dispatch services.
 * @returns the combined disposer for all three registrations.
 */
export function registerBridgeTools(ctx: Context, deps: BridgeDeps): () => void {
  const failures = new Map<ToolExecutionToken, ToolExecutionFailure>()
  const failureObserver = ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'tool_call') return next()
    try {
      const result = await next()
      return result.isError ? result : failures.get(exec.token) ?? result
    } finally {
      failures.delete(exec.token)
    }
  })
  const disposers = [failureObserver,
    ctx.tools.register(defineTool({
      name: 'tool_search',
      description: 'Search the deferred tool catalog (tools hidden to save tokens) and return ranked matches. Matches are injected into the visible context for later turns. Ranking uses the configured rerank matcher with a keyword fallback.',
      parameters: {
        query: { type: 'string', required: true },
        limit: { type: 'integer' },
      },
      output: { schema: { type: 'string' }, render: textRender },
      async execute(args: unknown, exec: ToolRunContext): Promise<string> {
        const { query, limit } = args as { query: string; limit?: number }
        try {
          const outcome = await deps.search(query, limit, exec.agent)
          const payload: Record<string, unknown> = { matches: outcome.matches, mode: outcome.mode }
          if (outcome.hint !== undefined) payload.hint = outcome.hint
          return JSON.stringify(payload)
        } catch (error) {
          return JSON.stringify({ error: errorMessage(error) })
        }
      },
    })),
    ctx.tools.register(defineTool({
      name: 'tool_describe',
      description: 'Load the full schema (parameters and description) of one deferred tool by name. The tool becomes visible in the context for later turns.',
      parameters: {
        name: { type: 'string', required: true },
      },
      output: { schema: { type: 'string' }, render: textRender },
      async execute(args: unknown, exec: ToolRunContext): Promise<string> {
        const { name } = args as { name: string }
        const schema = deps.describe(name, exec.agent)
        if (schema === undefined) return JSON.stringify({ error: deps.unavailableReason(exec.agent) ?? `unknown or unavailable tool "${name}"` })
        return JSON.stringify(schema)
      },
    })),
    ctx.tools.register(defineTool({
      name: 'tool_call',
      description: 'Invoke an upstream-allowed tool by name with its arguments. The underlying dispatch uses the real tool name for approvals and guards; the outer session call remains tool_call. Native content and failures are preserved. Successful non-core tools may become directly visible on later turns.',
      parameters: {
        name: { type: 'string', required: true },
        arguments: { type: 'object', additionalProperties: true },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => JSON.parse(value as string).content,
        presentationMeta: (_args, value) => JSON.parse(value as string).meta ?? null,
      },
      async execute(args: unknown, exec: ToolRunContext): Promise<string> {
        const { name, arguments: toolArgs } = args as { name: string; arguments?: Record<string, unknown> }
        if (!deps.canCall(name, exec.agent)) throw new Error(deps.unavailableReason(exec.agent) ?? `tool "${name}" is not callable through tool_call`)
        const input: ToolExecutionInput = {
          callId: ToolCallId(`${String(exec.callId)}:tool:${name}`),
          name,
          arguments: toolArgs ?? {},
          signal: exec.signal,
          ...exec.agent !== undefined ? { agent: exec.agent } : {},
        }
        const result = await ctx.tools.execute(input)
        if (result.isError) {
          failures.set(exec.token, result)
          return JSON.stringify({ ok: false, error: result.error.message, content: result.content, meta: result.meta ?? null })
        }
        for (const context of result.additionalContexts ?? []) exec.deferContext(context)
        if (result.concludesTurn) exec.concludeTurn()
        return JSON.stringify({ ok: true, value: result.value, content: result.content, meta: result.meta ?? null })
      },
    })),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
