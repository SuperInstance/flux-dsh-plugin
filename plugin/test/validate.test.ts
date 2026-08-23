import { describe, it, expect } from 'vitest'
import { validateFluxExecArgs } from '../src/index.ts'

describe('validateFluxExecArgs (cross-field rules the schema DSL cannot express)', () => {
  it('accepts source-only', () => {
    expect(validateFluxExecArgs({ source: 'factorial of 5' })).toEqual([])
  })
  it('accepts path-only', () => {
    expect(validateFluxExecArgs({ path: '/tmp/s.md' })).toEqual([])
  })
  it('rejects both source and path (XOR violation)', () => {
    expect(validateFluxExecArgs({ source: 'x', path: '/tmp/s.md' })[0]).toMatch(/exactly one/)
  })
  it('rejects neither', () => {
    expect(validateFluxExecArgs({})[0]).toMatch(/exactly one/)
  })
  it('rejects empty strings', () => {
    expect(validateFluxExecArgs({ source: '' })[0]).toMatch(/exactly one/)
  })
  it('rejects non-positive timeoutMs', () => {
    expect(validateFluxExecArgs({ source: 'x', timeoutMs: 0 })[0]).toMatch(/timeoutMs/)
    expect(validateFluxExecArgs({ source: 'x', timeoutMs: -5 })[0]).toMatch(/timeoutMs/)
    expect(validateFluxExecArgs({ source: 'x', timeoutMs: NaN })[0]).toMatch(/timeoutMs/)
  })
  it('accepts valid timeoutMs', () => {
    expect(validateFluxExecArgs({ source: 'x', timeoutMs: 500 })).toEqual([])
  })
  it('rejects non-positive maxCycles', () => {
    expect(validateFluxExecArgs({ source: 'x', maxCycles: 0 })[0]).toMatch(/maxCycles/)
  })
  it('tolerates unknown types without crashing (registry pre-validates types)', () => {
    // Values arrive typed after defineTool validation, but the guard must not throw.
    expect(Array.isArray(validateFluxExecArgs({ source: 42 as never }))).toBe(true)
  })
})
