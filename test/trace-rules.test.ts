import { describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'
import type { NumberTrace, TraceOptions, TraceResult } from '../src/index.js'

function trace(output: string, evidence: Parameters<typeof traceNumbers>[1], options?: TraceOptions): TraceResult {
  return traceNumbers(output, evidence, options)
}

function only(result: TraceResult): NumberTrace {
  expect(result.numbers).toHaveLength(1)
  const [n] = result.numbers
  if (n === undefined) throw new Error('unreachable')
  return n
}

describe('exact matching', () => {
  it('ignores formatting: separators, trailing zeros, leading zeros, magnitude words', () => {
    expect(only(trace('1,234.50', 'x 1234.5')).status).toBe('traced')
    expect(only(trace('1234', 'x 1,234.00')).status).toBe('traced')
    expect(only(trace('1.5 million', 'x 1,500,000')).status).toBe('traced')
    expect(only(trace('$2K', 'x $2,000')).status).toBe('traced')
    expect(only(trace('0.50', 'x .5')).status).toBe('traced') // ".5" is 0.5
    expect(only(trace('5', 'x .5')).status).toBe('untraced') // and it is not the number 5
  })

  it('cites every document that holds the number', () => {
    const r = trace('Total 42.', [
      { id: 'a', text: 'forty-two is 42' },
      { id: 'b', text: 'no number' },
      { id: 'c', text: 'Value: 42' },
    ])
    expect(only(r).evidence.map((e) => e.id)).toEqual(['a', 'c'])
    expect(only(r).evidence[0]).toMatchObject({ raw: '42', start: 13, end: 15 })
  })

  it('accepts evidence as pre-extracted tokens and mixes them with text', () => {
    const tokens = extractNumbers('Revenue 1,234.50')
    const r = trace('Revenue 1,234.50', [
      { id: 'doc', text: 'nothing numeric' },
      ...tokens.map((t) => ({ ...t, evidenceId: 'pre' })),
    ])
    expect(only(r)).toMatchObject({ status: 'traced' })
    expect(only(r).evidence[0]?.id).toBe('pre')
    // Tokens without an evidenceId get a positional id.
    const r2 = trace('42', tokens.concat(extractNumbers('42')))
    expect(only(r2).evidence[0]?.id).toBe('token:1')
  })

  it('accepts an output given as pre-extracted tokens', () => {
    const r = trace.call(null, '', 'x') // empty output, empty result
    expect(r.numbers).toEqual([])
    const out = traceNumbers(extractNumbers('Total 42 and 43.'), 'x 42')
    expect(out.numbers.map((n) => n.status)).toEqual(['traced', 'untraced'])
  })

  it('rejects malformed pre-extracted tokens', () => {
    const bad = { raw: '5', start: 0, end: 1, value: '5', scale: 0, kind: 'count' as const, ambiguous: false }
    expect(() => trace('5', [{ ...bad, value: '5e3' }])).toThrow(TypeError)
    expect(() => trace('5', [{ ...bad, kind: 'weird' } as never])).toThrow(TypeError)
    expect(() => trace('5', [{ ...bad, ambiguous: 'no' } as never])).toThrow(TypeError)
    expect(() => trace('5', [{ ...bad, scale: 1.5 }])).toThrow(TypeError)
    expect(() => trace('5', [{ ...bad, kind: 'currency' } as never])).toThrow(TypeError)
    expect(() => trace('5', [null as never])).toThrow(TypeError)
    expect(() => trace('5', [{ id: 5, text: '5' } as never])).toThrow(TypeError)
    expect(() => traceNumbers([{ ...bad, scale: -3 }] as never, 'x')).toThrow(TypeError) // value 5 does not fit scale -3
  })
})

describe('units and kinds must match', () => {
  it('percent only traces to percent, currency only to the same currency', () => {
    expect(only(trace('45%', 'x 45')).status).toBe('untraced')
    expect(only(trace('45%', 'x $45')).status).toBe('untraced')
    expect(only(trace('45%', 'x 45 pp')).status).toBe('untraced')
    expect(only(trace('$45', 'x 45%')).status).toBe('untraced')
    expect(only(trace('$45', 'x 45 EUR')).status).toBe('untraced')
    expect(only(trace('$45', 'x USD 45')).status).toBe('traced')
    expect(only(trace('45', 'x 45%')).status).toBe('untraced')
  })

  it('records why a near miss missed', () => {
    const r = only(trace('45%', 'x $45 and 45 pp'))
    expect(r.nearMisses?.map((m) => m.reason)).toEqual(['unit-differs', 'unit-differs'])
    expect(only(trace('-5', 'x 5')).nearMisses?.[0]?.reason).toBe('sign-differs')
    // A date traces as a whole date; its year alone is only a weak link.
    expect(trace('2026-10-10', 'x 2026').numbers.map((n) => n.status)).toEqual(['unknown', 'untraced', 'untraced'])
  })

  it('measurement units must agree when both sides have one', () => {
    expect(only(trace('3 days', 'x 3 weeks')).status).toBe('untraced')
    expect(only(trace('3 days', 'x 3 days')).status).toBe('traced')
    expect(only(trace('3 days', 'x 3 days')).unitUnverified).toBeUndefined()
    // One side with no recognized unit cannot be confirmed: unknown, never a pass (M6 false-pass:F09).
    expect(only(trace('3 days', 'x 3'))).toMatchObject({ status: 'unknown', reason: 'unit-unverified' })
    expect(only(trace('3', 'x 3 days'))).toMatchObject({ status: 'unknown', reason: 'unit-unverified' })
    expect(only(trace('5 kg', 'x 5kg')).status).toBe('traced')
  })

  it('a bare evidence number can vouch for a percent or amount only when asked', () => {
    expect(only(trace('$1,234.50', 'x 1,234.50')).status).toBe('untraced')
    const loose = only(trace('$1,234.50', 'x 1,234.50', { allowBareEvidence: true }))
    expect(loose).toMatchObject({ status: 'traced', unitUnverified: true })
    expect(only(trace('45%', 'x 45', { allowBareEvidence: true })).status).toBe('traced')
    // A bare option never lets a different unit through.
    expect(only(trace('45%', 'x $45', { allowBareEvidence: true })).status).toBe('untraced')
  })

  it('a year in a date traces a bare year, and a bare year traces a date year', () => {
    expect(only(trace('in 2026', 'due 2026-10-10')).status).toBe('traced')
    expect(trace('due 2026-10-10', 'in 2026').numbers.map((n) => n.status)).toEqual(['unknown', 'untraced', 'untraced'])
  })
})

describe('signs', () => {
  it('an explicit sign must agree, an unsigned output may drop one', () => {
    expect(only(trace('-5%', 'x -5%')).status).toBe('traced')
    expect(only(trace('-5%', 'x 5%')).status).toBe('untraced')
    expect(only(trace('+5%', 'x -5%')).status).toBe('untraced')
    expect(only(trace('+5%', 'x 5%')).status).toBe('traced')
    expect(only(trace('5%', 'x -5%'))).toMatchObject({ status: 'traced', signDiffers: true })
    expect(only(trace('5%', 'x 5%')).signDiffers).toBeUndefined()
  })

  it('prefers the same-sign evidence', () => {
    const r = only(trace('5', 'a -5 b 5'))
    expect(r.signDiffers).toBeUndefined()
    expect(r.evidence.map((e) => e.raw)).toEqual(['5'])
  })

  it('magnitude mode ignores signs, and parentheses count as soft signs', () => {
    expect(only(trace('-5%', 'x 5%', { signMode: 'magnitude' })).status).toBe('traced')
    expect(only(trace('(1,234)', 'x 1,234')).status).toBe('traced')
    expect(only(trace('1,234', 'x (1,234)'))).toMatchObject({ status: 'traced', signDiffers: true })
  })
})

describe('rounding', () => {
  it('rounds at the output precision only', () => {
    expect(only(trace('12.3%', 'x 12.34%')).status).toBe('rounded')
    expect(only(trace('12.4%', 'x 12.34%')).status).toBe('untraced')
    expect(only(trace('12.34%', 'x 12.3%')).status).toBe('untraced') // output more precise than evidence
    expect(only(trace('12.30%', 'x 12.3%')).status).toBe('traced')
    expect(only(trace('13%', 'x 12.34%')).status).toBe('untraced')
  })

  it('applies to magnitudes: 1.2M from 1,234,567 and 1.3M from 1,250,000 (tie)', () => {
    expect(only(trace('$1.2M', 'x $1,234,567')).status).toBe('rounded')
    expect(only(trace('$1.3M', 'x $1,250,000'))).toMatchObject({ status: 'rounded', rounding: 'half-up' })
    expect(only(trace('$1.2M', 'x $1,250,000'))).toMatchObject({ status: 'rounded', rounding: 'half-even' })
  })

  it('rounds the absolute value, so negatives behave the same', () => {
    expect(only(trace('-13%', 'x -12.5%'))).toMatchObject({ status: 'rounded', rounding: 'half-up' })
    expect(only(trace('-12%', 'x -12.5%'))).toMatchObject({ status: 'rounded', rounding: 'half-even' })
  })

  it('can be limited to one mode or turned off', () => {
    expect(only(trace('13%', 'x 12.5%', { rounding: ['half-even'] })).status).toBe('untraced')
    expect(only(trace('12%', 'x 12.5%', { rounding: ['half-even'] }))).toMatchObject({ status: 'rounded', rounding: 'half-even' })
    expect(only(trace('12.3%', 'x 12.34%', { rounding: [] })).status).toBe('untraced')
  })

  it('does not round across units', () => {
    expect(only(trace('12%', 'x 12.34')).status).toBe('untraced')
    expect(only(trace('$12', 'x 12.34%')).status).toBe('untraced')
  })
})

describe('derivations', () => {
  const ev = 'A $100.25, B $200.50, rate 7.5%, last year 80, this year 100.'

  it('are off unless asked for', () => {
    expect(only(trace('$300.75', ev)).status).toBe('untraced')
    expect(only(trace('$300.75', ev, { derivations: [] })).status).toBe('untraced')
  })

  it('sum and difference must match exactly', () => {
    expect(only(trace('$300.75', ev, { derivations: ['sum'] }))).toMatchObject({ status: 'derived', derivation: { kind: 'sum', exact: true, matches: 1 } })
    expect(only(trace('$100.25', ev, { derivations: ['difference'] })).status).toBe('traced') // direct match wins
    expect(only(trace('$100.25', 'x $300.75 y $200.50', { derivations: ['difference'] }))).toMatchObject({
      status: 'derived', derivation: { kind: 'difference' },
    })
    // Rounded sums are not accepted: any integer would match some sum.
    expect(only(trace('$301', ev, { derivations: ['sum'] })).status).toBe('untraced')
  })

  it('a sum needs both operands in the same unit', () => {
    expect(only(trace('107.75', 'a $100.25 b 7.5%', { derivations: ['sum'] })).status).toBe('untraced')
    // Two rows with the same value still add up.
    expect(only(trace('15%', 'a 7.5% b 7.5%', { derivations: ['sum'] })).status).toBe('derived')
    expect(only(trace('22.5%', 'a 7.5% b 7.5% c 7.5%', { derivations: ['sum'] })).status).toBe('untraced') // three-way sums are out of scope
  })

  it('percent-of covers both "x is what percent of y" and "p% of y"', () => {
    expect(only(trace('$15.04', 'rate 7.5%, base $200.50', { derivations: ['percent-of'] }))).toMatchObject({
      status: 'derived', derivation: { kind: 'percent-of', exact: false, rounding: 'either' },
    })
    expect(only(trace('80%', 'last 80, this 100', { derivations: ['percent-of'] })).status).toBe('derived')
    expect(only(trace('$15.04', 'rate 7.5%, base $200.50', { derivations: ['percent-of'], rounding: [] })).status).toBe('untraced')
  })

  it('ratio is a plain number or an x multiple', () => {
    expect(only(trace('1.25x', 'last 80, this 100', { derivations: ['ratio'] })).status).toBe('unknown') // reversed order
    expect(only(trace('0.8x', 'last 80, this 100', { derivations: ['ratio'] })).status).toBe('derived')
    expect(only(trace('0.8', 'last 80, this 100', { derivations: ['ratio'] })).status).toBe('derived')
    expect(only(trace('0.8%', 'last 80, this 100', { derivations: ['ratio'] })).status).toBe('untraced')
  })

  it('a difference of percents is a percentage-point number', () => {
    const r = trace('2.5 pp', 'was 10%, now 12.5%', { derivations: ['difference'] })
    expect(only(r)).toMatchObject({ status: 'derived', derivation: { kind: 'difference' } })
    expect(only(trace('2.5%', 'was 10%, now 12.5%', { derivations: ['difference'] })).status).toBe('derived')
  })

  it('percent-change direction follows the order the evidence mentions the numbers', () => {
    const d = ['percent-change'] as const
    expect(only(trace('25%', 'from 80 to 100', { derivations: [...d] })).status).toBe('derived')
    expect(only(trace('25%', 'to 100 from 80', { derivations: [...d] })).status).toBe('unknown')
    expect(only(trace('-20%', 'to 100 from 80', { derivations: [...d] })).status).toBe('derived')
    expect(only(trace('+25%', 'from 80 to 100', { derivations: [...d] })).status).toBe('derived')
  })

  it('an explicit sign must agree with the derived value', () => {
    // Evidence order 100 then 80: later minus earlier is -20.
    const d = ['difference'] as const
    expect(only(trace('-20', 'a 100 b 80', { derivations: [...d] })).status).toBe('derived')
    expect(only(trace('20', 'a 100 b 80', { derivations: [...d] })).status).toBe('derived')
    // +20 would need earlier minus later, the reverse of the order the evidence gives.
    expect(only(trace('+20', 'a 100 b 80', { derivations: [...d] })).status).toBe('unknown')
    // Sums have no direction: a minus sign on a positive sum is plain wrong.
    expect(only(trace('-180', 'a 100 b 80', { derivations: ['sum'] })).status).toBe('untraced')
    expect(only(trace('-180', 'a 100 b 80', { derivations: ['sum'], signMode: 'magnitude' })).status).toBe('derived')
  })

  it('reports how many derivations produced the number', () => {
    const r = only(trace('0.5', 'a 1 b 2 c 4', { derivations: ['ratio'] }))
    expect(r.status).toBe('derived')
    expect(r.derivation?.matches).toBeGreaterThan(1) // 1/2 and 2/4
  })

  it('ignores ambiguous, year and date operands', () => {
    // A number whose only doubt is thousands-versus-decimal still takes part with its primary reading.
    expect(only(trace('2.5', 'a 1.250 b 1.250', { derivations: ['sum'] })).status).toBe('derived')
    expect(only(trace('4000', 'x 2000 and 2000', { derivations: ['sum'] })).status).toBe('untraced')
  })

  it('reports the cap and the number of candidates', () => {
    const r = trace('1', 'a 2 b 3 c 4', { derivations: ['sum', 'difference'] })
    expect(r.candidateCapHit).toBe(false)
    expect(r.derivationCandidates).toBe(9) // 3 pairs: 1 sum + 2 differences each
  })

  it('validates the option values', () => {
    expect(() => trace('1', 'x', { derivations: ['mean' as never] })).toThrow(RangeError)
    expect(() => trace('1', 'x', { derivations: 'sum' as never })).toThrow(TypeError)
    expect(() => trace('1', 'x', { maxCandidates: 0 })).toThrow(RangeError)
    expect(() => trace('1', 'x', { maxCandidates: 1_000_001 })).toThrow(RangeError)
    expect(() => trace('1', 'x', { maxCandidates: 1.5 })).toThrow(TypeError)
    expect(() => trace('1', 'x', { rounding: ['floor' as never] })).toThrow(RangeError)
    expect(() => trace('1', 'x', { signMode: 'both' as never })).toThrow(RangeError)
  })
})

describe('ambiguity', () => {
  it('a number that is the same text on both sides traces', () => {
    expect(only(trace('1.234', 'x 1.234')).status).toBe('traced')
    expect(only(trace('4K', 'x 4K')).status).toBe('traced')
  })

  it('the other reading only: unknown, in both directions', () => {
    expect(only(trace('4K', 'x 4')).status).toBe('unknown')
    expect(only(trace('4K', 'x 4000')).status).toBe('traced') // the primary reading matches
    expect(only(trace('4', 'x 4K')).status).toBe('unknown') // evidence 4K could be the label
    expect(only(trace('1,234', 'x 1.234')).status).toBe('unknown')
  })

  it('a locale-mismatch guess may only produce unknown', () => {
    expect(only(trace('12,5', 'x 12.5')).status).toBe('unknown')
    expect(only(trace('12.5', 'x 12,5')).status).toBe('unknown')
    expect(only(trace('12,5', 'x 99')).status).toBe('untraced')
  })

  it('superscripts and over-long numbers are unknown', () => {
    expect(only(trace('10²', 'x 10')).reason).toBe('ambiguous-superscript')
    expect(only(trace('9'.repeat(70), 'x ' + '9'.repeat(70))).reason).toBe('too-long')
    // Evidence in those forms cannot vouch for anything.
    expect(only(trace('10', 'x 10²')).status).toBe('untraced')
  })

  it('digits inside an evidence identifier can make an output number unknown, never traced', () => {
    expect(only(trace('Revenue in 2025 grew.', 'FY2025 revenue grew.'))).toMatchObject({ status: 'unknown', reason: 'ambiguous-reading' })
    expect(only(trace('Plan 12 applies.', 'Plan B12 applies.')).status).toBe('unknown')
    expect(only(trace('Version 21.', 'Updated to v2.1')).status).toBe('untraced') // 21 is not 2 or 1
    expect(only(trace('Updated to 2.', 'Updated to v2.1')).status).toBe('unknown')
    // The output side stays silent about its own identifiers.
    expect(trace('Plan B12 applies.', 'x').numbers).toEqual([])
    // Identifier digits are weak evidence only: a stronger match elsewhere still wins.
    expect(only(trace('Revenue in 2025.', 'FY2025 and also 2025')).status).toBe('traced')
  })

  it('fractions and inline exponents never trace by their parts', () => {
    expect(trace('3/4', 'x 3 and 4').numbers.map((n) => n.status)).toEqual(['unknown', 'unknown'])
    expect(trace('3/4', 'x 9').verdict).toBe('untraced')
    expect(trace('3/4', 'x 3/4').verdict).toBe('clean') // the same fraction written the same way
    expect(trace('3/4', 'x 3/40 and 30/4').verdict).toBe('unknown') // the parts exist elsewhere, as parts of other fractions
    expect(only(trace('10^6', 'x 10 and 6')).reason).toBe('ambiguous-superscript')
  })

  it('dates: an identical text vouches for itself, a known role needs the same role', () => {
    expect(trace('10/12/2026', 'due 10/12/2026').verdict).toBe('clean')
    expect(trace('10/12/2026', 'due 12/10/2026').verdict).toBe('unknown')
    expect(trace('10/12/2026', 'due 2026-10-12').verdict).toBe('unknown')
    expect(trace('2026-10-12', 'due 10/12/2026').verdict).toBe('unknown')
    expect(trace('2026-10-12', 'due 2026-12-10').verdict).toBe('untraced')
    expect(trace('13/10/2026', 'due 2026-10-13').verdict).toBe('clean')
    expect(trace('12:30', 'at 12:30').verdict).toBe('clean')
    expect(trace('12:30', 'at 12 oclock and 30').verdict).toBe('untraced')
  })

  it('locale changes how the output is read', () => {
    expect(trace('13.10.2026', 'due 2026-10-13', { locale: 'de-DE', evidenceLocale: 'en-US' }).verdict).toBe('clean')
    expect(trace('Der Preis: 1.234,50', 'Price 1234.50', { locale: 'de-DE', evidenceLocale: 'en-US' }).verdict).toBe('clean')
  })
})

describe('ignoring', () => {
  it('ignore takes raw text and plain values', () => {
    const r = trace('Section 4.2 shows 17.', 'x', { ignore: ['4.2', 17] })
    expect(r.numbers.map((n) => n.status)).toEqual(['ignored', 'ignored'])
    expect(r.numbers[0]?.reason).toBe('ignore-list')
    expect(r.verdict).toBe('clean')
    // A plain value never ignores a percent or an amount.
    expect(only(trace('17%', 'x', { ignore: [17] })).status).toBe('untraced')
    // A number entry keeps its sign.
    expect(only(trace('-5', 'x', { ignore: [5] })).status).toBe('untraced')
    expect(only(trace('-5', 'x', { ignore: [-5] })).status).toBe('ignored')
  })

  it('ignoreYears, ignoreKinds and small integers', () => {
    expect(only(trace('in 2026', 'x', { ignoreYears: true })).status).toBe('ignored')
    expect(trace('on 2026-10-10', 'x', { ignoreYears: true }).numbers.map((n) => n.status)).toEqual(['ignored', 'untraced', 'untraced'])
    expect(only(trace('3rd', 'x', { ignoreKinds: ['ordinal'] })).status).toBe('ignored')
    expect(trace('I have 0, 7, 10 and 11 items', 'x', { ignoreSmallIntegersUpTo: 10 }).numbers.map((n) => n.status)).toEqual([
      'ignored', 'ignored', 'ignored', 'untraced',
    ])
    // Not a number with a unit, and not one the text leaves unclear (5² is 25).
    expect(trace('5 days and 5\u00b2 and 3rd', 'x', { ignoreSmallIntegersUpTo: 10 }).numbers.map((n) => n.status)).toEqual([
      'untraced', 'unknown', 'untraced',
    ])
    // Not percents, amounts, signed or decimal numbers.
    expect(trace('5% $5 -5 5.5', 'x', { ignoreSmallIntegersUpTo: 10 }).numbers.map((n) => n.status)).toEqual([
      'untraced', 'untraced', 'untraced', 'untraced',
    ])
  })

  it('ignorePattern sees only the number and a short window around it', () => {
    const r = trace('See Section 4.2 and 4.3, then 99.', 'x', { ignorePattern: /Section \d/ })
    expect(r.numbers.map((n) => [n.token.raw, n.status])).toEqual([
      ['4.2', 'ignored'], ['4.3', 'untraced'], ['99', 'untraced'],
    ])
    expect(r.numbers[0]?.reason).toBe('pattern')
  })

  it('ignorePattern never sees more than the first 64 characters of a long number', () => {
    const long = '9'.repeat(100)
    // 64 characters of the number plus 16 after it: 80 in all, never 81.
    expect(only(trace(long, 'x', { ignorePattern: /9{80}/ })).status).toBe('ignored')
    expect(only(trace(long, 'x', { ignorePattern: /9{81}/ })).status).toBe('unknown')
    // And only 32 characters before and 16 after.
    const text = `${'a '.repeat(30)}7 ${'b '.repeat(20)}`
    expect(only(trace(text, 'x', { ignorePattern: /a a a a a a a a a a a a a a a a 7/ })).status).toBe('ignored')
    expect(only(trace(text, 'x', { ignorePattern: /a a a a a a a a a a a a a a a a a a 7/ })).status).toBe('untraced')
    expect(only(trace(text, 'x', { ignorePattern: /7 b b b b b b b b/ })).status).toBe('ignored')
    expect(only(trace(text, 'x', { ignorePattern: /7 b b b b b b b b b b/ })).status).toBe('untraced')
  })

  it('ignorePattern state does not leak between numbers (global and sticky flags)', () => {
    for (const flags of ['g', 'y', 'gy', 'u', '']) {
      const re = new RegExp('page \\d+', flags)
      const r = trace('page 1, page 2, page 3', 'x', { ignorePattern: re })
      expect(r.numbers.map((n) => n.status), flags).toEqual(['ignored', 'ignored', 'ignored'])
      expect(re.lastIndex).toBe(0)
    }
  })

  it('an empty-matching pattern terminates, including under u with astral text', () => {
    const r = trace('😀 5 😀 6', 'x', { ignorePattern: /(?:)/gu })
    expect(r.numbers.map((n) => n.status)).toEqual(['untraced', 'untraced'])
    expect(trace('5', 'x', { ignorePattern: /x*/g }).numbers[0]?.status).toBe('untraced')
  })

  it('rejects a non-RegExp pattern and unknown ignore entries', () => {
    expect(() => trace('5', 'x', { ignorePattern: 'abc' as never })).toThrow(TypeError)
    expect(() => trace('5', 'x', { ignorePattern: new Proxy(/a/, {}) })).toThrow(TypeError)
    expect(() => trace('5', 'x', { ignore: [{}] as never })).toThrow(TypeError)
    expect(() => trace('5', 'x', { ignore: [1e21] })).toThrow(RangeError)
    expect(() => trace('5', 'x', { ignore: [Number.NaN] })).toThrow(RangeError)
    expect(() => trace('5', 'x', { ignoreKinds: ['weird' as never] })).toThrow(RangeError)
    expect(() => trace('5', 'x', { ignoreSmallIntegersUpTo: -1 })).toThrow(RangeError)
  })
})

describe('verdict', () => {
  it('is clean only when nothing is untraced or unknown', () => {
    expect(trace('5', 'x 5').verdict).toBe('clean')
    expect(trace('5 and 6', 'x 5').verdict).toBe('untraced')
    expect(trace('5 and 4K', 'x 5 and 4').verdict).toBe('unknown')
    expect(trace('6 and 4K', 'x 5 and 4').verdict).toBe('untraced') // untraced outranks unknown
    expect(trace('5', 'x 5').counts).toEqual({ traced: 1, rounded: 0, derived: 0, untraced: 0, ignored: 0, unknown: 0, skipped: 0, unitUnverified: 0, signDiffers: 0 })
  })

  it('empty evidence leaves every output number untraced and says how many evidence numbers there were', () => {
    const r = trace('Sales were 5.', '')
    expect(r.verdict).toBe('untraced')
    expect(r.evidenceNumbers).toBe(0)
    expect(trace('Sales were 5.', []).verdict).toBe('untraced')
  })
})
