import { describe, expect, it } from 'vitest'
import { traceNumbers } from '../src/index.js'
import type { TraceOptions, TraceResult } from '../src/index.js'

// Averages and three-operand sums and differences. Cases are paraphrased,
// synthetic figures.

function t(output: string, evidence: Parameters<typeof traceNumbers>[1], options?: TraceOptions): TraceResult {
  return traceNumbers(output, evidence, options)
}

const SALES = 'Q1 sales were $1,240.5 and Q2 sales were $1,380.7.'

describe('average', () => {
  it('the mean of two evidence numbers, in the same unit', () => {
    const r = t('The two quarters averaged $1,310.6.', SALES, { derivations: ['average'] })
    expect(r.numbers[0]).toMatchObject({ status: 'derived', derivation: { kind: 'average', exact: true, matches: 1 } })
    expect(r.numbers[0]?.derivation?.operands.map((o) => o.raw)).toEqual(['$1,240.5', '$1,380.7'])
    expect(r.verdict).toBe('clean')
  })

  it('is off unless asked for, and 2-operand sums stay what they were', () => {
    expect(t('The two quarters averaged $1,310.6.', SALES).numbers[0]?.status).toBe('untraced')
    expect(t('The two quarters averaged $1,310.6.', SALES, { derivations: ['sum', 'difference', 'ratio', 'percent-change', 'percent-of'] }).numbers[0]?.status).toBe('untraced')
    expect(t('Together $2,621.2.', SALES, { derivations: ['sum'] }).numbers[0]?.status).toBe('derived')
  })

  it('matches after display rounding, like a ratio', () => {
    // (1 + 4) / 2 = 2.5: shown as 3 (half-up) or 2 (half-even).
    const e = 'a 1 and 4'
    const d = ['average'] as const
    expect(t('Average 3.', e, { derivations: [...d] }).numbers[0]).toMatchObject({ status: 'derived', derivation: { exact: false, rounding: 'half-up' } })
    expect(t('Average 2.', e, { derivations: [...d] }).numbers[0]).toMatchObject({ status: 'derived', derivation: { exact: false, rounding: 'half-even' } })
    expect(t('Average 2.', e, { derivations: [...d], rounding: ['half-up'] }).numbers[0]?.status).toBe('untraced')
    expect(t('Average 2.5.', e, { derivations: [...d], rounding: [] }).numbers[0]).toMatchObject({ status: 'derived', derivation: { exact: true } })
    expect(t('Average 3.', e, { derivations: [...d], rounding: [] }).numbers[0]?.status).toBe('untraced')
  })

  it('needs operands in the same class and unit, and is symmetric', () => {
    expect(t('Average 3.5.', 'a 3 kg and 4 days', { derivations: ['average'] }).numbers[0]?.status).toBe('untraced')
    expect(t('Average 35%.', 'a 30% and 40%', { derivations: ['average'] }).numbers[0]?.status).toBe('derived')
    expect(t('Average 35.', 'a 30% and 40%', { derivations: ['average'] }).numbers[0]?.status).toBe('untraced')
    expect(t('Average 1310.6.', 'x $1,380.7 then $1,240.5', { derivations: ['average'] }).numbers[0]?.status).toBe('untraced') // currency vs plain
    expect(t('Average $1,310.6.', 'x $1,380.7 then $1,240.5', { derivations: ['average'] }).numbers[0]?.status).toBe('derived')
  })

  it('a different mean is untraced', () => {
    expect(t('The quarters averaged $1,311.6.', SALES, { derivations: ['average'] }).numbers[0]?.status).toBe('untraced')
  })
})

