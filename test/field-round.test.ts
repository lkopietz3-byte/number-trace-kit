import { describe, expect, it } from 'vitest'
import { extractNumbers, reconcile, traceNumbers } from '../src/index.js'
import type { TraceOptions, TraceResult } from '../src/index.js'

function cpuMs(fn: () => void): number {
  fn()
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const before = process.cpuUsage()
    fn()
    const used = process.cpuUsage(before)
    best = Math.min(best, (used.user + used.system) / 1e3)
  }
  return best
}

// Rows from a field trial on real reports and pricing pages. Cases are
// paraphrased synthetic text, not copied from any source.

function t(output: string, evidence: Parameters<typeof traceNumbers>[1], options?: TraceOptions): TraceResult {
  return traceNumbers(output, evidence, options)
}

describe('D1: a date traces as a whole date', () => {
  it('a date whose parts appear in other dates is not clean', () => {
    const ev = 'Transfers end June 30, 2026. The program was added in Sept 2025.'
    const r = t('Transfers end June 30, 2025.', ev)
    expect(r.verdict).not.toBe('clean')
    expect(r.numbers.every((n) => n.status !== 'traced')).toBe(true)
    expect(t('Valued 09/15/2023.', 'Valued 09/15/2024. Date of loss 11/14/2023.').verdict).not.toBe('clean')
    expect(t('Due 2026-05-14.', 'Due 2026-06-14. Paid on 20 May 2026.').verdict).not.toBe('clean')
  })

  it('the same date written another way still traces', () => {
    const ev = 'Transfers end June 30, 2026.'
    for (const out of ['Transfers end 2026-06-30.', 'Transfers end 30 June 2026.', 'Transfers end 06/30/2026.', 'Transfers end Jun 30 2026.']) {
      expect(t(out, ev).verdict, out).toBe('clean')
    }
    expect(t('Transfers end June 30.', ev).verdict).toBe('clean') // less specific than the evidence
    expect(t('Ends June 30, 2026.', 'Transfers end June 30.').verdict).not.toBe('clean') // more specific than the evidence
  })

  it('date ranges and month-years are checked date by date', () => {
    expect(t('Oct 5-7, 2026', 'October 5, 2026 and October 7, 2026').verdict).toBe('clean')
    expect(t('Oct 5-8, 2026', 'October 5, 2026 and October 7, 2026').verdict).not.toBe('clean')
    expect(t('March 2026', 'Since March 2026').verdict).toBe('clean')
    expect(t('March 2026', 'March 2025 and 2026').verdict).not.toBe('clean')
    expect(t('at 14:05', 'closed at 14:05:30').verdict).toBe('clean')
    expect(t('at 14:06', 'closed at 14:05:30').verdict).not.toBe('clean')
  })

  it('a date nowhere in the evidence is still untraced', () => {
    expect(t('Ends June 30, 2027.', 'Ends 2026-01-02.').verdict).toBe('untraced')
  })
})

describe('D6: glued units are units', () => {
  it('cents, months and points are read, so a wrong value is caught', () => {
    expect(extractNumbers('1.9c per point')[0]).toMatchObject({ value: '1.9', unit: 'c' })
    expect(extractNumbers('1.9¢ per point')[0]).toMatchObject({ value: '1.9', unit: 'c' })
    expect(extractNumbers('12 cents')[0]).toMatchObject({ value: '12', unit: 'c' })
    expect(extractNumbers('10mo, 2.4pts, 1.5cpp').map((x) => x.unit)).toEqual(['month', 'pt', 'cpp'])
    expect(t('The baseline is 1.9c per point.', 'The baseline is 1.7c per point.').verdict).toBe('untraced')
    expect(t('The baseline is 1.7c per point.', 'The baseline is 1.7c per point.').verdict).toBe('clean')
    expect(t('Worth 1.7 cents', 'Worth 1.7c').verdict).toBe('clean')
  })
})

