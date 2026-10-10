import { describe, expect, it } from 'vitest'
import { extractNumbers, reconcile, reconcileComponents, traceNumbers } from '../src/index.js'
import type { NumberTrace, TraceOptions, TraceResult } from '../src/index.js'

// Verdict regression table. Written before the implementation. Each row is
// one input and the verdict the kit must give. Honest rows must come back
// clean; laundering rows must be flagged on positive evidence; "cannot tell"
// rows must be `unknown`, never a pass and never a false fail.

function find(result: TraceResult, raw: string): NumberTrace {
  const hit = result.numbers.find((n) => n.token.raw === raw)
  if (hit === undefined) {
    throw new Error(`no token with raw ${JSON.stringify(raw)} in ${JSON.stringify(result.numbers.map((n) => n.token.raw))}`)
  }
  return hit
}

function summary(result: TraceResult): string[] {
  return result.numbers.map((n) => `${n.token.raw}:${n.status}`)
}

function trace(output: string, evidence: Parameters<typeof traceNumbers>[1], options?: TraceOptions): TraceResult {
  return traceNumbers(output, evidence, options)
}

describe('honest outputs: every number traces', () => {
  it('exact match after normalization, citing the evidence id', () => {
    const r = trace('Revenue was $1,234.50 in 2025, up 12.5%.', [
      { id: 'report', text: 'FY revenue: 1234.50 USD. Year: 2025. Growth 12.5 percent.' },
    ], { ignoreYears: false })
    // "1234.50 USD" and "$1,234.50" are the same currency amount.
    expect(summary(r)).toEqual(['$1,234.50:traced', '2025:traced', '12.5%:traced'])
    expect(r.verdict).toBe('clean')
    expect(find(r, '$1,234.50').evidence.map((e) => e.id)).toEqual(['report'])
  })

  it('rounding: 12.34% shown as 12.3% and as 12%', () => {
    const r = trace('Growth was about 12.3%, call it 12%.', 'Growth: 12.34%')
    expect(find(r, '12.3%').status).toBe('rounded')
    expect(find(r, '12.3%').rounding).toBe('either')
    expect(find(r, '12%').status).toBe('rounded')
    expect(r.verdict).toBe('clean')
  })

  it('rounding ties are reported by mode: 12.5 -> 13 is half-up, 12.5 -> 12 is half-even', () => {
    const up = trace('About 13%.', 'Rate 12.5%')
    expect(find(up, '13%')).toMatchObject({ status: 'rounded', rounding: 'half-up' })
    const even = trace('About 12%.', 'Rate 12.5%')
    expect(find(even, '12%')).toMatchObject({ status: 'rounded', rounding: 'half-even' })
    // The caller can allow only one mode.
    const onlyUp = trace('About 12%.', 'Rate 12.5%', { rounding: ['half-up'] })
    expect(find(onlyUp, '12%').status).toBe('untraced')
  })

  it('rounding at a magnitude: 1.2 million from 1,234,567', () => {
    const r = trace('Roughly 1.2 million users.', 'Active users: 1,234,567')
    expect(find(r, '1.2 million').status).toBe('rounded')
    expect(r.verdict).toBe('clean')
  })

  it('a declared sum traces when sum is allowed', () => {
    const evidence = 'Q1 revenue $100.25. Q2 revenue $200.50.'
    const r = trace('Combined revenue was $300.75.', evidence, { derivations: ['sum'] })
    expect(find(r, '$300.75')).toMatchObject({ status: 'derived', derivation: { kind: 'sum', exact: true } })
    expect(find(r, '$300.75').derivation?.operands.map((o) => o.raw).sort()).toEqual(['$100.25', '$200.50'])
    expect(r.verdict).toBe('clean')
  })

  it('a correct percent change traces when percent-change is allowed', () => {
    const r = trace('Sales grew 25% year over year.', 'Last year $80. This year $100.', {
      derivations: ['percent-change'],
    })
    expect(find(r, '25%')).toMatchObject({ status: 'derived', derivation: { kind: 'percent-change' } })
    expect(r.verdict).toBe('clean')
  })

  it('a locale-aware amount: German formatting against an English source', () => {
    const r = trace('Der Betrag beträgt 1.234,50 €.', 'Amount due: EUR 1234.50', { locale: 'de-DE', evidenceLocale: 'en-US' })
    expect(summary(r)).toEqual(['1.234,50 €:traced'])
    expect(find(r, '1.234,50 €').token).toMatchObject({ value: '1234.50', currency: 'EUR', ambiguous: false })
  })

  it('the evidence locale is not guessed: one locale for both sides leaves "1234.50" unknown', () => {
    const r = trace('Der Betrag beträgt 1.234,50 €.', 'Amount due: EUR 1234.50', { locale: 'de-DE' })
    expect(find(r, '1.234,50 €')).toMatchObject({ status: 'unknown', reason: 'ambiguous-reading' })
    expect(r.verdict).toBe('unknown')
  })

  it('accounting parentheses read as a negative and match a minus sign', () => {
    const r = trace('Net result: (1,234).', 'Net result: -1,234')
    expect(find(r, '(1,234)').status).toBe('traced')
    expect(r.verdict).toBe('clean')
  })

  it('a range is two numbers, and both trace', () => {
    const r = trace('Expect 10-12 weeks.', 'Typical lead time is between 10 and 12 weeks.')
    expect(summary(r)).toEqual(['10:traced', '12 weeks:traced'])
    expect(r.verdict).toBe('clean')
  })

  it('a range shares its percent sign', () => {
    const r = trace('Growth of 10-12%.', 'Forecast: 10% to 12%.')
    expect(summary(r)).toEqual(['10:traced', '12%:traced'])
    expect(find(r, '10').token.kind).toBe('percent')
  })

  it('an output with no numbers is clean (nothing to trace)', () => {
    const r = trace('No figures here.', 'Anything 42')
    expect(r.numbers).toEqual([])
    expect(r.verdict).toBe('clean')
  })

  it('rows that add up reconcile', () => {
    const r = reconcile({
      rows: [
        { label: 'a', amount: '10.10' },
        { label: 'b', amount: '20.20' },
        { label: 'c', amount: '0.01' },
      ],
      total: '30.31',
    })
    expect(r).toMatchObject({ ok: true, sum: '30.31', total: '30.31', difference: '0' })
  })
})

