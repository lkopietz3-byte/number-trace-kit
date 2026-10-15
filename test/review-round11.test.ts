import { describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'
import type { NumberToken, TraceOptions } from '../src/index.js'

// Regression rows from the whole-branch review of the 0.1.0 release (70c6450..7152d68). Each row names its finding
// and was seen failing before its fix.

type Evidence = Parameters<typeof traceNumbers>[1]
type Output = Parameters<typeof traceNumbers>[0]
const trace = (output: Output, evidence: Evidence, options?: TraceOptions): ReturnType<typeof traceNumbers> =>
  traceNumbers(output, evidence, options)

/** CPU seconds spent running `fn` (best of a few runs, to damp scheduler noise). */
function cpu(fn: () => void, runs = 3): number {
  let best = Infinity
  for (let i = 0; i < runs; i++) {
    const before = process.cpuUsage()
    fn()
    const used = process.cpuUsage(before)
    best = Math.min(best, (used.user + used.system) / 1e6)
  }
  return best
}

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
    const small = run(2_000)
    const large = run(8_000)
    small()
    large()
    // 4x the tokens: about 4x the time when linear, about 16x when every pair is visited.
    const growth = cpu(large, 3) / Math.max(cpu(small, 3), 0.01)
    expect(growth).toBeLessThan(9)
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
    const small = run(2_000)
    const large = run(8_000)
    small()
    large()
    const growth = cpu(large, 3) / Math.max(cpu(small, 3), 0.01)
    expect(growth).toBeLessThan(9)
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