describe('D13: model and version names are identifiers', () => {
  it('hyphenated names with letters on both sides produce no numbers', () => {
    for (const text of ['We used Llama-3.3-70B-Instruct', 'and gpt-5.4-nano-2026-03-17', 'Qwen3-8B scored well', 'claude-3-5-sonnet today', 'the mistral-7b-instruct-v0.2 model']) {
      expect(extractNumbers(text), text).toEqual([])
    }
    // Ordinary hyphenated numbers are untouched.
    expect(extractNumbers('pre-2020 and 5-day and 3.5-inch and Q3-2026 and 10-K').map((x) => x.value)).toEqual(['2020', '5', '3.5', '2026', '10'])
    expect(extractNumbers('gpt-4 beat it')[0]).toMatchObject({ value: '4' })
  })

  it('the digits of a model name are weak evidence', () => {
    expect(t('Scored 70.', 'Llama-3.3-70B-Instruct').numbers[0]?.status).toBe('unknown') // the digits of the name are only a weak link
    expect(t('Scored 71.', 'Llama-3.3-70B-Instruct').numbers[0]?.status).toBe('untraced')
    expect(t('Dated 2026.', 'gpt-5.4-nano-2026-03-17').numbers[0]?.status).toBe('unknown')
  })
})

describe('D7: three-decimal operands', () => {
  it('trailing zeros do not block an exact derivation', () => {
    const r = t('The sum is 1.750', 'Beta 1.250 and 0.500', { derivations: ['sum'] })
    expect(r.numbers[0]).toMatchObject({ status: 'derived', derivation: { kind: 'sum', exact: true } })
    expect(t('The sum is 1.800', 'Beta 1.250 and 0.500', { derivations: ['sum'] }).numbers[0]?.status).not.toBe('traced')
    expect(t('The sum is 1.800', 'Beta 1.250 and 0.500', { derivations: ['sum'] }).numbers[0]?.status).not.toBe('derived')
  })
})

describe('D2: a derivation that is too likely is unknown', () => {
  const dense = Array.from({ length: 60 }, (_, i) => `row ${i}: ${(i * 7.3 + 11.1).toFixed(1)}%`).join('; ')

  it('reports how many candidates fall in the rounding window and downgrades loose matches', () => {
    const loose = t('Rate 43.8%.', dense, { derivations: ['difference'], maxCandidates: 100_000, maxDerivationMatches: 1_000_000, maxDerivationDensity: 1_000_000 })
    expect(loose.numbers[0]?.status).toBe('derived')
    const matches = loose.numbers[0]?.derivation?.matches ?? 0
    expect(matches).toBeGreaterThan(3)
    const guarded = t('Rate 43.8%.', dense, { derivations: ['difference'], maxCandidates: 100_000 })
    expect(guarded.numbers[0]).toMatchObject({ status: 'unknown', reason: 'derivation-too-likely' })
    // The limit is an option, and a tight derivation passes.
    expect(t('Rate 43.8%.', dense, { derivations: ['difference'], maxCandidates: 100_000, maxDerivationMatches: matches, maxDerivationDensity: 1_000_000 }).numbers[0]?.status).toBe('derived')
    // A crowded neighborhood alone is enough, even when few candidates hit the exact value.
    expect(t('Rate 43.8%.', dense, { derivations: ['difference'], maxCandidates: 100_000, maxDerivationMatches: 1_000_000 }).numbers[0]).toMatchObject({ status: 'unknown', reason: 'derivation-too-likely' })
    expect(() => t('1', 'x', { maxDerivationDensity: 0 })).toThrow(RangeError)
    expect(() => t('1', 'x', { maxDerivationDensity: '1' as never })).toThrow(TypeError)
    expect(t('Total 300.75.', 'Q1 100.25. Q2 200.50.', { derivations: ['sum'] }).numbers[0]?.status).toBe('derived')
    expect(() => t('1', 'x', { maxDerivationMatches: 0 })).toThrow(RangeError)
  })
})

describe('presets', () => {
  it('strict allows no derivations, report turns on the working set with the guard', () => {
    expect(t('Total 300.75.', 'Q1 100.25. Q2 200.50.', { preset: 'strict' }).numbers[0]?.status).toBe('untraced')
    expect(t('Total 300.75.', 'Q1 100.25. Q2 200.50.', { preset: 'report' }).numbers[0]?.status).toBe('derived')
    expect(t('Total $12.3.', '12.34', { preset: 'report' }).numbers[0]).toMatchObject({ status: 'rounded', unitUnverified: true })
    // Explicit options override the preset.
    expect(t('Total 300.75.', 'Q1 100.25. Q2 200.50.', { preset: 'report', derivations: [] }).numbers[0]?.status).toBe('untraced')
    expect(() => t('1', 'x', { preset: 'loose' as never })).toThrow(RangeError)
  })
})

