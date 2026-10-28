/**
 * Strict `ptc` scopes keep their collapsed tool table (`run_code` only) and
 * carry every tool declaration in the `tools:sdk` prompt section instead. This
 * module re-renders that section from the same disclosed surface the plugin
 * applies to a native table, so deferred tools stop costing prompt tokens while
 * the bridge tools stay callable from inside `run_code`.
 * @module dsh-tool-search/sdk
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PromptPresentation } from '@deepseek-ai/dsh-system-prompt'

/** The `dsh-tools` prompt section carrying the generated PTC declarations. */
export const SDK_SECTION = 'tools:sdk'

/**
 * Framing header for the catalog injected into a strict `ptc` scope. The bridge
 * tools are declared there, but a direct call to one fails: only `run_code` is
 * callable by name, so the native header's call instructions would name calls
 * this scope rejects.
 */
export const PTC_MANIFEST_HEADER =
  'Deferred tool catalog — these tools are NOT declared in the generated SDK. Inside run_code, call `await tools.tool_search({ query })` to rank them and `await tools.tool_describe({ name })` to load a schema, then invoke one with `await tools.<name>({ ... })`. A searched, described, or called tool is declared in your SDK for later turns.'

/** One entry of the declaration list the PTC generators consume. */
export type SdkSchema = ToolSchema & { readonly output: unknown }

/** The canonical output schema the generators render for one declared tool. */
export type SdkOutput = SdkSchema['output']

/** One PTC code generator: the TypeScript or the Python `tools:sdk` renderer. */
export type SdkRenderer = (schemas: readonly SdkSchema[]) => string

/** The part of a harness package that renders `tools:sdk` text. */
export type SdkRenderers = {
  readonly renderToolsSdk?: SdkRenderer
  readonly renderToolsSdkPy?: SdkRenderer
}

/**
 * Harness packages that have carried the PTC generators, newest first.
 * `@deepseek-ai/dsh-tools` stopped exporting them in dsh 0.2.1-rc.3, where the
 * PTC executor package took them over. Either package is missing from some
 * installations — the executor package is not published for every harness
 * version — so a static import of either one breaks the other.
 */
const SDK_RENDERER_PACKAGES = ['@deepseek-ai/dsh-tool-executor-ptc', '@deepseek-ai/dsh-tools'] as const

let resolved: Promise<SdkRenderers> | undefined

/**
 * Resolve the PTC generators at run time. A harness carrying neither package
 * loads the plugin with the section rewrite disabled instead of failing the
 * whole import graph: the declaration rewrite is one feature, not the plugin.
 * @returns the first package exporting `renderToolsSdk`, otherwise empty.
 */
export function loadSdkRenderers(): Promise<SdkRenderers> {
  resolved ??= (async (): Promise<SdkRenderers> => {
    for (const specifier of SDK_RENDERER_PACKAGES) {
      try {
        const module = await import(specifier) as unknown as SdkRenderers
        if (typeof module.renderToolsSdk === 'function') return module
      } catch {
        // Not installed in this harness; the next candidate may carry it.
      }
    }
    return {}
  })()
  return resolved
}

/**
 * The generator an existing section's text came from. The language is read from
 * the text because it is the only public carrier of the PTC language;
 * re-rendering under the other language would replace the model's programming
 * surface, so unrecognized text keeps the section untouched.
 * @param text - the resolved `tools:sdk` text.
 * @param renderers - the resolved generators of this harness.
 * @returns the matching renderer, or undefined when the language is unknown.
 */
export function rendererFor(text: string, renderers: SdkRenderers): SdkRenderer | undefined {
  if (text.includes('interface ToolArgsMap')) return renderers.renderToolsSdk
  if (text.includes('TypedDict')) return renderers.renderToolsSdkPy
  return undefined
}

/**
 * Project the disclosed surface into the declaration list the PTC generators
 * consume. The harness reads the output schema from the same registry
 * definition.
 * @param tools - the disclosed schemas (eager core plus bridges).
 * @param outputOf - the registered output schema for one tool name, if any.
 * @returns the schemas to declare, in the given order.
 */
export function sdkSchemas(
  tools: readonly ToolSchema[],
  outputOf: (name: string) => SdkOutput | undefined,
): SdkSchema[] {
  // A definition observed mid-registration has no output schema yet; the
  // renderer reads an annotation-only node as unconstrained JSON, which keeps
  // the declaration list complete instead of dropping a callable tool.
  return tools.map(tool => ({ ...tool, output: outputOf(tool.name) ?? {} }))
}

/**
 * Rewrite the `tools:sdk` section so it declares only `schemas`. The tool table
 * is left alone: a strict `ptc` scope's table is the `run_code` transport, and
 * replacing it is what removed the transport from the prompt.
 * @param assembly - the settled assembly from the waterfall chain.
 * @param schemas - the declarations the section should carry.
 * @param renderers - the generators to use, defaulting to this harness's own.
 * @returns the assembly with the rewritten section, or the same assembly when
 * the section is absent or its generator is unknown.
 */
export async function applySdkSection<T extends PromptPresentation>(
  assembly: T,
  schemas: readonly SdkSchema[],
  renderers?: SdkRenderers,
): Promise<T> {
  const section = assembly.sections.find(entry => entry.name === SDK_SECTION)
  if (section === undefined) return assembly
  const renderer = rendererFor(section.text, renderers ?? await loadSdkRenderers())
  if (renderer === undefined) return assembly
  const text = renderer(schemas)
  return {
    ...assembly,
    sections: assembly.sections.map(entry => (entry.name === SDK_SECTION ? { ...entry, text } : entry)),
  } as T
}
