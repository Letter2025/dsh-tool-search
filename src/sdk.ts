/**
 * Strict `ptc` scopes keep their collapsed tool table (`run_code` only) and
 * carry every tool declaration in the `tools:sdk` prompt section instead. This
 * module re-renders that section from the same disclosed surface the plugin
 * applies to a native table, so deferred tools stop costing prompt tokens while
 * the bridge tools stay callable from inside `run_code`.
 * @module dsh-tool-search/sdk
 */

import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

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
export interface SdkSchema extends ToolSchema {
  /** Validated canonical value returned by the tool binding. */
  output: JsonSchemaNode
}

/** The canonical output schema `dsh-tools` renders for one declared tool. */
export type SdkOutput = SdkSchema['output']

/** One PTC code generator: the TypeScript or the Python `tools:sdk` renderer. */
type SdkRenderer = (schemas: SdkSchema[]) => string

/**
 * The generators this plugin re-renders with, resolved once per load.
 *
 * Harness 0.2.1-rc.3 moved `renderToolsSdk` and `renderToolsSdkPy` from
 * `@deepseek-ai/dsh-tools` into `@deepseek-ai/dsh-tool-executor-ptc`, and the
 * desktop distribution ships that move while the older npm layout still does
 * not. A static import of either specifier therefore fails to resolve the named
 * exports on one of the two, and a failing static import aborts the whole plugin
 * load before `apply()` runs — the plugin then reports as installed and enabled
 * while never reaching a fiber phase. Resolving at load keeps both layouts
 * working; a harness that ships neither keeps the section untouched instead of
 * breaking the load.
 * @returns the TypeScript renderer and, when its package also carries it, the
 *   Python one; undefined when no shipped package exposes them.
 */
async function resolveRenderers(): Promise<{ ts: SdkRenderer; py?: SdkRenderer } | undefined> {
  for (const specifier of ['@deepseek-ai/dsh-tool-executor-ptc', '@deepseek-ai/dsh-tools']) {
    try {
      const module = (await import(specifier)) as { renderToolsSdk?: SdkRenderer; renderToolsSdkPy?: SdkRenderer }
      if (typeof module.renderToolsSdk !== 'function') continue
      const ts = module.renderToolsSdk
      return typeof module.renderToolsSdkPy === 'function' ? { ts, py: module.renderToolsSdkPy } : { ts }
    } catch {
      // This candidate is not installed in the running harness; try the next one.
    }
  }
  return undefined
}

const renderers = await resolveRenderers()

/**
 * The generator an existing section's text came from. The language is read from
 * the text because it is the only public carrier of `ctx.ptcRuntime.language`;
 * re-rendering under the other language would replace the model's programming
 * surface, so unrecognized text keeps the section untouched.
 * @param text - the resolved `tools:sdk` text.
 * @returns the matching renderer, or undefined when the language is unknown or
 *   its generator is unavailable.
 */
function rendererFor(text: string): SdkRenderer | undefined {
  if (text.includes('interface ToolArgsMap')) return renderers?.ts
  if (text.includes('TypedDict')) return renderers?.py
  return undefined
}

/**
 * Project the disclosed surface into the declaration list `renderToolsSdk` and
 * `renderToolsSdkPy` consume. `dsh-tools` reads the output schema from the same
 * registry definition.
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
 * @returns the transformed assembly, or the input when it carries no section
 *   this plugin recognizes.
 */
export function applySdkSection(assembly: PromptAssembly, schemas: readonly SdkSchema[]): PromptAssembly {
  const section = assembly.sections.find(entry => entry.name === SDK_SECTION)
  if (section === undefined) return assembly
  const render = rendererFor(section.text)
  if (render === undefined) return assembly
  const text = render([...schemas])
  return { ...assembly, sections: assembly.sections.map(entry => (entry === section ? { ...entry, text } : entry)) }
}