describe('D3 and D8: evidence scale and currency hints', () => {
  it('a doc can say its bare numbers are in thousands of dollars', () => {
    const doc = { id: 'tbl', text: 'Revenue (in thousands)\n2019 | 5,735\n2018 | 4,980', scale: 'thousand', currency: 'USD' } as const
    expect(t('Revenue was $5,735 thousand in 2019.', [doc]).verdict).toBe('clean')
    expect(t('Revenue was $5.7 million in 2019.', [doc]).numbers.map((n) => n.status)).toContain('rounded')
    expect(t('Revenue was $5.7 million in 2019.', [doc]).verdict).toBe('clean')
    expect(t('Revenue was $5.8 million in 2019.', [doc]).verdict).toBe('untraced')
    // Without the hint the kit does not guess.
    expect(t('Revenue was $5.7 million in 2019.', [{ id: 'tbl', text: doc.text }]).verdict).toBe('untraced')
    // The year column is not scaled.
    expect(t('In 2019 and 2018.', [doc]).verdict).toBe('clean')
  })

  it('percents, years and numbers with their own magnitude are left alone', () => {
    const doc = { id: 'tbl', text: 'Growth 12.5%, 2019, $3 million, 7 units', scale: 'million' } as const
    expect(t('Growth 12.5%.', [doc]).verdict).toBe('clean')
    expect(t('Cost $3 million.', [doc]).verdict).toBe('clean')
    expect(t('7 million units.', [doc]).verdict).toBe('clean')
  })

  it('options carry the hint for string evidence, and the number form is exponent of ten', () => {
    expect(t('$2.5 million', 'Total 2,500', { evidenceScale: 'thousand', evidenceCurrency: 'USD' }).verdict).toBe('clean')
    expect(t('$2.5 million', [{ id: 'a', text: 'Total 2,500', scale: 3, currency: 'USD' }]).verdict).toBe('clean')
    expect(() => t('1', [{ id: 'a', text: '1', scale: 'lots' as never }])).toThrow(RangeError)
    expect(() => t('1', 'x', { evidenceScale: 20 as never })).toThrow(RangeError)
  })

  it('a bare output number may match a dollar figure when asked', () => {
    expect(t('Net revenue was 5,829 million.', 'Net revenue was $5,829 million.').verdict).toBe('untraced')
    const r = t('Net revenue was 5,829 million.', 'Net revenue was $5,829 million.', { allowBareOutput: true })
    expect(r.numbers[0]).toMatchObject({ status: 'traced', unitUnverified: true })
    expect(t('Net revenue was 5,830 million.', 'Net revenue was $5,829 million.', { allowBareOutput: true }).verdict).toBe('untraced')
    // A unit the evidence contradicts is still wrong.
    expect(t('5,829 kg', 'Net revenue was $5,829 million.', { allowBareOutput: true }).verdict).toBe('untraced')
  })
})

describe('D4 and D5: derivations at magnitude level', () => {
  const ev = 'Revenue was $83.692 million in 2019 and $66.128 million in 2018.'

  it('a rounded difference or sum derives when asked', () => {
    expect(t('Revenue grew $17.6 million.', ev, { derivations: ['difference'] }).numbers[0]?.status).toBe('untraced')
    const r = t('Revenue grew $17.6 million.', ev, { derivations: ['difference'], roundSums: true })
    expect(r.numbers[0]).toMatchObject({ status: 'derived', derivation: { kind: 'difference', exact: false } })
    expect(t('About $28.0 million in all.', 'Q1 $12.34 million and Q2 $15.67 million', { derivations: ['sum'], roundSums: true }).numbers[0]?.status).toBe('derived')
    expect(t('About $28.1 million in all.', 'Q1 $12.34 million and Q2 $15.67 million', { derivations: ['sum'], roundSums: true }).numbers[0]?.status).toBe('untraced')
    // An exact sum is never "rounded" without the option, and rounding: [] keeps it exact.
    expect(t('About $28.0 million in all.', 'Q1 $12.34 million and Q2 $15.67 million', { derivations: ['sum'], roundSums: true, rounding: [] }).numbers[0]?.status).toBe('untraced')
  })

  it('a percent change of magnitude figures, newest-first tables, and the order hint', () => {
    const e = 'Hedges: $153.7 million (2011), $139.9 million (2010).'
    expect(t('Hedges rose 9.9%.', e, { derivations: ['percent-change'] }).numbers[0]).toMatchObject({ status: 'unknown', reason: 'derivation-direction' })
    expect(t('Hedges rose 9.9%.', e, { derivations: ['percent-change'], evidenceOrder: 'newest-first' }).numbers[0]?.status).toBe('derived')
    // The fall from the later figure to the earlier one reads against the order, so it is unknown.
    expect(t('Hedges moved -9.0%.', e, { derivations: ['percent-change'], evidenceOrder: 'newest-first' }).numbers[0]).toMatchObject({ status: 'unknown', reason: 'derivation-direction' })
    expect(() => t('1', 'x', { evidenceOrder: 'sideways' as never })).toThrow(RangeError)
  })
})

