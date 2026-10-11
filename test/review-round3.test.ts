import { describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'
import type { TraceOptions, TraceResult } from '../src/index.js'

// Regression rows from the third independent review (c9684f4).

function t(output: string, evidence: Parameters<typeof traceNumbers>[1], options?: TraceOptions): TraceResult {
  return traceNumbers(output, evidence, options)
}

describe('version identifiers are consumed whole', () => {
  it('build and prerelease suffixes are not numbers', () => {
    expect(extractNumbers('v1.2.3+4')).toEqual([])
    expect(t('v1.2.3+4', '').verdict).toBe('clean')
    for (const text of ['1.2.3-rc.1', 'v1.2.3-beta.2+build.5', '2.0.0-rc.1+20130313144700', 'v1.2-rc1', 'Release 1.2.3+4 shipped']) {
      expect(extractNumbers(text.replace('Release ', '').replace(' shipped', '')), text).toEqual([])
    }
    expect(extractNumbers('Release 1.2.3+4 shipped')).toEqual([])
  })

  it('the digits of an evidence version are weak evidence', () => {
    expect(t('4', 'v1.2.3+4').numbers[0]).toMatchObject({ status: 'unknown', reason: 'ambiguous-reading' })
    expect(t('1', '1.2.3-rc.1').numbers[0]?.status).toBe('unknown')
    expect(t('99', 'v1.2.3+4').numbers[0]?.status).toBe('untraced')
  })

  it('ordinary hyphens and plus signs after other identifiers are unchanged', () => {
    expect(extractNumbers('X3-5 kg').map((x) => x.value)).toEqual(['5'])
    expect(extractNumbers('COVID-19 and 5').map((x) => x.value)).toEqual(['5'])
    expect(extractNumbers('x86+5').map((x) => x.value)).toEqual(['5'])
  })
})

describe('a scientific exponent is not a shared magnitude', () => {
  it('stays on its own endpoint', () => {
    expect(extractNumbers('1e3–2000 kg').map((x) => [x.value, x.unit])).toEqual([['1000', 'kg'], ['2000', 'kg']])
    expect(t('1e3–2000 kg', '1000 kg; 2000 kg').verdict).toBe('clean')
    expect(extractNumbers('1e0-5 million').map((x) => x.value)).toEqual(['1', '5000000'])
    expect(extractNumbers('2-1e3').map((x) => x.value)).toEqual(['2', '1000'])
    // A real magnitude is still shared.
    expect(extractNumbers('1-2 million').map((x) => x.value)).toEqual(['1000000', '2000000'])
  })
})

describe('derivations follow the one-sided unit policy', () => {
  it('a unit on only one side still derives, marked unverified', () => {
    const a = t('7 kg', '3 and 4', { derivations: ['sum'] })
    expect(a.numbers[0]).toMatchObject({ status: 'derived', unitUnverified: true })
    const b = t('7', '3 kg and 4 kg', { derivations: ['sum'] })
    expect(b.numbers[0]).toMatchObject({ status: 'derived', unitUnverified: true })
    // Operand units must still agree, and the output unit must not contradict them.
    expect(t('7', '3 kg and 4 days', { derivations: ['sum'] }).numbers[0]?.status).toBe('untraced')
    expect(t('7 days', '3 kg and 4 kg', { derivations: ['sum'] }).numbers[0]?.status).toBe('untraced')
    expect(t('7 kg', '3 kg and 4 kg', { derivations: ['sum'] }).numbers[0]).toMatchObject({ status: 'derived' })
    expect(t('7 kg', '3 kg and 4 kg', { derivations: ['sum'] }).numbers[0]?.unitUnverified).toBeUndefined()
  })

  it('a ratio is dimensionless and does not take a unit', () => {
    expect(t('0.8 kg', 'a 80 b 100', { derivations: ['ratio'] }).numbers[0]?.status).toBe('untraced')
    expect(t('0.8x', 'a 80 kg b 100 kg', { derivations: ['ratio'] }).numbers[0]?.status).toBe('derived')
  })

  it('bare-evidence derivation stays strictly unit-less', () => {
    expect(t('$7', '3 kg and 4 kg', { derivations: ['sum'], allowBareEvidence: true }).numbers[0]?.status).toBe('untraced')
    expect(t('$7', '3 and 4', { derivations: ['sum'], allowBareEvidence: true }).numbers[0]).toMatchObject({ status: 'derived', unitUnverified: true })
  })
})

describe('a shared magnitude moves the alternate readings too', () => {
  it('scales alternates and their precision with the primary', () => {
    const [first] = extractNumbers('1.234–2 million')
    expect(first).toMatchObject({ value: '1234000', ambiguous: true })
    expect(first?.alternates).toEqual([{ value: '1234000000', scale: -6 }])
    expect(t('1.234–2 million', '1234000000; 2000000').numbers[0]).toMatchObject({ status: 'unknown', reason: 'ambiguous-reading' })
  })
})

describe('ignorePattern must be a real RegExp', () => {
  it('rejects look-alike objects', () => {
    const spoof = { [Symbol.toStringTag]: 'RegExp', source: '.', flags: '' }
    expect(() => t('999', '', { ignorePattern: spoof as unknown as RegExp })).toThrow(TypeError)
    expect(() => t('999', '', { ignorePattern: Object.create(RegExp.prototype) as RegExp })).toThrow(TypeError)
    expect(() => t('999', '', { ignorePattern: RegExp.prototype })).toThrow(TypeError)
    expect(() => t('999', '', { ignorePattern: new Proxy(/9/, {}) })).toThrow(TypeError)
  })

  it('still accepts real ones, including a subclass with overridden properties', () => {
    expect(t('999', '', { ignorePattern: /9/ }).numbers[0]?.status).toBe('ignored')
    class Sub extends RegExp {}
    expect(t('999', '', { ignorePattern: new Sub('9') }).numbers[0]?.status).toBe('ignored')
    const odd = /nothing/
    Object.defineProperty(odd, 'source', { value: '.' })
    Object.defineProperty(odd, 'flags', { value: 'g' })
    expect(t('999', '', { ignorePattern: odd }).numbers[0]?.status).toBe('untraced')
  })
})

describe('canonically equivalent Latin letters agree', () => {
  it('the Kelvin and Angstrom signs behave like K and Å', () => {
    expect(t('3', 'K3').numbers[0]?.status).toBe('unknown')
    expect(t('3', 'K3').numbers[0]?.status).toBe('unknown')
    expect(t('3', 'Å3').numbers[0]?.status).toBe('unknown')
    expect(t('3', 'Å3').numbers[0]?.status).toBe('unknown')
    expect(extractNumbers('K3 and Å3')).toEqual([])
    expect(extractNumbers('5K')).toHaveLength(1) // 5K, a magnitude letter
    expect(extractNumbers('5K')[0]).toMatchObject({ value: '5000', ambiguity: 'suffix' })
    // Offsets and raw text still point at the original characters.
    const [tok] = extractNumbers('x 5K y')
    expect(tok?.raw).toBe('5K')
  })
})
