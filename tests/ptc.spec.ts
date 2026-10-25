import { describe, expect, it } from 'vitest'
import { isPtcOnlyAssembly } from '../src/ptc.ts'

function sections(text: string): { sections: { name: string; text: string }[] } {
  return { sections: [{ name: 'tools:ptc-only', text }] }
}

describe('isPtcOnlyAssembly', () => {
  it('recognizes a scope whose collapse section carries the rule', () => {
    expect(isPtcOnlyAssembly(sections('`run_code` is the only tool you can call directly'))).toBe(true)
  })

  it('treats an empty collapse section as native or both', () => {
    expect(isPtcOnlyAssembly(sections(''))).toBe(false)
    expect(isPtcOnlyAssembly({ sections: [] })).toBe(false)
  })
})