describe('D9: accounting negatives', () => {
  it('(557), -557, $(557) and -$557 are one figure', () => {
    expect(t('Net loss was -557.', 'Net income (loss): (557)').verdict).toBe('clean')
    expect(t('Net loss was 557.', 'Net income (loss): (557)').verdict).toBe('clean')
    expect(t('Net loss was -$557.', 'Net income (loss): $(557)').verdict).toBe('clean')
    expect(t('Net loss was $(557).', 'Net income (loss): -$557').verdict).toBe('clean')
    expect(t('Net loss was (557).', 'Net income (loss): -557').verdict).toBe('clean')
    expect(t('Net loss was -558.', 'Net income (loss): (557)').verdict).toBe('untraced')
    // A positive explicit plus still disagrees with a figure written in parentheses only when it is a mark.
    expect(t('Gain of +$557.', 'Net income (loss): $(557)').verdict).toBe('untraced')
  })
})

describe('D12: reconcile reads the strings reports print', () => {
  it('commas, a currency symbol and accounting parentheses', () => {
    expect(reconcile({ rows: [{ label: 'a', amount: '38,400' }, { label: 'b', amount: '$600.00' }], total: '$39,000' }).ok).toBe(true)
    expect(reconcile({ rows: [{ label: 'a', amount: '(557)' }, { label: 'b', amount: '1,000' }], total: '443' })).toMatchObject({ ok: true, sum: '443' })
    expect(reconcile({ rows: [{ label: 'a', amount: '-$557.50' }], total: '(557.50)' }).ok).toBe(true)
    expect(reconcile({ rows: [{ label: 'a', amount: '€1,234.5' }], total: '1234.50' }).ok).toBe(true)
    expect(reconcile({ rows: [{ label: 'a', amount: '.5' }], total: '0.50' }).ok).toBe(true)
  })

  it('still rejects what it cannot read exactly', () => {
    for (const bad of ['', '1,23', '12,34,567', '1.234,50', '12.', '1e3', '0x10', 'NaN', '$', '()', '(5', '5)', '1 234', '$-', '--5', '１２', '+$-5', '+$+5', '-$+5', '-$-5', '$--5', '(-5)', '(+5)', '+-5']) {
      expect(() => reconcile({ rows: [{ label: 'a', amount: bad }], total: '0' }), JSON.stringify(bad)).toThrow(TypeError)
    }
    // Integers are still minor units.
    expect(reconcile({ rows: [{ label: 'a', amount: 3840000 }], total: '38,400' }).ok).toBe(true)
  })
})

