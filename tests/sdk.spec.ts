import { describe, expect, it } from 'vitest'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { applySdkSection, PTC_MANIFEST_HEADER, SDK_SECTION, sdkSchemas, type SdkSchema } from '../src/sdk.ts'

function assembly(sections: PromptAssembly['sections']): PromptAssembly {
  return { sections, contexts: [], tools: [], variables: {} }
}

const TS_TEXT = [
  '## Writing code for run_code',
  '',
  '```ts',
  'interface ToolArgsMap {',
  '  echo_test: { text: string };',
  '}',
  '```',
].join('\n')

const PY_TEXT = [
  '## Writing code for run_code',
  '',
  '```python',
  'class ToolArgsMap(TypedDict):',
  '    echo_test: EchoTestArgs',
  '```',
].join('\n')

const SEARCH = { name: 'tool_search', description: 'search the catalog', parameters: { type: 'object', properties: {} } }

describe('sdkSchemas', () => {
  it('carries the registered output schema into the declaration', () => {
    expect(sdkSchemas([SEARCH], () => ({ type: 'string' }))).toEqual([{ ...SEARCH, output: { type: 'string' } }])
  })

  it('falls back to the unconstrained schema when the definition is gone', () => {
    expect(sdkSchemas([SEARCH], () => undefined)[0]?.output).toEqual({})
  })
})

describe('applySdkSection', () => {
  // The generators are resolved from the harness at run time, so these cases
  // hand in their own: a rewrite test must fail when the dispatch is wrong, not
  // when the installed harness moves a renderer again.
  const renderers = {
    renderToolsSdk: (schemas: readonly SdkSchema[]) => 'TS ' + schemas.map(schema => schema.name).join(','),
    renderToolsSdkPy: (schemas: readonly SdkSchema[]) => 'PY ' + schemas.map(schema => schema.name).join(','),
  }

  it('re-renders a TypeScript section with only the declared tools', async () => {
    const input = assembly([{ name: SDK_SECTION, text: TS_TEXT }])
    const result = await applySdkSection(input, sdkSchemas([SEARCH], () => ({ type: 'string' })), renderers)
    const text = result.sections[0]?.text ?? ''
    expect(text).toBe('TS tool_search')
    expect(result.sections[0]?.name).toBe(SDK_SECTION)
  })

  it('re-renders a Python section with the Python generator', async () => {
    const result = await applySdkSection(assembly([{ name: SDK_SECTION, text: PY_TEXT }]), sdkSchemas([SEARCH], () => ({ type: 'string' })), renderers)
    expect(result.sections[0]?.text).toBe('PY tool_search')
  })

  it('leaves a section from an unknown generator untouched', async () => {
    const input = assembly([{ name: SDK_SECTION, text: '## Generated declarations' }])
    expect(await applySdkSection(input, [], renderers)).toBe(input)
  })

  it('leaves an assembly without the section untouched', async () => {
    const input = assembly([{ name: 'tools:ptc-only', text: 'only run_code is callable' }])
    expect(await applySdkSection(input, [], renderers)).toBe(input)
  })

  it('keeps the section when the harness carries no generator', async () => {
    const input = assembly([{ name: SDK_SECTION, text: TS_TEXT }])
    expect(await applySdkSection(input, sdkSchemas([SEARCH], () => ({ type: 'string' })), {})).toBe(input)
  })

  it('renders with the generator the installed harness exports', async () => {
    const result = await applySdkSection(assembly([{ name: SDK_SECTION, text: TS_TEXT }]), sdkSchemas([SEARCH], () => ({ type: 'string' })))
    const text = result.sections[0]?.text ?? ''
    expect(text).toContain('interface ToolArgsMap')
    expect(text).toContain('tool_search')
    expect(text).not.toContain('echo_test')
  })
})

describe('PTC_MANIFEST_HEADER', () => {
  it('names the transport and the in-program bridge calls', () => {
    expect(PTC_MANIFEST_HEADER).toContain('run_code')
    expect(PTC_MANIFEST_HEADER).toContain('tools.tool_search')
    expect(PTC_MANIFEST_HEADER).toContain('tools.tool_describe')
  })
})