describe('laundering outputs are flagged on positive evidence', () => {
  it('an invented number is untraced', () => {
    const r = trace('Revenue was $9,999.', 'Revenue was $1,234.')
    expect(find(r, '$9,999').status).toBe('untraced')
    expect(r.verdict).toBe('untraced')
  })

  it('a number from the wrong unit does not trace: 45% against 45 dollars', () => {
    const r = trace('Margin was 45%.', 'The invoice was 45 dollars.')
    expect(find(r, '45%').status).toBe('untraced')
    expect(find(r, '45%').nearMisses?.[0]).toMatchObject({ reason: 'unit-differs' })
    expect(r.verdict).toBe('untraced')
  })

  it('a dollar amount against a euro amount does not trace', () => {
    const r = trace('Price: $100', 'Price: €100')
    expect(find(r, '$100').status).toBe('untraced')
  })

  it('13% never traces to 12.34%', () => {
    const r = trace('Growth was 13%.', 'Growth: 12.34%')
    expect(find(r, '13%').status).toBe('untraced')
    expect(r.verdict).toBe('untraced')
  })

  it('a percent change computed wrong is untraced even with derivations on', () => {
    // 80 -> 100 is +25%. 30% is not any derivation of the two numbers.
    const r = trace('Sales grew 30%.', 'Last year $80. This year $100.', {
      derivations: ['sum', 'difference', 'ratio', 'percent-change', 'percent-of'],
    })
    expect(find(r, '30%').status).toBe('untraced')
    expect(r.verdict).toBe('untraced')
  })

  it('the classic inversion (dividing by the new value) is unknown, never a clean pass', () => {
    // 20% is the change from 100 down to 80, the reverse of the order the evidence
    // mentions the numbers. Direction needs a reader, so the kit says it cannot tell.
    const r = trace('Sales grew 20%.', 'Last year $80. This year $100.', {
      derivations: ['sum', 'difference', 'ratio', 'percent-change', 'percent-of'],
    })
    expect(find(r, '20%')).toMatchObject({ status: 'unknown', reason: 'derivation-direction' })
    expect(r.verdict).toBe('unknown')
    // The same number with the evidence in the other order is a normal derived value.
    const down = trace('Sales fell 20%.', 'Last year $100. This year $80.', { derivations: ['percent-change'] })
    expect(find(down, '20%').status).toBe('derived')
    // A minus sign says "fell" while the evidence order says "rose": still cannot tell.
    const signed = trace('Sales moved -20%.', 'Last year $80. This year $100.', { derivations: ['percent-change'] })
    expect(find(signed, '-20%').status).toBe('unknown')
  })

  it('a derived number is untraced when derivations are off (the default)', () => {
    const r = trace('Combined revenue was $300.75.', 'Q1 revenue $100.25. Q2 revenue $200.50.')
    expect(find(r, '$300.75').status).toBe('untraced')
    expect(r.verdict).toBe('untraced')
  })

  it('a flipped sign is untraced: -5% against 5%', () => {
    const r = trace('Sales fell -5%.', 'Sales moved 5%.')
    expect(find(r, '-5%').status).toBe('untraced')
  })

  it('a dropped sign is still traced but marked', () => {
    const r = trace('Sales fell 5%.', 'Sales moved -5%.')
    expect(find(r, '5%')).toMatchObject({ status: 'traced', signDiffers: true })
    expect(trace('Sales fell 5%.', 'Sales moved -5%.', { signMode: 'magnitude' }).verdict).toBe('clean')
  })

  it('candidate-cap overflow is unknown, never traced and never untraced', () => {
    // 30 evidence numbers make 435 pairs; a cap of 50 cannot be searched.
    const evidence = Array.from({ length: 30 }, (_, i) => `item ${i * 7 + 1000}`).join('. ')
    // 1000 + 1007 = 2007 would be a real sum, but the search is capped.
    const r = trace('The total was 2007.', evidence, { derivations: ['sum'], maxCandidates: 50, ignoreYears: false })
    expect(find(r, '2007')).toMatchObject({ status: 'unknown', reason: 'candidate-cap' })
    expect(r.verdict).toBe('unknown')
    expect(r.candidateCapHit).toBe(true)
    // With room to search the same sum is found.
    const roomy = trace('The total was 2007.', evidence, { derivations: ['sum'], maxCandidates: 5000, ignoreYears: false })
    expect(find(roomy, '2007').status).toBe('derived')
  })

  it('an unrelated number is still untraced when the cap is hit only if the search was complete', () => {
    const evidence = Array.from({ length: 30 }, (_, i) => `item ${i * 7 + 1000}`).join('. ')
    const r = trace('The total was 123456789.', evidence, { derivations: ['sum'], maxCandidates: 50 })
    expect(find(r, '123456789').status).toBe('unknown')
  })

  it('an ambiguous reading that only matches under the other reading is unknown', () => {
    // "1.234" under en-US is 1.234, but could be 1,234 written the German way.
    const r = trace('There were 1.234 orders.', 'There were 1234 orders.')
    expect(find(r, '1.234')).toMatchObject({ status: 'unknown' })
    expect(find(r, '1.234').token.ambiguous).toBe(true)
    expect(r.verdict).toBe('unknown')
    // Same text on both sides: the primary readings agree, so it traces.
    const same = trace('There were 1.234 orders.', 'There were 1.234 orders.')
    expect(find(same, '1.234')).toMatchObject({ status: 'traced' })
  })

  it('an ambiguous reading that matches nothing is still untraced', () => {
    const r = trace('There were 7.321 orders.', 'There were 1234 orders.')
    expect(find(r, '7.321').status).toBe('untraced')
  })

  it('an ambiguous day/month order is unknown against a different-looking date', () => {
    const r = trace('Due 10/12/2026.', 'Due date: 2026-10-12')
    expect(r.numbers.map((n) => n.status)).toContain('unknown')
    expect(r.verdict).toBe('unknown')
    // An unambiguous date traces component by component.
    const ok = trace('Due 2026-10-12.', 'Due date: October 12, 2026')
    expect(ok.verdict).toBe('clean')
  })

  it('wrong rows-versus-total by one cent is flagged', () => {
    const r = reconcile({
      rows: [{ label: 'a', amount: '10.10' }, { label: 'b', amount: '20.20' }],
      total: '30.31',
    })
    expect(r).toMatchObject({ ok: false, sum: '30.30', total: '30.31', difference: '-0.01' })
    // A one-cent tolerance accepts the same input.
    expect(
      reconcile({ rows: [{ label: 'a', amount: '10.10' }, { label: 'b', amount: '20.20' }], total: '30.31', tolerance: '0.01' }).ok,
    ).toBe(true)
  })

  it('floats are rejected, integers are minor units', () => {
    expect(() => reconcile({ rows: [{ label: 'a', amount: 0.1 }, { label: 'b', amount: 0.2 }], total: 0.3 })).toThrow(TypeError)
    const r = reconcile({ rows: [{ label: 'a', amount: 1010 }, { label: 'b', amount: 2020 }], total: 3030 })
    expect(r).toMatchObject({ ok: true, sum: '30.30' })
  })

  it('named components: paid + reserve = incurred', () => {
    expect(reconcileComponents({ parts: { paid: '1000.00', reserve: '250.50' }, total: '1250.50' }).ok).toBe(true)
    const bad = reconcileComponents({ parts: { paid: '1000.00', reserve: '250.50' }, total: '1250.00' })
    expect(bad).toMatchObject({ ok: false, difference: '0.50' })
  })
})