describe('D11: product', () => {
  it('a count times a unit price derives, with display rounding', () => {
    const ev = 'Usage was 3,000,000 events at $0.0000343 each.'
    expect(t('That costs $102.90.', ev).numbers[0]?.status).toBe('untraced')
    expect(t('That costs $102.90.', ev, { derivations: ['product'] }).numbers[0]).toMatchObject({
      status: 'derived', derivation: { kind: 'product', exact: true },
    })
    expect(t('That costs $102.9.', ev, { derivations: ['product'] }).numbers[0]?.status).toBe('derived')
    expect(t('That costs $103.', ev, { derivations: ['product'] }).numbers[0]).toMatchObject({ status: 'derived', derivation: { exact: false } })
    expect(t('That costs $110.', ev, { derivations: ['product'] }).numbers[0]?.status).toBe('untraced')
    expect(t('Total 4,218,065 times $15.52 is $65,464,368.80', 'Shares 4,218,065 priced at $15.52', { derivations: ['product'] }).numbers.at(-1)?.status).toBe('derived')
    // Two prices do not multiply into a price.
    expect(t('Total $20.', 'Fee $4 and fee $5', { derivations: ['product'] }).numbers[0]?.status).toBe('untraced')
    expect(t('Total 20.', 'Boxes 4 of 5 items', { derivations: ['product'] }).numbers[0]?.status).toBe('derived')
  })
})

