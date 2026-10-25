/**
 * PTC (`run_code`) presentations: the one tool surface this plugin must not
 * transform. `dsh-tools` owns the mode; the strict `ptc` section is the only
 * public surface that identifies it, so the helpers read sections only.
 * @module dsh-tool-search/ptc
 */

import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

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
 * generated SDK code. Such a scope declares every tool in the `tools:sdk`
 * section instead of the native table, so hiding the table would remove the
 * transport the scope is built around.
 * @param assembly - the settled assembly from the waterfall chain.
 * @returns true when the scope's presentation mode is `ptc`.
 */
export function isPtcOnlyAssembly(
  assembly: Pick<PromptAssembly, 'sections'>,
): boolean {
  return assembly.sections.some(section => section.name === PTC_ONLY_SECTION && section.text !== '')
}
