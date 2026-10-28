/**
 * PTC (`run_code`) presentations: the one tool surface this plugin must not
 * transform. `dsh-tools` owns the mode; these helpers read it from the settled
 * assembly, which is the only public surface that carries it.
 * @module dsh-tool-search/ptc
 */

import type { PromptPresentation } from '@deepseek-ai/dsh-system-prompt'

/** The reserved transport tool `dsh-tools` registers for every non-native scope. */
export const PTC_TRANSPORT_TOOL = 'run_code'

/**
 * The `dsh-tools` prompt section whose text states that only `run_code` may be
 * called directly. It renders empty for `native` and `both`, so a non-empty
 * body identifies a strict `ptc` scope.
 */
const PTC_ONLY_SECTION = 'tools:ptc-only'

/**
 * Whether this assembly belongs to a scope that presents tools strictly as
 * generated SDK code. Such a scope sees `assembly.tools` collapsed to the
 * `run_code` transport with every declaration moved into the `tools:sdk`
 * section, so replacing the table would remove `run_code` from the prompt and
 * leave the declarations this plugin exists to slim untouched.
 * @param assembly - the settled assembly from the waterfall chain.
 * @returns true when the scope's presentation mode is `ptc`.
 */
export function isPtcOnlyAssembly(assembly: PromptPresentation): boolean {
  return assembly.sections.some(section => section.name === PTC_ONLY_SECTION && section.text !== '')
}

/**
 * The reserved transport this assembly already declares callable by name.
 * A `both` scope keeps native calls beside code ones, so the transport must
 * survive the surface replacement even though it is never a long-tail tool.
 * @param assembly - the settled assembly from the waterfall chain.
 * @returns the transport name when the assembly declares it, otherwise empty.
 */
export function transportNamesIn(assembly: PromptPresentation): readonly string[] {
  // dsh 0.2.1-rc.3 presents only the sections, contexts, and variables to the
  // waterfall and appends its own tool table afterwards, so an assembly in the
  // chain may carry no table at all.
  const tools = (assembly as PromptPresentation & { tools?: readonly { readonly name: string }[] }).tools
  if (!Array.isArray(tools)) return []
  return tools.some(tool => tool.name === PTC_TRANSPORT_TOOL) ? [PTC_TRANSPORT_TOOL] : []
}