describe('three operands, opt-in', () => {
  const PARTS = 'Segments: 10,248 north, 10,468 east and 3,535 west, plus 77 other.'

  it('a three-figure sum', () => {
    const r = t('The three segments add up to 24,251.', PARTS, { derivations: ['sum'], maxOperands: 3 })
    expect(r.numbers[0]).toMatchObject({ status: 'derived', derivation: { kind: 'sum', exact: true } })
    expect(r.numbers[0]?.derivation?.operands).toHaveLength(3)
  })

  it('does nothing unless maxOperands is 3, so every 2-operand verdict is unchanged', () => {
    expect(t('The three segments add up to 24,251.', PARTS, { derivations: ['sum'] }).numbers[0]?.status).toBe('untraced')
    expect(t('The three segments add up to 24,251.', PARTS, { derivations: ['sum'], maxOperands: 2 }).numbers[0]?.status).toBe('untraced')
    const base = t('Pair sum 20,716.', PARTS, { derivations: ['sum'] })
    const wide = t('Pair sum 20,716.', PARTS, { derivations: ['sum'], maxOperands: 3 })
    expect(wide.numbers[0]?.status).toBe(base.numbers[0]?.status)
    expect(wide.numbers[0]?.derivation?.operands).toHaveLength(2)
  })

  it('a difference over three: one figure less the other two', () => {
    const r = t('That leaves 45.', 'Total 100, of which 30 is rent and 25 is food.', { derivations: ['difference'], maxOperands: 3 })
    expect(r.numbers[0]).toMatchObject({ status: 'derived', derivation: { kind: 'difference', exact: true } })
    expect(r.numbers[0]?.derivation?.operands).toHaveLength(3)
    expect(t('That leaves 45.', 'Total 100, of which 30 is rent and 25 is food.', { derivations: ['difference'] }).numbers[0]?.status).toBe('untraced')
    // The sign follows the arithmetic: 30 - 100 - 25 is -95.
    expect(t('Net -95.', 'Total 100, of which 30 is rent and 25 is food.', { derivations: ['difference'], maxOperands: 3 }).numbers[0]?.status).toBe('derived')
    expect(t('Net -45.', 'Total 100, of which 30 is rent and 25 is food.', { derivations: ['difference'], maxOperands: 3 }).numbers[0]?.status).toBe('untraced')
  })

  it('an average of three, matched after display rounding', () => {
    const e = 'Years: 10, 20 and 40.'
    expect(t('Average 23.3.', e, { derivations: ['average'], maxOperands: 3 }).numbers[0]).toMatchObject({
      status: 'derived', derivation: { kind: 'average', exact: false, rounding: 'either' },
    })
    expect(t('Average 23.3.', e, { derivations: ['average'] }).numbers[0]?.status).toBe('untraced')
    // The pair means are still found at maxOperands 3.
    expect(t('Average 15.', e, { derivations: ['average'], maxOperands: 3 }).numbers[0]?.status).toBe('derived')
  })

  it('operands share one class and unit', () => {
    expect(t('Total 60.', 'a $10, b $20, c 30', { derivations: ['sum'], maxOperands: 3 }).numbers[0]?.status).toBe('untraced')
    expect(t('Total $60.', 'a $10, b $20, c $30', { derivations: ['sum'], maxOperands: 3 }).numbers[0]?.status).toBe('derived')
  })

  it('counts candidates before running and stays unknown past the cap', () => {
    const evidence = Array.from({ length: 12 }, (_, i) => `n${i} ${i * 101 + 3000}`).join('; ')
    // 12 operands: 66 pairs + 220 triples; a sum is one candidate each.
    const ok = t('x 1000', evidence, { derivations: ['sum'], maxOperands: 3, maxCandidates: 286 })
    expect(ok.candidateCapHit).toBe(false)
    expect(ok.derivationCandidates).toBe(286)
    const over = t('Sum 99999.', evidence, { derivations: ['sum'], maxOperands: 3, maxCandidates: 285 })
    expect(over.candidateCapHit).toBe(true)
    expect(over.derivationCandidates).toBe(0)
    expect(over.numbers[0]).toMatchObject({ status: 'unknown', reason: 'candidate-cap' })
    // The same evidence with pairs only fits easily.
    expect(t('Sum 99999.', evidence, { derivations: ['sum'], maxCandidates: 285 }).candidateCapHit).toBe(false)
  })

  it('the search is bounded in time at the cap', () => {
    const evidence = Array.from({ length: 40 }, (_, i) => `n${i} ${i * 137 + 2000}.${i % 10}`).join('; ')
    const before = process.cpuUsage()
    const r = t('Sum 1234567.', evidence, { derivations: ['sum', 'difference', 'average'], maxOperands: 3, maxCandidates: 200_000 })
    const used = process.cpuUsage(before)
    expect(r.derivationCandidates).toBeLessThanOrEqual(200_000)
    expect((used.user + used.system) / 1e3).toBeLessThan(20_000)
  })

  it('validates the option', () => {
    expect(() => t('1', 'x', { maxOperands: 4 as never })).toThrow(RangeError)
    expect(() => t('1', 'x', { maxOperands: 1 as never })).toThrow(RangeError)
    expect(() => t('1', 'x', { maxOperands: 2.5 as never })).toThrow(TypeError)
    expect(() => t('1', 'x', { derivations: ['mean' as never] })).toThrow(RangeError)
  })

  it('direction rules are unchanged for pairs', () => {
    const d = ['percent-change'] as const
    expect(t('25%', 'from 80 to 100', { derivations: [...d], maxOperands: 3 }).numbers[0]?.status).toBe('derived')
    expect(t('25%', 'to 100 from 80', { derivations: [...d], maxOperands: 3 }).numbers[0]?.status).toBe('unknown')
  })
})
