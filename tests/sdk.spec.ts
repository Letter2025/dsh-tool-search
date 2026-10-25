import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { applySdkSection, PTC_MANIFEST_HEADER, SDK_SECTION, sdkSchemas } from '../src/sdk.ts'

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
  it('re-renders a TypeScript section with only the declared tools', () => {
    const input = assembly([{ name: SDK_SECTION, text: TS_TEXT }])
    const result = applySdkSection(input, sdkSchemas([SEARCH], () => ({ type: 'string' })))
    const text = result.sections[0]?.text ?? ''
    expect(text).toContain('tool_search')
    expect(text).not.toContain('echo_test')
    expect(text).toContain('interface ToolArgsMap')
  })

  it('re-renders a Python section with the Python generator', () => {
    const result = applySdkSection(assembly([{ name: SDK_SECTION, text: PY_TEXT }]), sdkSchemas([SEARCH], () => ({ type: 'string' })))
    const text = result.sections[0]?.text ?? ''
    expect(text).toContain('TypedDict')
    expect(text).toContain('tool_search')
  })

  it('leaves a section from an unknown generator untouched', () => {
    const input = assembly([{ name: SDK_SECTION, text: '## Generated declarations' }])
    expect(applySdkSection(input, [])).toBe(input)
  })

  it('leaves an assembly without the section untouched', () => {
    const input = assembly([{ name: 'tools:ptc-only', text: 'only run_code is callable' }])
    expect(applySdkSection(input, [])).toBe(input)
  })
})

describe('PTC_MANIFEST_HEADER', () => {
  it('names the transport and the in-program bridge calls', () => {
    expect(PTC_MANIFEST_HEADER).toContain('run_code')
    expect(PTC_MANIFEST_HEADER).toContain('tools.tool_search')
    expect(PTC_MANIFEST_HEADER).toContain('tools.tool_describe')
  })
})

describe('generator resolution', () => {
  // A static import of a named export that the running harness does not
  // publish aborts the whole plugin load before `apply()` runs, which the
  // loader reports as an enabled entry that never reaches a fiber phase. The
  // generators moved packages in harness 0.2.1-rc.3, so the module must not
  // name either specifier in an import declaration.
  it('imports the generators dynamically instead of statically', () => {
    const source = readFileSync(new URL('../src/sdk.ts', import.meta.url), 'utf8')
    // `import type` is erased at compile time and cannot fail a load.
    const valueImports = [...source.matchAll(/^import\s+(?!type\s)[^\n]*from\s+'([^']+)'/gm)].map(match => match[1])
    expect(valueImports).not.toContain('@deepseek-ai/dsh-tools')
    expect(valueImports).not.toContain('@deepseek-ai/dsh-tool-executor-ptc')
    expect(source).toContain("'@deepseek-ai/dsh-tool-executor-ptc'")
    expect(source).toContain("'@deepseek-ai/dsh-tools'")
  })
})