describe('review of c4338d6', { timeout: 120_000 }, () => {
  it('evidence scale applies to bare numbers only, never to one that says its own magnitude', () => {
    const hint = { evidenceScale: 'thousand' } as const
    expect(t('3 billion', '3.000000 million', hint).verdict).toBe('untraced')
    expect(t('3 million', '3.000000 million', hint).verdict).toBe('clean')
    expect(t('4 thousand', '4.000K', hint).verdict).toBe('clean')
    expect(t('4 million', '4.000K', hint).verdict).not.toBe('clean') // K may be a label: unknown
    expect(t('2500000', '2.500000e6', hint).verdict).toBe('clean')
    expect(t('2500000000', '2.500000e6', hint).verdict).toBe('untraced')
    expect(t('$1.5 million', '$1.500 million', { evidenceScale: 'million', evidenceCurrency: 'USD' }).verdict).toBe('clean')
    // A bare cell still scales.
    expect(t('5.735 million', '5,735', hint).verdict).toBe('clean')
    expect(extractNumbers('3.000000 million')[0]).toMatchObject({ value: '3000000', scale: 0, magnitude: 6 })
    expect(extractNumbers('5e-3')[0]?.magnitude).toBe(-3)
    expect(extractNumbers('1,200')[0]?.magnitude).toBeUndefined()
    expect(extractNumbers('10-12 million').map((n) => n.magnitude)).toEqual([6, 6])
  })

  it('a written-out month range is linear to read', () => {
    const text = 'Oct ' + '1-'.repeat(160_000) + '1'
    expect(cpuMs(() => extractNumbers(text))).toBeLessThan(1500)
    const small = 'Oct ' + '1-'.repeat(20_000) + '1'
    expect(cpuMs(() => extractNumbers(small))).toBeLessThan(300)
  })

  it('an overlong evidence number is never parsed, with or without hints', () => {
    const lengths: number[] = []
    const realBigInt = globalThis.BigInt
    const spy = Object.assign(
      (value: string | number | bigint | boolean): bigint => {
        if (typeof value === 'string') lengths.push(value.length)
        return realBigInt(value)
      },
      realBigInt,
    )
    globalThis.BigInt = spy
    try {
      for (const options of [{ evidenceScale: 'thousand' }, { evidenceCurrency: 'USD' }, { evidenceScale: 6, evidenceCurrency: 'USD' }, {}] as const) {
        lengths.length = 0
        t('5', `${'9'.repeat(1000)} and 5`, options)
        expect(Math.max(0, ...lengths), JSON.stringify(options)).toBeLessThan(200)
      }
    } finally {
      globalThis.BigInt = realBigInt
    }
  })

  it('evidence order changes the direction of a change, not a sum, a product or an average', () => {
    const o = { evidenceOrder: 'newest-first' } as const
    expect(t('300', 'a 100 and 200', { ...o, derivations: ['sum'] }).numbers[0]?.status).toBe('derived')
    expect(t('150', 'a 100 and 200', { ...o, derivations: ['average'] }).numbers[0]?.status).toBe('derived')
    expect(t('20000', 'a 100 and 200', { ...o, derivations: ['product'] }).numbers[0]?.status).toBe('derived')
    expect(t('150', 'a 100 and 250 and 300', { ...o, derivations: ['difference'], maxOperands: 3 }).numbers[0]?.status).toBe('derived')
    expect(t('$18 billion', 'a $12 billion and $30 billion', { ...o, derivations: ['sum'] }).numbers[0]?.status).toBe('untraced')
    // Direction still matters for a change.
    expect(t('+100', 'a 150 and 250', { derivations: ['difference'] }).numbers[0]?.status).toBe('derived')
    expect(t('+100', 'a 150 and 250', { ...o, derivations: ['difference'] }).numbers[0]).toMatchObject({ status: 'unknown', reason: 'derivation-direction' })
    expect(t('-100', 'a 150 and 250', { ...o, derivations: ['difference'] }).numbers[0]?.status).toBe('derived')
  })

  it('evidence given as extracted tokens reads dates and flags like the same text', () => {
    expect(t('2026-06-30', extractNumbers('2026-06-30')).verdict).toBe('clean')
    expect(t('June 30, 2026', extractNumbers('June 30, 2026')).verdict).toBe('clean')
    expect(t('June 30, 2025', extractNumbers('June 30, 2026')).verdict).not.toBe('clean')
    // Tokens that say they come from different documents are not one date.
    const parts = extractNumbers('June 30, 2026').map((tok, i) => ({ ...tok, evidenceId: i === 0 ? 'a' : 'b' }))
    expect(t('June 30, 2026', parts).verdict).not.toBe('clean')
    // The same evidence id keeps them together, and the cited span is the whole date.
    const same = extractNumbers('June 30, 2026').map((tok) => ({ ...tok, evidenceId: 'doc' }))
    const r = t('June 30, 2026', same)
    expect(r.verdict).toBe('clean')
    expect(r.numbers[1]?.evidence[0]).toMatchObject({ id: 'doc', raw: 'June 30, 2026' })
    // An accounting negative.
    expect(t('-557', extractNumbers('(557)')).verdict).toBe('clean')
    expect(t('-557', '(557)').verdict).toBe('clean')
  })

  it('caller tokens must keep the new fields honest', () => {
    const tok = extractNumbers('(557)')[0]
    expect(tok?.parenthesized).toBe(true)
    expect(() => t('1', [{ ...tok, parenthesized: false } as never])).toThrow(TypeError)
    expect(() => t('1', [{ ...tok, value: '-557', signStyle: 'minus' } as never])).toThrow(TypeError)
    const mil = extractNumbers('3 million')[0]
    expect(() => t('1', [{ ...mil, magnitude: 0 } as never])).toThrow(TypeError)
    expect(() => t('1', [{ ...mil, magnitude: 1.5 } as never])).toThrow(TypeError)
    expect(() => t('1', [{ ...mil, magnitude: '6' } as never])).toThrow(TypeError)
    expect(t('3 million', [mil as never], { evidenceScale: 'thousand' }).verdict).toBe('clean')
    expect(t('3 billion', [mil as never], { evidenceScale: 'thousand' }).verdict).toBe('untraced')
  })

  it('allowBareOutput reaches weak evidence and derivations', () => {
    expect(t('1234', '$1.234', { allowBareOutput: true }).numbers[0]?.status).toBe('unknown')
    expect(t('300.75', '$100.25 and $200.50', { allowBareOutput: true, derivations: ['sum'] }).numbers[0]).toMatchObject({ status: 'derived', unitUnverified: true })
    expect(t('300.75', '$100.25 and $200.50', { derivations: ['sum'] }).numbers[0]?.status).toBe('untraced')
    expect(t('150.375', '$100.25 and $200.50', { allowBareOutput: true, derivations: ['average'] }).numbers[0]?.status).toBe('derived')
    expect(t('301.75', '$100.25 and $200.50', { allowBareOutput: true, derivations: ['sum'] }).numbers[0]?.status).toBe('untraced')
  })

  it('a traced date part cites the date it belongs to', () => {
    const r = t('Oct 5-7, 2026', 'The first was October 5, 2026 and the second October 7, 2026.')
    expect(r.verdict).toBe('clean')
    const byRaw = new Map(r.numbers.map((n) => [n.token.raw, n]))
    expect(byRaw.get('7')?.evidence[0]?.raw).toBe('October 7, 2026')
    expect(byRaw.get('5')?.evidence[0]?.raw).toBe('October 5, 2026')
    const ev = 'The first was October 5, 2026 and the second October 7, 2026.'
    const seven = byRaw.get('7')?.evidence[0]
    expect(ev.slice(seven?.start, seven?.end)).toBe('October 7, 2026')
  })
})
