import { describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'
import type { NumberToken, TraceOptions } from '../src/index.js'
import { BENCH203_CONFIGS } from '../bench/lib/bench203.mjs'
import { GROWTH_LIMIT, growthRatio } from './growth.js'

// Regression rows from the whole-branch review of the 0.1.0 release (70c6450..7152d68). Each row names its finding
// and was seen failing before its fix.

type Evidence = Parameters<typeof traceNumbers>[1]
type Output = Parameters<typeof traceNumbers>[0]
const trace = (output: Output, evidence: Evidence, options?: TraceOptions): ReturnType<typeof traceNumbers> =>
  traceNumbers(output, evidence, options)

describe('release-review:P1-pair-iteration candidate generation visits only compatible pairs', { timeout: 120_000 }, () => {
  const base = extractNumbers('12 kg')[0] as NumberToken
  // n caller tokens, each with its own unit: no two can pair, so the candidate count is zero.
  const distinctUnits = (n: number): NumberToken[] =>
    Array.from({ length: n }, (_, i) => ({ ...base, unit: `u${i}`, raw: `${i + 1} u${i}`, value: String(i + 1) }))

  it.each([
    ['sum', ['sum'] as const],
    ['every derivation', ['sum', 'difference', 'ratio', 'percent-change', 'percent-of', 'average', 'product'] as const],
  ])('release-review:P1-pair-iteration %s over tokens that never combine grows linearly, not with the number of pairs', (_name, derivations) => {
    const options = { derivations: [...derivations], maxCandidates: 1000 } satisfies TraceOptions
    const run = (n: number): (() => void) => {
      const tokens = distinctUnits(n)
      return () => {
        const r = trace('1 kg', tokens, options)
        expect(r.derivationCandidates).toBe(0)
        expect(r.candidateCapHit).toBe(false)
      }
    }
    // 8x the tokens: about 8x the time when linear, about 64x when every pair is visited.
    expect(growthRatio(run, 2_000)).toBeLessThan(GROWTH_LIMIT)
  })

  it('release-review:P1-pair-iteration three-operand candidates are listed from their group, not searched for in every pair', () => {
    const options = { derivations: ['sum'], maxOperands: 3, maxCandidates: 1_000_000 } satisfies TraceOptions
    const run = (n: number): (() => void) => {
      // a group of 60 that does combine, hidden among n tokens that cannot
      const same = Array.from({ length: 60 }, (_, i) => ({ ...base, unit: 'kg', raw: `${i + 1} kg`, value: String(i + 1) }))
      const tokens = [...same, ...distinctUnits(n)]
      return () => {
        const r = trace('1 kg', tokens, options)
        expect(r.derivationCandidates).toBe(60 * 59 / 2 + 60 * 59 * 58 / 6)
      }
    }
    expect(growthRatio(run, 2_000)).toBeLessThan(GROWTH_LIMIT)
  })
})

describe('release-review:P2-skipped-span a sign or currency before an unread form is part of that form', () => {
  it.each([
    ['-2h45m', '2h45m'],
    ['+2h45m', '2h45m'],
    ['$500foo', '500foo'],
    ['€12abc', '12abc'],
    ['-12foo', '12foo'],
    ['-1_5', '1_5'],
    ['$1_5', '1_5'],
    ['-⅓', '⅓'],
    ['-2⅔', '2⅔'],
    ['%12foo', '12foo'],
  ])('release-review:P2-skipped-span %s against %s is unknown in both sign modes', (output, evidence) => {
    for (const signMode of ['explicit', 'strict'] as const) {
      const r = trace(output, evidence, { signMode })
      expect(r.verdict, signMode).toBe('unknown')
      expect(r.skipped[0]?.reason, signMode).toBe('unread-glued-form')
      expect(r.skipped[0]?.raw, signMode).toBe(output)
    }
  })

  it.each([
    ['-2h45m', 'The run took -2h45m.'],
    ['$500foo', 'Code $500foo shipped.'],
    ['-⅓', 'Change of -⅓ noted.'],
    ['%12foo', 'Label %12foo here.'],
  ])('release-review:P2-skipped-span the same signed form in the evidence still vouches for it: %s', (output, evidence) => {
    const r = trace(output, evidence, { signMode: 'strict' })
    expect(r.verdict).toBe('clean')
    expect(r.skipped[0]?.reason).toBe('in-evidence')
  })

  it('release-review:P2-skipped-span a name keeps only its own characters: a sign before 5G is not part of the name', () => {
    const r = trace('a -5G network', 'The 5G network.', { checkIdentifiers: true })
    expect(r.skipped[0]?.raw).toBe('5G')
    expect(r.verdict).toBe('clean')
  })
})

describe('release-review:P2-rate-rounding the rate leniency reaches rounded matches', () => {
  it.each([
    ['$29/month', '$28.99'],
    ['8% per year', '7.96%'],
    ['€29 per month', '€28.99'],
    ['$29/month', 'The plan costs $28.99 today.'],
    ['5% a year', 'Growth was 4.96%.'],
  ])('release-review:P2-rate-rounding %s traces by rounding to %s', (output, evidence) => {
    const r = trace(output, evidence)
    expect(r.verdict).toBe('clean')
    expect(r.numbers[0]?.status).toBe('rounded')
    expect(r.numbers[0]?.unitUnverified).toBeUndefined()
  })

  it.each([
    ['$29/month', '$28.99/year'],
    ['8% per year', '7.96% per month'],
    ['$29/month', '$28.99/month/seat'],
    ['$30/month', '$28.99'],
    ['-$29/month', '$28.99'],
    ['$29/month', '28.99'],
    ['$28.99/month', '$29'],
  ])('release-review:P2-rate-rounding %s still does not match %s', (output, evidence) => {
    const r = trace(output, evidence, { signMode: 'strict' })
    expect(r.verdict).not.toBe('clean')
    expect(r.numbers[0]?.status).not.toBe('traced')
    expect(r.numbers[0]?.status).not.toBe('rounded')
  })

  it('release-review:P2-rate-rounding a rated figure the evidence writes with its own rate is still matched by that rate', () => {
    const r = trace('$29/month', '$28.99/month')
    expect(r.verdict).toBe('clean')
    expect(r.numbers[0]?.status).toBe('rounded')
  })
})

describe('release-review:P2-wildcard-cap a bare number is looked up by its exact unit-less key before the capped wildcard list', () => {
  const eight = '7 kg '.repeat(8)
  const eightRounded = '7.04 kg '.repeat(8)

  it.each([
    ['7', eight + '7'],
    ['7', '7 kg '.repeat(20) + 'Rating 7'],
    ['7.0', eightRounded + '7.04'],
    ['7', '7 m '.repeat(8) + '7 kg ' + '7'],
  ])('release-review:P2-wildcard-cap %s traces to the bare figure after many unit figures', (output, evidence) => {
    const r = trace(output, evidence)
    expect(r.verdict).toBe('clean')
    expect(r.numbers[0]?.unitUnverified).toBeUndefined()
  })

  it('release-review:P2-wildcard-cap the verdict does not depend on the order of the evidence', () => {
    const first = trace('7', '7 ' + '7 kg '.repeat(8))
    const last = trace('7', eight + '7')
    expect(last.verdict).toBe(first.verdict)
    expect(last.numbers[0]?.status).toBe(first.numbers[0]?.status)
  })

  it('release-review:P2-wildcard-cap a bare 7 with only unit figures behind it is still unknown, never traced', () => {
    const r = trace('7', eight)
    expect(r.numbers[0]).toMatchObject({ status: 'unknown', reason: 'unit-unverified' })
  })

  it('release-review:P2-wildcard-cap a unit figure is still not cleared by a bare one', () => {
    const r = trace('7 kg', '7 m '.repeat(8) + '7')
    expect(r.numbers[0]?.status).toBe('unknown')
  })
})

describe('release-review:P2-bench-report the benchmark labeled report measures the shipped report preset', () => {
  it('release-review:P2-bench-report the report configuration is the preset alone, with no derivation override', () => {
    expect(BENCH203_CONFIGS['report']).toEqual({ preset: 'report' })
  })

  it('release-review:P2-bench-report the report configuration turns on average and product, as the preset does', () => {
    const items = [
      { evidence: 'Q1 revenue was $120. Q2 revenue was $180.', output: 'Average quarterly revenue was $150.' },
      { evidence: 'Each seat costs $12. The team has 5 seats.', output: 'The seats cost $60 in total.' },
    ]
    for (const { evidence, output } of items) {
      const viaBench = traceNumbers(output, evidence, BENCH203_CONFIGS['report'] as TraceOptions)
      const viaPreset = traceNumbers(output, evidence, { preset: 'report' })
      expect(viaBench.verdict).toBe('clean')
      expect(viaBench.numbers.map((n) => n.status)).toEqual(viaPreset.numbers.map((n) => n.status))
    }
  })
})

describe('release-review:F1-rate-bucket-cap an unrated figure is not hidden by many figures of another rate', () => {
  const many = (text: string): string => `${text} `.repeat(8)

  it.each([
    // rounded: the rated output reads the unrated evidence
    ['$29/month', many('$28.99/year') + '$28.99', 'rounded'],
    ['8% per year', many('7.96% per month') + '7.96%', 'rounded'],
    ['€29 per month', many('€28.99/year') + '€28.99', 'rounded'],
    ['$29/month', many('$28.99/year') + 'The plan costs $28.99 today.', 'rounded'],
    ['$29/month', '$28.99/year '.repeat(30) + '$28.99', 'rounded'],
    // exact: the same shape of evidence one step earlier in the lookup
    ['$29/month', many('$29/year') + '$29', 'traced'],
    ['8% per year', many('8% per month') + '8%', 'traced'],
    ['2 pp per year', many('2 pp per month') + '2 pp', 'traced'],
  ])('release-review:F1-rate-bucket-cap %s traces to the unrated figure behind many rated ones', (output, evidence, status) => {
    const r = trace(output, evidence)
    expect(r.verdict).toBe('clean')
    expect(r.numbers[0]?.status).toBe(status)
  })

  it.each([
    ['$29/month', '$28.99', '$28.99/year'],
    ['8% per year', '7.96%', '7.96% per month'],
  ])('release-review:F1-rate-bucket-cap the verdict does not depend on the order of the evidence: %s', (output, bare, rated) => {
    const first = trace(output, `${bare} ${many(rated)}`)
    const last = trace(output, `${many(rated)}${bare}`)
    expect(first.verdict).toBe('clean')
    expect(last.verdict).toBe(first.verdict)
    expect(last.numbers[0]?.status).toBe(first.numbers[0]?.status)
  })

  it.each([
    ['$29/month', many('$28.99/year')],
    ['$29/month', many('$28.99/year') + '$30'],
    ['8% per year', many('7.96% per month')],
    ['$29/month', many('$28.99/year') + '$28.99/month/seat'],
  ])('release-review:F1-rate-bucket-cap %s is still not cleared by rated figures of another rate alone', (output, evidence) => {
    const r = trace(output, evidence)
    expect(r.verdict).not.toBe('clean')
    expect(r.numbers[0]?.status).not.toBe('traced')
    expect(r.numbers[0]?.status).not.toBe('rounded')
  })

  it('release-review:F1-rate-bucket-cap an unrated output still finds its figure among rated ones', () => {
    for (const evidence of [many('$28.99/year') + '$28.99', '$28.99 ' + many('$28.99/year'), many('$28.99/year')]) {
      const r = trace('$29', evidence)
      expect(r.verdict).toBe('clean')
    }
  })
})