describe('hostile inputs', () => {
  it('lone surrogates do not break extraction or offsets', () => {
    const text = 'a\uD800 5% \uDC00 and 7'
    const tokens = extractNumbers(text)
    expect(tokens.map((t) => t.raw)).toEqual(['5%', '7'])
    for (const t of tokens) expect(text.slice(t.start, t.end)).toBe(t.raw)
    expect(() => trace(text, 'x \uD800 5% 7')).not.toThrow()
  })

  it('full-width digits are folded to ASCII (NFKC-style) with offsets in the original text', () => {
    const text = 'Rate １２．５％ today'
    const [t] = extractNumbers(text)
    expect(t).toMatchObject({ raw: '１２．５％', value: '12.5', kind: 'percent', unit: '%' })
    expect(text.slice(t?.start, t?.end)).toBe('１２．５％')
    expect(trace('Rate １２．５％', 'Rate 12.5%').verdict).toBe('clean')
  })

  it('Arabic-Indic digits are folded to ASCII', () => {
    const [t] = extractNumbers('نسبة ٤٥%')
    expect(t).toMatchObject({ value: '45', kind: 'percent' })
    expect(trace('٤٥%', 'rate 45%').verdict).toBe('clean')
  })

  it('superscripts glued to a number make it ambiguous, and an ambiguous output is unknown', () => {
    const [t] = extractNumbers('area 10² m')
    expect(t).toMatchObject({ ambiguous: true, ambiguity: 'superscript' })
    const r = trace('area 10² m', 'area 10')
    expect(r.numbers[0]?.status).toBe('unknown')
    expect(r.verdict).toBe('unknown')
  })

  it('numbers glued to letters: model names and version strings are identifiers, not numbers', () => {
    expect(extractNumbers('The X3 and v2.1 and COVID-19 and H2O and GPT-4 and 5G and A4')).toEqual([])
  })

  it('numbers with a recognized unit keep the unit', () => {
    const tokens = extractNumbers('5kg, 20 mg, 3 days, 10x')
    expect(tokens.map((t) => [t.value, t.unit])).toEqual([['5', 'kg'], ['20', 'mg'], ['3', 'day'], ['10', 'x']])
  })

  it('a magnitude suffix without currency is ambiguous (4K is 4000 or a label)', () => {
    const [t] = extractNumbers('a 4K display')
    expect(t).toMatchObject({ value: '4000', ambiguous: true, ambiguity: 'suffix' })
    expect(t?.alternates?.[0]).toMatchObject({ value: '4' })
    const [c] = extractNumbers('costs $4K')
    expect(c).toMatchObject({ value: '4000', ambiguous: false, kind: 'currency' })
  })

  it('a 200k-character output is processed in linear time', () => {
    const chunk = 'Revenue was $1,234.50 (up 12.5%) across 3 regions; see v2.1 and X3. '
    const big = chunk.repeat(Math.ceil(200_000 / chunk.length))
    expect(big.length).toBeGreaterThanOrEqual(200_000)
    const r = trace(big, 'Revenue $1,234.50, growth 12.5%, 3 regions')
    expect(r.verdict).toBe('clean')
    expect(r.numbers.length).toBeGreaterThan(8000)
  })
})
