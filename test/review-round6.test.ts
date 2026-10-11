import { describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'
import type { TraceOptions, TraceResult } from '../src/index.js'

// Regression rows from the sixth independent review (34140c5..8b4e8cf).

function t(output: string, evidence: Parameters<typeof traceNumbers>[1], options?: TraceOptions): TraceResult {
  return traceNumbers(output, evidence, options)
}

describe('a range separator before a leading decimal', () => {
  it('joins the endpoints like any other range', () => {
    for (const text of ['.5–.7%', '.5-.7%', '.5 to .7%', '.5 – .7%']) {
      const tokens = extractNumbers(text)
      expect(tokens.map((x) => [x.value, x.kind, x.range]), text).toEqual([['0.5', 'percent', 'start'], ['0.7', 'percent', 'end']])
    }
    expect(t('.5–.7%', '0.5 and 7%').verdict).toBe('untraced')
    expect(t('.5–.7%', '0.5% and 0.7%').verdict).toBe('clean')
    expect(extractNumbers('$.5-.7M').map((x) => [x.value, x.currency])).toEqual([['500000', 'USD'], ['700000', 'USD']])
  })
})

describe('lookahead sees a leading decimal', () => {
  it('a currency prefix and a dimension operator stay intact', () => {
    expect(extractNumbers('5 $.99').map((x) => [x.value, x.kind])).toEqual([['5', 'count'], ['0.99', 'currency']])
    expect(t('5 $.99', '$5 and 0.99').verdict).toBe('untraced')
    expect(t('5 $.99', '5 and $0.99').verdict).toBe('clean')
    expect(extractNumbers('.5 x .7 cm').map((x) => [x.value, x.unit])).toEqual([['0.5', 'cm'], ['0.7', 'cm']])
    expect(extractNumbers('.5x.7 cm').map((x) => [x.value, x.unit])).toEqual([['0.5', 'cm'], ['0.7', 'cm']])
    expect(extractNumbers('5 x .7 cm').map((x) => [x.value, x.unit])).toEqual([['5', 'cm'], ['0.7', 'cm']])
    expect(extractNumbers('10 x faster')[0]).toMatchObject({ unit: 'x' })
    expect(extractNumbers('0x1F')).toEqual([])
  })
})

describe('an exact zero is sign-neutral in derivations', () => {
  it('-0% is the sum of 1% and -1%, but a tiny positive value does not become a negative zero', () => {
    expect(t('-0%', '1%; -1%', { derivations: ['sum'] }).numbers[0]).toMatchObject({ status: 'derived', derivation: { exact: true } })
    expect(t('-0%', '1%; -1%', { derivations: ['sum'] }).numbers[0]?.signDiffers).toBeUndefined()
    expect(t('0%', '1%; -1%', { derivations: ['sum'] }).numbers[0]?.status).toBe('derived')
    // The mean 0.005 rounds to 0.0, but it is positive: an explicit minus does not match it.
    expect(t('-0.0%', '0.07%; -0.06%', { derivations: ['average'] }).numbers[0]?.status).toBe('untraced')
    expect(t('0.0%', '0.07%; -0.06%', { derivations: ['average'] }).numbers[0]).toMatchObject({ status: 'derived' })
    // The mean -0.005 is negative: it matches -0.0 and, with the sign dropped, 0.0.
    expect(t('-0.0%', '0.06%; -0.07%', { derivations: ['average'] }).numbers[0]).toMatchObject({ status: 'derived' })
    expect(t('0.0%', '0.06%; -0.07%', { derivations: ['average'] }).numbers[0]).toMatchObject({ status: 'derived', signDiffers: true })
  })
})

describe('zero signs do not inflate the search', () => {
  it('0 and -0 are one operand value', () => {
    const r = t('Total 99999', '0% 0% -0% -0% 1%', { derivations: ['sum'], maxCandidates: 5 })
    expect(r.candidateCapHit).toBe(false)
    expect(r.derivationCandidates).toBe(3)
  })
})

describe('signDiffers on a derivation that rounds to zero', () => {
  it('is suppressed only for an exactly zero derivation', () => {
    const r = t('0.0%', '-1.01%; 1.0%', { derivations: ['average'] })
    expect(r.numbers[0]).toMatchObject({ status: 'derived', signDiffers: true })
    expect(t('0%', '1%; -1%', { derivations: ['sum'] }).numbers[0]?.signDiffers).toBeUndefined()
    expect(t('0.0%', '1.0%; -1.0%', { derivations: ['average'] }).numbers[0]?.signDiffers).toBeUndefined()
  })
})
