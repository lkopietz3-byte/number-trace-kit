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
    const r = trace('The total was 2,007.', evidence, { derivations: ['sum'], maxCandidates: 50, ignoreYears: false })
    expect(find(r, '2,007')).toMatchObject({ status: 'unknown', reason: 'candidate-cap' })
    expect(r.verdict).toBe('unknown')
    expect(r.candidateCapHit).toBe(true)
    // With room to search the same sum is found.
    const roomy = trace('The total was 2,007.', evidence, { derivations: ['sum'], maxCandidates: 5000, ignoreYears: false })
    expect(find(roomy, '2,007').status).toBe('derived')
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

// ---- 0.1.0 release: M1, an unread number is never silently dropped --------------------------------

describe('M1 false-pass:F01 and hostile:F2: glued units are read, not skipped', () => {
  const rows: [string, string, string, string][] = [
    ['250W', 'The charger delivers 250W.', 'The charger delivers 200W.', 'untraced'],
    ['940Mbps', 'Speed is 940Mbps.', 'Speed is 300Mbps.', 'untraced'],
    ['450kcal', 'It has 450kcal.', 'It has 250kcal.', 'untraced'],
    ['5000mAh', 'Battery: 5000mAh.', 'Battery: 3000mAh.', 'untraced'],
    ['45days', 'Payment terms are 45days.', 'Payment terms are 30 days.', 'untraced'],
    ['250bp', 'Spread widened 250bp.', 'Spread widened 25bp.', 'untraced'],
    ['9000KG', 'Weight is 9000KG.', 'Weight is 900 kg.', 'untraced'],
    ['900MS', 'Response took 900MS.', 'Response took 90 ms.', 'untraced'],
    ['first-100-days', 'A first-100-days plan.', 'The first 90 days matter.', 'untraced'],
    ['_12.5%_', 'Margin _12.5%_ today.', 'Margin 40% today.', 'untraced'],
    ['3X', 'Sales grew 3X.', 'Sales grew 10X.', 'untraced'],
  ]
  for (const [name, output, evidence, verdict] of rows) {
    it(`false-pass:F01 ${name} against a different figure is ${verdict}`, () => {
      const r = trace(output, evidence)
      expect(r.verdict).toBe(verdict)
      expect(r.numbers.length).toBeGreaterThan(0)
    })
  }

  it('hostile:F2 the same figure written the same way is clean', () => {
    for (const [out, ev] of [
      ['The charger delivers 250W.', 'The charger delivers 250W.'],
      ['Speed is 940Mbps.', 'Speed is 940 Mbps.'],
      ['Payment terms are 45days.', 'Payment terms are 45 days.'],
      ['Spread widened 250bp.', 'Spread widened 250bp.'],
      ['Weight is 9000KG.', 'Weight is 9000 kg.'],
      ['A first-100-days plan.', 'The first 100 days matter.'],
      ['Margin _12.5%_ today.', 'Margin 12.5% today.'],
    ] as const) {
      expect(trace(out, ev).verdict, `${out} | ${ev}`).toBe('clean')
    }
  })

  it('hostile:F2 kebab prose with a unit word is read as a quantity', () => {
    const r = trace('Growth was year-over-year-12-percent.', 'Growth was 40%.')
    expect(r.verdict).toBe('untraced')
    expect(r.numbers[0]?.token).toMatchObject({ value: '12', kind: 'percent' })
    expect(trace('revenue-of-9999-dollars', 'revenue was $5').verdict).toBe('untraced')
  })

  it('hostile:F2 the glued units listed in the plan are read with their unit', () => {
    const units: [string, string][] = [
      ['250W', 'W'], ['250kW', 'kW'], ['2MW', 'MW'], ['50Hz', 'Hz'], ['3kHz', 'kHz'], ['3MHz', 'MHz'], ['3GHz', 'GHz'],
      ['60dB', 'dB'], ['450kcal', 'kcal'], ['90cal', 'cal'], ['5000mAh', 'mAh'], ['20Wh', 'Wh'], ['20kWh', 'kWh'],
      ['7nm', 'nm'], ['7mm', 'mm'], ['7cm', 'cm'], ['7km', 'km'], ['7m', 'm'], ['940Mbps', 'Mbps'], ['1Gbps', 'Gbps'],
      ['10kbps', 'kbps'], ['45days', 'day'], ['3d', 'day'], ['3hrs', 'hour'], ['3h', 'hour'], ['3min', 'minute'],
      ['3wk', 'week'], ['3mo', 'month'], ['3yr', 'year'], ['3y', 'year'], ['250bp', 'bp'], ['3x', 'x'], ['3X', 'x'],
    ]
    for (const [text, unit] of units) {
      const t = extractNumbers(`Value ${text} here`)
      expect(t.map((x) => x.unit), text).toEqual([unit])
    }
  })
})

describe('M1 false-pass:F10: a comma chain after a letter prefix is skipped whole', () => {
  it('false-pass:F10 Rs1,500 is not read as 500 and the verdict is not clean', () => {
    expect(extractNumbers('RM1,234.50 kr1,234 H2,500 units')).toEqual([])
    const r = trace('Fee is Rs1,500', 'Fee is 500')
    expect(r.verdict).not.toBe('clean')
    expect(r.numbers).toEqual([])
    expect(r.skipped.map((s) => s.raw)).toEqual(['Rs1,500'])
    expect(r.skipped[0]).toMatchObject({ reason: 'unread-glued-form', start: 7, end: 14 })
  })
  it('false-pass:F10 other letter-prefixed chains stay whole', () => {
    expect(extractNumbers('Q3,234 and FY2025,234 and x86,000')).toEqual([])
    expect(trace('Q3,234 and FY2025,234 and x86,000', 'x').skipped.map((s) => s.raw)).toEqual(['Q3,234', 'FY2025,234', 'x86,000'])
  })
})

describe('M1 false-pass:F01: result.skipped and counts.skipped', () => {
  it('false-pass:F01 identifiers are listed with their offsets and do not change a clean verdict', () => {
    const text = 'Model X3 runs v2.1 on an iPhone15 with 5 GB.'
    const r = trace(text, 'The X3 runs v2.1 on an iPhone15 with 5 GB.')
    expect(r.verdict).toBe('clean')
    expect(r.skipped.map((s) => [s.raw, s.reason])).toEqual([['X3', 'identifier'], ['v2.1', 'identifier'], ['iPhone15', 'identifier']])
    for (const s of r.skipped) expect(text.slice(s.start, s.end)).toBe(s.raw)
    expect(r.counts.skipped).toBe(r.skipped.length)
    expect(r.counts.skipped).toBe(3)
  })

  it('false-pass:F01 an unread glued form turns clean into unknown and is listed', () => {
    const r = trace('The part is 12foo long.', 'The part is 12 long.')
    expect(r.numbers).toEqual([])
    expect(r.verdict).toBe('unknown')
    expect(r.skipped).toEqual([{ raw: '12foo', start: 12, end: 17, reason: 'unread-glued-form' }])
    expect(r.counts.skipped).toBe(1)
  })

  it('false-pass:F01 an untraced number still outranks an unread form', () => {
    expect(trace('12foo and 99', 'x 12').verdict).toBe('untraced')
  })

  it('false-pass:F01 ignore and ignorePattern clear an unread form without hiding it from the list', () => {
    const a = trace('The part is 12foo long.', 'x', { ignore: ['12foo'] })
    expect(a.verdict).toBe('clean')
    expect(a.skipped[0]).toMatchObject({ raw: '12foo', reason: 'ignored' })
    expect(trace('The part is 12foo long.', 'x', { ignorePattern: /\d+foo/ }).verdict).toBe('clean')
  })

  it('false-pass:F01 an output given as tokens has nothing skipped', () => {
    const tokens = extractNumbers('5 apples')
    const r = traceNumbers(tokens, 'there are 5 apples')
    expect(r.skipped).toEqual([])
    expect(r.counts.skipped).toBe(0)
  })

  it('false-pass:F01 known identifier shapes stay identifiers, not unknowns', () => {
    for (const text of ['a 3D print', 'on 5G', 'with 2FA', 'a 4WD truck', 'in 1080p', 'x86_64', 'COVID-19', 'F-16', 'Llama-3.3-70B-Instruct', '192.168.1.1', '0x1F']) {
      const r = trace(text, 'x')
      expect(r.verdict, text).toBe('clean')
      expect(r.skipped.length, text).toBeGreaterThan(0)
      expect(r.skipped.every((s) => s.reason === 'identifier'), text).toBe(true)
    }
  })

  it('hostile:F2 underscores and filler around a number do not hide it', () => {
    expect(extractNumbers('_12.5%_ and __1,234__ and 1766____').map((t) => t.raw)).toEqual(['12.5%', '1,234', '1766'])
    expect(extractNumbers('foo_12 and x_1').map((t) => t.raw)).toEqual([])
    // gate-review:F03: digits joined by underscores in groups of three are one number (12_000 is 12,000), no longer a name.
    expect(extractNumbers('foo_12 and 12_000 and x_1').map((t) => t.raw)).toEqual(['12_000'])
  })
})

describe('M1 false-pass:F01: the silent-skip sweep', () => {
  // 121 glued suffixes (the audit list). A wrong figure must never come back clean with nothing
  // examined and nothing listed.
  const suffixes = ['Mbps', 'Gbps', 'kbps', 'Kbps', 'mW', 'W', 'kW', 'GW', 'MWh', 'GWh', 'mg', 'µg', 'mcg', 'ng', 'dB', 'Hz', 'kHz', 'rpm', 'fps', 'mpg', 'ppm', 'ppb', 'psi', 'bar', 'kPa', 'MPa', 'Pa', 'J', 'kJ', 'cal', 'kcal', 'mol', 'mmol', 'nm', 'µm', 'dl', 'dL', 'mmHg', 'ha', 'sqft', 'sf', 'ct', 'pcs', 'pc', 'bbl', 'lbs', 't', 'kt', 'Mt', 'GT', 'Gt', 'TWh', 'bp', 'bps', 'pp', 'pt', 'C', 'F', 'mph', 'kn', 'knots', 'TiB', 'GiB', 'MiB', 'KiB', 'Mb', 'Gb', 'Tb', 'Kb', 'kb', 'B', 'b', 'PB', 'EB', 'ms', 'ns', 'us', 'µs', 'd', 'w', 'wk', 'y', 'Q', 'V', 'mV', 'A', 'mA', 'Ah', 'mAh', 'Wh', 'VA', 'ohm', 'lm', 'lx', 'in', 'ac', 'yd', 'nmi', 'gal', 'qt', 'fl', 'tsp', 'tbsp', 'cup', 'bu', 'dz', 'gr', 'cwt', 'X', 'KG', 'Kg', 'KM', 'Km', 'MM', 'Y', 'D', 'H', 'S', 'mb', 'gb', 'tb']
  it('false-pass:F01 no glued suffix returns clean with numbers empty and the form unlisted', () => {
    expect(suffixes.length).toBe(121)
    const bad: string[] = []
    let readOrUnknown = 0
    for (const u of suffixes) {
      const r = trace(`Value 5${u} here`, 'Value 7 here')
      const listed = r.skipped.some((s) => s.raw.includes('5'))
      if (r.numbers.length === 0 && !listed) bad.push(u)
      if (r.numbers.length > 0 || r.verdict === 'unknown') readOrUnknown++
    }
    expect(bad).toEqual([])
    expect(readOrUnknown).toBeGreaterThanOrEqual(100)
  })
})

describe('M1 hostile:F2: digits the kit cannot fold are listed, not dropped', () => {
  it('hostile:F2 mathematical digits are an unread form and the verdict is unknown', () => {
    const r = trace('Revenue grew \u{1d7d5}\u{1d7d6}% this year.', 'Revenue grew 98% this year.')
    expect(r.skipped).toEqual([{ raw: '\u{1d7d5}\u{1d7d6}', start: 13, end: 17, reason: 'unread-glued-form' }])
    expect(r.verdict).toBe('unknown')
  })
  it('hostile:F2 the astral digit table covers every decimal digit the runtime knows', () => {
    for (let cp = 0x10000; cp <= 0x1ffff; cp++) {
      const ch = String.fromCodePoint(cp)
      if (!/^\p{Nd}$/u.test(ch)) continue
      expect(trace(`x ${ch} y`, 'x').skipped.length, cp.toString(16)).toBe(1)
    }
  })
})

// ---- 0.1.0 release: M4, magnitude words and vulgar fractions ---------------------------------------

describe('M4 false-pass:F05: magnitude words with a fixed value are read', () => {
  it('false-pass:F05 lakh and crore are different magnitudes', () => {
    expect(trace('Price is ₹5 lakh', 'Price is ₹5 crore').verdict).toBe('untraced')
    expect(trace('Price is ₹5 lakh', 'Price is ₹5 lakh').verdict).toBe('clean')
    expect(trace('Price is ₹5 lakh', 'Price is ₹500,000').verdict).toBe('clean')
    expect(trace('Price is ₹5 crore', 'Price is ₹50,000,000').verdict).toBe('clean')
    expect(extractNumbers('₹5 lakh, ₹2 lakhs, ₹3 lac, ₹1.5 crore, ₹4 crores').map((t) => t.value)).toEqual(['500000', '200000', '300000', '15000000', '40000000'])
  })
  it('false-pass:F05 Millionen is not Milliarden (de-DE)', () => {
    expect(trace('Umsatz: 3,5 Millionen', 'Umsatz: 3,5 Milliarden', { locale: 'de-DE' }).verdict).toBe('untraced')
    expect(trace('Umsatz: 3,5 Millionen', 'Umsatz: 3.500.000', { locale: 'de-DE' }).verdict).toBe('clean')
    expect(trace('Umsatz: 3,5 Milliarden', 'Umsatz: 3.500.000.000', { locale: 'de-DE' }).verdict).toBe('clean')
  })
  it('false-pass:F05 and F19 3,5 Mio. € traces to 3.500.000 €', () => {
    const r = trace('Umsatz: 3,5 Mio. €.', 'Umsatz: 3.500.000 €', { locale: 'de-DE' })
    expect(r.verdict).toBe('clean')
    expect(r.numbers[0]?.token).toMatchObject({ value: '3500000', currency: 'EUR', kind: 'currency' })
    expect(r.numbers[0]?.token.raw).toBe('3,5 Mio. €')
    expect(trace('3,5 Mio. € Umsatz', '3.500.000 €', { locale: 'de-DE' }).verdict).toBe('clean')
    expect(trace('3,5 Mrd. €', '3.500.000 €', { locale: 'de-DE' }).verdict).toBe('untraced')
    // The dot after an abbreviation that ends a sentence is not part of the number.
    expect(extractNumbers('Wir hatten 5 Mio. Der Rest', { locale: 'de-DE' })[0]?.raw).toBe('5 Mio')
  })
  it('false-pass:F05 $5 Mio is not $5, and MM, mil, hundred and Tausend are magnitudes', () => {
    expect(trace('Revenue was $5 Mio', 'Revenue was $5').verdict).toBe('untraced')
    expect(trace('Revenue was $1.2 MM', 'Revenue was $1.2 million').verdict).toBe('clean')
    expect(trace('Revenue was $1.2MM', 'Revenue was $1.2 million').verdict).toBe('clean')
    expect(trace('Revenue was $5 million', 'Revenue was $5 mil').verdict).toBe('clean')
    expect(trace('Revenue was $5 mil', 'Revenue was $5 million').verdict).toBe('clean')
    expect(trace('Revenue was $5 hundred', 'Revenue was $5').verdict).toBe('untraced')
    expect(trace('Revenue was $5 hundred', 'Revenue was $500').verdict).toBe('clean')
    expect(trace('Es sind 5 Tausend', 'Es sind 5000', { locale: 'de-DE' }).verdict).toBe('clean')
    expect(trace('$5 M', '$5 million').verdict).toBe('clean')
    expect(trace('$5 M', '$5').verdict).toBe('untraced')
    expect(trace('5 mln zł', '5 000 000 zł', { locale: 'pl-PL' }).verdict).toBe('clean') // zł is not a known currency: both are bare counts
    expect(extractNumbers('5 mln').map((t) => t.value)).toEqual(['5000000'])
    expect(extractNumbers('€5 Mrd').map((t) => [t.value, t.currency])).toEqual([['5000000000', 'EUR']])
  })
  it('false-pass:F05 CJK 万 and 億/亿 are read, with the currency that follows', () => {
    expect(extractNumbers('350万円').map((t) => [t.value, t.currency, t.kind])).toEqual([['3500000', 'JPY', 'currency']])
    expect(extractNumbers('売上は12億円').map((t) => [t.value, t.currency])).toEqual([['1200000000', 'JPY']])
    expect(extractNumbers('营收5亿元').map((t) => [t.value, t.currency])).toEqual([['500000000', 'CNY']])
    expect(extractNumbers('3.5万').map((t) => [t.value, t.scale])).toEqual([['35000', -3]])
    expect(trace('350万円', '3,500,000円').verdict).not.toBe('clean')
    expect(trace('売上は350万', '売上は3,500,000').verdict).toBe('clean')
    expect(trace('売上は350万', '売上は350億').verdict).toBe('untraced')
    // A yen amount with no magnitude word is unchanged: the number is read, the yen sign is not.
    expect(extractNumbers('売上は1,234円で').map((t) => t.raw)).toEqual(['1,234'])
  })
})

describe('M4 false-pass:F05 and hostile:F1: a magnitude word the kit cannot value is unknown', () => {
  const unread: [string, string, string?][] = [
    ['Es gibt 2 Billionen', 'Es gibt 2', 'de-DE'],
    ['Cuesta 3 mil', 'Cuesta 3', 'es-ES'],
    ['It was 5 Cr', 'It was 5'],
    ['Он вырос на 5 млн', 'Он вырос на 5', 'ru-RU'],
    ['3 억 원', '3', 'ko-KR'],
    ['売上は5千', '売上は5', 'ja-JP'],
    ['1 hundred thousand', '1'],
    ['₹3 lakh crore', '₹3'],
    ['Det finns 5 tusen', 'Det finns 5', 'sv-SE'],
    ['Il y a 5 mille', 'Il y a 5', 'fr-FR'],
    ['Er zijn 5 duizend', 'Er zijn 5', 'nl-NL'],
    ['Zysk 3 bln', 'Zysk 3', 'pl-PL'],
    ['It was 2 billion', 'It was 2', 'de-DE'],
  ]
  for (const [out, ev, locale] of unread) {
    it(`false-pass:F05 "${out}" is unknown (unread-magnitude), never clean`, () => {
      const options = locale === undefined ? undefined : { locale }
      const r = trace(out, ev, options)
      expect(r.verdict).toBe('unknown')
      const reasons = r.numbers.map((n) => n.reason)
      expect(reasons).toContain('unread-magnitude')
      expect(r.numbers.find((n) => n.reason === 'unread-magnitude')?.token).toMatchObject({ ambiguous: true, ambiguity: 'magnitude' })
    })
  }
  it('false-pass:F05 the same unread phrase written the same way in the evidence traces', () => {
    expect(trace('Es gibt 2 Billionen', 'Es gibt 2 Billionen', { locale: 'de-DE' }).verdict).toBe('clean')
    // A currency word after the phrase makes it a different phrase.
    expect(trace('Es gibt 2 Billionen', 'Es gibt 2 Billionen Euro', { locale: 'de-DE' }).verdict).toBe('unknown')
    expect(trace('Es gibt 2 Billionen', 'Es gibt 2 Milliarden', { locale: 'de-DE' }).verdict).toBe('unknown')
  })
  it('false-pass:F05 an unread magnitude in the evidence only ever makes an output number unknown', () => {
    const r = trace('There were 5.', 'There were 5 Cr.')
    expect(r.numbers[0]).toMatchObject({ status: 'unknown', reason: 'ambiguous-reading' })
  })
  it('false-pass:F05 English billion is unchanged, other locales do not guess a long or short scale', () => {
    expect(extractNumbers('2 billion and 3 trillion').map((t) => t.value)).toEqual(['2000000000', '3000000000000'])
    expect(extractNumbers('2 billion', { locale: 'de-DE' })[0]).toMatchObject({ ambiguous: true, ambiguity: 'magnitude' })
  })
})

describe('M4 false-pass:F19: percent words in other languages', () => {
  it('false-pass:F19 Prozent, procent, pour cent, por ciento and per cento are percent', () => {
    expect(trace('Rate of 12,5 Prozent', 'Rate of 12,5 %', { locale: 'de-DE' }).verdict).toBe('clean')
    expect(trace('Rate of 12,5 %', 'Rate of 12,5 Prozent', { locale: 'de-DE' }).verdict).toBe('clean')
    expect(trace('12,5 Prozent', '12,5 %', { locale: 'de-DE' }).numbers[0]?.token).toMatchObject({ kind: 'percent', value: '12.5' })
    for (const [text, locale] of [['12,5 pour cent', 'fr-FR'], ['12,5 por ciento', 'es-ES'], ['12,5 por cento', 'pt-PT'], ['12,5 per cento', 'it-IT'], ['12,5 procent', 'nl-NL'], ['12,5 procent', 'sv-SE'], ['12,5 prosent', 'nb-NO']] as const) {
      expect(trace(text, '12,5 %', { locale }).verdict, text).toBe('clean')
    }
    expect(trace('12,5 Prozent', '13,5 %', { locale: 'de-DE' }).verdict).toBe('untraced')
    expect(trace('2 Prozentpunkte', '2 pp', { locale: 'de-DE' }).verdict).toBe('clean')
    expect(extractNumbers('12 Prozent').map((t) => [t.kind, t.unit])).toEqual([['percent', '%']])
  })
  it('false-pass:F19 Euro after a magnitude is the currency', () => {
    expect(trace('Umsatz: 3,5 Millionen Euro', 'Umsatz: 3.500.000 Euro', { locale: 'de-DE' }).verdict).toBe('clean')
    expect(trace('Umsatz: 3,5 Millionen Euro', 'Umsatz: 3.500.000 €', { locale: 'de-DE' }).verdict).toBe('clean')
  })
})

describe('M4 false-pass:F11 and hostile:F1: vulgar fractions', () => {
  it('false-pass:F11 3½ against 3 is unknown, never clean', () => {
    const r = trace('Raise 3½ points', 'Raise 3 points')
    expect(r.verdict).toBe('unknown')
    expect(r.numbers[0]?.token).toMatchObject({ raw: '3½', value: '3.5', ambiguous: true, ambiguity: 'fraction' })
    expect(r.numbers[0]?.status).toBe('unknown')
  })
  it('hostile:F1 $5½ against $5 and 1½ hours against 1 hour are unknown', () => {
    const a = trace('The price rose to $5½.', 'The price is $5.')
    expect(a.verdict).toBe('unknown')
    expect(a.numbers[0]?.token).toMatchObject({ raw: '$5½', value: '5.5', currency: 'USD', ambiguity: 'fraction' })
    expect(trace('It took 1½ hours.', 'It took 1 hour.').verdict).toBe('unknown')
    expect(trace('It took 1 ½ hours.', 'It took 1 hour.').verdict).toBe('unknown')
  })
  it('hostile:F1 ¼% and 2¼% keep their percent sign', () => {
    const t = extractNumbers('Conversion is ¼% higher, and 2¼% overall.')
    expect(t.map((x) => [x.raw, x.value, x.scale, x.kind, x.unit, x.ambiguity])).toEqual([
      ['¼%', '0.25', 2, 'percent', '%', 'fraction'],
      ['2¼%', '2.25', 2, 'percent', '%', 'fraction'],
    ])
    expect(trace('Conversion is ¼% higher.', 'Conversion is 25% higher.').verdict).toBe('untraced')
    expect(trace('Conversion is ¼% higher.', 'Conversion is 0.25% higher.').verdict).toBe('unknown')
  })
  it('hostile:F1 a magnitude after a vulgar fraction stays attached', () => {
    const [t] = extractNumbers('$1¾ million')
    expect(t).toMatchObject({ value: '1750000', currency: 'USD', ambiguity: 'fraction' })
    expect(trace('$1¾ million', '$1 million').verdict).toBe('unknown')
  })
  it('hostile:F1 the same fraction written the same way traces', () => {
    expect(trace('It took 1½ hours.', 'It took 1½ hours.').verdict).toBe('clean')
    expect(trace('It took 1½ hours.', 'It took 1½ days.').verdict).not.toBe('clean')
    expect(trace('Rate ¼%', 'Rate ¼%').verdict).toBe('clean')
    expect(trace('Rate ¼%', 'Rate ¼ percent').verdict).toBe('unknown')
  })
  it('hostile:F1 a fraction that has no exact decimal is skipped as an unread form', () => {
    const r = trace('About ⅓ of users and 2⅔ hours', 'About 33% of users')
    expect(r.numbers).toEqual([])
    expect(r.skipped.map((s) => [s.raw, s.reason])).toEqual([['⅓', 'unread-glued-form'], ['2⅔', 'unread-glued-form']])
    expect(r.verdict).toBe('unknown')
    expect(trace('Total ⅞', 'Total 0.875').numbers[0]?.token).toMatchObject({ value: '0.875', ambiguity: 'fraction' })
  })
  it('hostile:F1 the fraction slash is a slash: 5⁄2 is unknown like 5/2', () => {
    const slash = trace('Total 5⁄2', 'Total 5 and 1 and 2')
    const ascii = trace('Total 5/2', 'Total 5 and 1 and 2')
    expect(slash.verdict).toBe('unknown')
    expect(slash.verdict).toBe(ascii.verdict)
    expect(slash.numbers.map((n) => [n.token.raw, n.status])).toEqual(ascii.numbers.map((n) => [n.token.raw, n.status]))
    expect(extractNumbers('5⁄2').map((t) => t.ambiguity)).toEqual(['fraction', 'fraction'])
  })
  it('hostile:F1 every vulgar fraction character is accounted for', () => {
    const chars = ['¼', '½', '¾', '⅐', '⅑', '⅒', '⅓', '⅔', '⅕', '⅖', '⅗', '⅘', '⅙', '⅚', '⅛', '⅜', '⅝', '⅞', '↉']
    for (const ch of chars) {
      const r = trace(`Of ${ch} total`, 'x')
      expect(r.numbers.length + r.skipped.length, ch).toBe(1)
      expect(r.verdict, ch).toBe(r.numbers[0]?.status === 'untraced' ? 'untraced' : 'unknown')
    }
  })
})

// ---- 0.1.0 release: M5, unit truth ---------------------------------------------------------------------

describe('M5 false-pass:F02: bits are not bytes, Celsius is not Fahrenheit', () => {
  it('false-pass:F02 Mb is not MB and Gb is not GB, spaced and glued', () => {
    for (const [out, ev] of [
      ['Download 500 Mb', 'Download 500 MB'], ['Plan has 8 Gb', 'Plan has 8 GB'], ['Disk 2 Tb', 'Disk 2 TB'],
      ['Download 500Mb', 'Download 500MB'], ['Plan has 8Gb', 'Plan has 8GB'], ['Link 5 Kb', 'Link 5 KB'],
      ['Download 500 MB', 'Download 500 Mb'], ['Plan has 8GB', 'Plan has 8 Gb'],
    ] as const) {
      const r = trace(out, ev)
      expect(r.verdict, `${out} | ${ev}`).toBe('untraced')
      expect(r.numbers[0]?.nearMisses?.[0]?.reason, out).toBe('unit-differs')
    }
  })
  it('false-pass:F02 the same data unit still traces, and a kilogram is still not a megabyte', () => {
    expect(trace('Download 500 Mb', 'Download 500 Mb').verdict).toBe('clean')
    expect(trace('Download 500 MB', 'Download 500MB').verdict).toBe('clean')
    expect(trace('Plan has 8 GiB', 'Plan has 8 GiB').verdict).toBe('clean')
    expect(trace('Plan has 8 GiB', 'Plan has 8 GB').verdict).toBe('untraced')
    expect(trace('Weight 500 kg', 'Weight 500 MB').verdict).toBe('untraced')
    expect(extractNumbers('5 Mb, 5 MB, 5 PB, 5 Pb').map((t) => t.unit)).toEqual(['Mb', 'MB', 'PB', 'Pb'])
  })
  it('false-pass:F02 an all-lowercase mb, gb, tb or kb is read as bytes (documented); a capital M, G, T or K with a lowercase b is bits', () => {
    expect(extractNumbers('5 mb, 5 gb, 5 tb, 5 kb, 5mb, 5gb').map((t) => t.unit)).toEqual(['MB', 'GB', 'TB', 'KB', 'MB', 'GB'])
    expect(trace('File is 5mb', 'File is 5 MB').verdict).toBe('clean')
    expect(trace('File is 5 mb', 'File is 5 Mb').verdict).toBe('untraced')
    expect(trace('File is 5 Mb', 'File is 5 mb').verdict).toBe('untraced')
    // A form the kit cannot place at all is not a pass either.
    const r = trace('File is 5mB', 'File is 5 MB')
    expect(r.numbers).toEqual([])
    expect(r.skipped).toEqual([{ raw: '5mB', start: 8, end: 11, reason: 'unread-glued-form' }])
    expect(r.verdict).toBe('unknown')
  })
  it('false-pass:F02 30°C is not 30°F, with a space, a word or a single character', () => {
    for (const [out, ev] of [
      ['Temp 30°C', 'Temp 30°F'], ['Temp 30 °C', 'Temp 30 °F'], ['Temp 30℃', 'Temp 30℉'], ['Temp 30° C', 'Temp 30° F'],
      ['Temp 30 degrees Celsius', 'Temp 30 degrees Fahrenheit'], ['Temp 30 Celsius', 'Temp 30 Fahrenheit'], ['Temp 30°C', 'Temp 30 degrees F'],
    ] as const) {
      const r = trace(out, ev)
      expect(r.verdict, `${out} | ${ev}`).toBe('untraced')
      expect(r.numbers[0]?.nearMisses?.[0]?.reason, out).toBe('unit-differs')
    }
    for (const [out, ev] of [
      ['Temp 30°C', 'Temp 30°C'], ['Temp 30 °C', 'Temp 30°C'], ['Temp 30℃', 'Temp 30 degrees Celsius'], ['Temp -5°F', 'Temp -5 °F'],
      ['Temp 30°C.', 'Temp 30 deg C'],
    ] as const) {
      expect(trace(out, ev).verdict, `${out} | ${ev}`).toBe('clean')
    }
    expect(extractNumbers('30°C, 30 °F, 30℃, 98.6°F').map((t) => [t.value, t.unit, t.kind])).toEqual([
      ['30', '°C', 'count'], ['30', '°F', 'count'], ['30', '°C', 'count'], ['98.6', '°F', 'decimal'],
    ])
  })
  it('false-pass:F02 a degree sign that is not a temperature is left alone', () => {
    expect(extractNumbers('45° angle and 30°N and 12°east').map((t) => [t.raw, t.unit])).toEqual([['45', undefined], ['30', undefined], ['12', undefined]])
  })
})

describe('M5 false-pass:F06: a currency code or prefix on a symbol amount is honored', () => {
  it('false-pass:F06 $500 CAD is not $500 USD, and CAD$500 and NT$500 are not US$500', () => {
    expect(trace('Price is $500 CAD.', 'Price is $500 USD.').verdict).toBe('untraced')
    expect(trace('Price is CAD$500.', 'Price is US$500.').verdict).toBe('untraced')
    expect(trace('Price is NT$500.', 'Price is US$500.').verdict).toBe('untraced')
    expect(trace('Price is Mex$500.', 'Price is US$500.').verdict).toBe('untraced')
    expect(trace('Price is CAD$500.', 'Price is CA$500.').verdict).toBe('clean')
    expect(trace('Price is $500 CAD.', 'Price is CA$500.').verdict).toBe('clean')
    expect(trace('Price is Mex$500.', 'Price is MX$500.').verdict).toBe('clean')
    expect(trace('Price is $500 USD.', 'Price is US$500.').verdict).toBe('clean')
    expect(trace('Price is $500 USD.', 'Price is $500.').verdict).toBe('clean')
    expect(trace('Price is $500.', 'Price is $500 USD.').verdict).toBe('clean')
    expect(extractNumbers('CAD$500, NT$500, Mex$500, NZ$500, HK$500, S$500, A$500, R$500, USD$500').map((t) => t.currency)).toEqual(
      ['CAD', 'TWD', 'MXN', 'NZD', 'HKD', 'SGD', 'AUD', 'BRL', 'USD'],
    )
  })
  it('false-pass:F06 a code that overrides the generic dollar sign or yen sign', () => {
    expect(extractNumbers('$500 CAD, $500 AUD, ¥500 JPY, ¥500 CNY, $500 USD').map((t) => t.currency)).toEqual(['CAD', 'AUD', 'JPY', 'CNY', 'USD'])
    expect(extractNumbers('CAD $500 and USD $500').map((t) => [t.raw, t.currency])).toEqual([['CAD $500', 'CAD'], ['USD $500', 'USD']])
    expect(trace('Price is CAD $500.', 'Price is CA$500.').verdict).toBe('clean')
    // The word "dollars" is a generic dollar: it never contradicts a dollar prefix.
    expect(trace('Price is CA$500 dollars.', 'Price is CA$500.').verdict).toBe('clean')
    expect(trace('Price is $500 dollars.', 'Price is $500.').verdict).toBe('clean')
  })
  it('false-pass:F06 $500 EUR contradicts itself: unknown, and never a pass against $500', () => {
    const r = trace('Price is $500 EUR.', 'Price is $500.')
    expect(r.verdict).toBe('unknown')
    expect(r.numbers[0]).toMatchObject({ status: 'unknown', reason: 'conflicting-currency' })
    expect(r.numbers[0]?.token).toMatchObject({ raw: '$500 EUR', ambiguous: true, ambiguity: 'currency' })
    expect(trace('Price is $500 EUR.', 'Price is 500 EUR.').verdict).toBe('unknown')
    expect(trace('Price is CA$500 USD.', 'Price is CA$500.').verdict).toBe('unknown')
    expect(trace('Price is EUR $500.', 'Price is $500.').verdict).toBe('unknown')
    expect(trace('Price is $500 euros.', 'Price is $500.').verdict).toBe('unknown')
    // Written the same way in the evidence, it traces.
    expect(trace('Price is $500 EUR.', 'Price is $500 EUR.').verdict).toBe('clean')
  })
  it('false-pass:F06 a bare number never matches a symbol amount whose code was changed', () => {
    expect(trace('Price is $500 CAD.', 'Price is 500.').verdict).toBe('untraced')
    expect(trace('Price is 500 CAD.', 'Price is $500 CAD.').verdict).toBe('clean')
    expect(trace('Price is 500 CAD.', 'Price is $500.').verdict).toBe('untraced')
  })
})

describe('M5 false-pass:F06 sweep: the same bug in nearby forms', () => {
  it('false-pass:F06 a three-letter code glued to the dollar sign, in any case, is read as written', () => {
    expect(extractNumbers('EUR$500, cad$500, Cad$500, USD$500').map((t) => [t.currency, t.ambiguity])).toEqual([
      ['USD', 'currency'], ['CAD', undefined], ['CAD', undefined], ['USD', undefined],
    ])
    expect(trace('Price is EUR$500.', 'Price is $500.').verdict).toBe('unknown')
    expect(trace('Price is cad$500.', 'Price is $500 USD.').verdict).toBe('untraced')
    expect(trace('Price is cad$500.', 'Price is CA$500.').verdict).toBe('clean')
  })
  it('false-pass:F06 a word before "dollars" names the dollar', () => {
    expect(trace('Price is $500 Canadian dollars.', 'Price is $500 USD.').verdict).toBe('untraced')
    expect(trace('Price is $500 Canadian dollars.', 'Price is CA$500.').verdict).toBe('clean')
    expect(trace('Price is 500 US dollars.', 'Price is $500.').verdict).toBe('clean')
    expect(trace('Price is 500 US dollars.', 'Price is CA$500.').verdict).toBe('untraced')
    expect(trace('Price is 500 Australian dollars.', 'Price is A$500.').verdict).toBe('clean')
    expect(trace('Price is €500 US dollars.', 'Price is €500.').verdict).toBe('unknown')
    // "US" in front of anything else is not a currency.
    expect(extractNumbers('5 US citizens').map((t) => [t.kind, t.currency])).toEqual([['count', undefined]])
  })
  it('false-pass:F06 a range takes the code that one member gives it', () => {
    expect(extractNumbers('$5 to $10 CAD').map((t) => [t.raw, t.currency])).toEqual([['$5', 'CAD'], ['$10 CAD', 'CAD']])
    expect(extractNumbers('$5-10-15 CAD').map((t) => t.currency)).toEqual(['CAD', 'CAD', 'CAD'])
    expect(trace('Fee is $5 to $10 CAD.', 'Fee is $5 and $10 USD.').verdict).toBe('untraced')
    expect(trace('Fee is $5 to $10 CAD.', 'Fee is CA$5 and CA$10.').verdict).toBe('clean')
    expect(trace('Fee is CA$5-10 dollars.', 'Fee is CA$5 and CA$10.').verdict).toBe('clean')
    expect(trace('Fee is $5-10 dollars.', 'Fee is $5 and $10.').verdict).toBe('clean')
  })
  it('false-pass:F06 a range whose members name currencies that cannot agree is unknown', () => {
    for (const out of ['Fee is $5-10 EUR.', 'Fee is $5-10-15 EUR.', 'Fee is CA$5-$10 USD.', 'Fee is ¥5-10 USD.']) {
      const r = trace(out, 'Fee is $5 and $10 and $15.')
      expect(r.verdict, out).toBe('unknown')
      expect(r.numbers.every((n) => n.status === 'unknown' && n.reason === 'conflicting-currency'), out).toBe(true)
    }
    expect(trace('Fee is $5-10 EUR.', 'Fee is $5-10 EUR.').verdict).toBe('clean')
  })
})

describe('M5 false-pass:F02 sweep: bits and bytes in nearby forms', () => {
  it('false-pass:F02 a byte rate is not a bit rate, and the unit words keep the two apart', () => {
    for (const [out, ev] of [
      ['Speed 5 MBps', 'Speed 5 Mbps'], ['Speed 5MBps', 'Speed 5Mbps'], ['Speed 5 Mbps', 'Speed 5 KBps'],
      ['File is 5 megabits', 'File is 5 megabytes'], ['File is 5 Mbit', 'File is 5 MB'], ['File is 5 gigabytes', 'File is 5 Gb'],
      ['Link is 5 kbit', 'Link is 5 KB'], ['Link is 5 terabytes', 'Link is 5 terabits'],
    ] as const) {
      const r = trace(out, ev)
      expect(r.verdict, `${out} | ${ev}`).toBe('untraced')
      expect(r.numbers[0]?.nearMisses?.[0]?.reason, out).toBe('unit-differs')
    }
    expect(extractNumbers('5 MBps, 5 Mbps, 5 mbps, 5 megabits, 5 megabytes, 5Mbit, 5 kbit, 5 KBps').map((t) => t.unit)).toEqual(
      ['MBps', 'Mbps', 'Mbps', 'Mb', 'MB', 'Mb', 'Kb', 'KBps'],
    )
    expect(trace('Speed 5 megabytes', 'Speed 5 MB').verdict).toBe('clean')
    expect(trace('Speed 5 Mbit', 'Speed 5 megabits').verdict).toBe('clean')
    expect(trace('Speed 5 MBps', 'Speed 5 MBps').verdict).toBe('clean')
  })
})

// ---- 0.1.0 release: M6, flags reach counts and the verdict -------------------------------------------------

const HOURS_PAGE = JSON.stringify({ hours: { sun: '9:0-18:0' }, review_stars: 5.0 })

describe('M6 field:F1: a time of day never traces to a unit-less number', () => {
  it('field:F1 "until 5pm" is not cleared by a 5.0 star rating, in strict or report', () => {
    for (const opts of [undefined, { preset: 'strict' as const }, { preset: 'report' as const }]) {
      const r = trace('Open Sunday until 5pm.', HOURS_PAGE, opts)
      expect(r.verdict, JSON.stringify(opts)).toBe('unknown')
      expect(r.numbers[0], JSON.stringify(opts)).toMatchObject({ status: 'unknown', reason: 'unit-unverified' })
    }
    expect(trace('Open Sunday until 5 pm.', HOURS_PAGE).verdict).toBe('unknown')
    expect(trace('Open until 5 days.', HOURS_PAGE).verdict).toBe('unknown')
  })
  it('field:F1 every way of writing am and pm is a time unit', () => {
    // S2: the page prints 9:0, so 9 a.m. now traces to it; the a.m. spelling is checked with a 5 the page does not print as a time.
    for (const out of ['until 5 PM.', 'until 5PM.', 'until 5 p.m.', 'until 5 P.M.', 'until 5 a.m.', 'until 5 Pm.']) {
      expect(trace(`Open ${out}`, HOURS_PAGE).numbers[0], out).toMatchObject({ status: 'unknown', reason: 'unit-unverified' })
    }
    expect(extractNumbers('5pm, 5 PM, 5 p.m., 9 a.m., 9 A.M., 5-6pm').map((t) => [t.raw, t.unit])).toEqual([
      ['5pm', 'pm'], ['5 PM', 'pm'], ['5 p.m.', 'pm'], ['9 a.m.', 'am'], ['9 A.M.', 'am'], ['5', 'pm'], ['6pm', 'pm'],
    ])
    // Not a meridiem: "5 a day", "5 pmt", "10 AMD".
    expect(extractNumbers('5 a day, 5 pmt, 10 AMD').map((t) => t.unit)).toEqual([undefined, undefined, undefined])
    expect(trace('Open until 5 p.m.', 'We close at 5pm daily.').verdict).toBe('clean')
    expect(trace('Open until 5 p.m.', 'We close at 5 am daily.').verdict).toBe('untraced')
  })
  it('field:F1 a time of day is read, never computed from other numbers', () => {
    const r = trace('Open until 5pm.', 'Ask about 3 and 2.', { preset: 'report' })
    expect(r.numbers[0]).toMatchObject({ status: 'untraced' })
    expect(trace('Open until 5pm.', 'Ask about 3 and 2.', { derivations: ['sum'] }).verdict).toBe('untraced')
  })
  it('field:F1 the same clock time written the same way still traces, and another one does not', () => {
    expect(trace('Open until 5pm.', 'We close at 5pm daily.').verdict).toBe('clean')
    expect(trace('Open until 5 pm.', 'We close at 5pm daily.').verdict).toBe('clean')
    expect(trace('Open until 5pm.', 'We close at 5am daily.').verdict).toBe('untraced')
  })
})

describe('M6 false-pass:F09: a unit on one side only is counted, and is unknown unless the caller opted in', () => {
  it('false-pass:F09 a percent or price traces to a bare count only when asked, and counts.unitUnverified says so', () => {
    for (const out of ['Churn was 120%.', 'Cost was $120.']) {
      expect(trace(out, 'We have 120 employees.').verdict, out).toBe('untraced')
      const r = trace(out, 'We have 120 employees.', { preset: 'report' })
      expect(r.verdict, out).toBe('clean')
      expect(r.numbers[0], out).toMatchObject({ status: 'traced', unitUnverified: true })
      expect(r.counts.unitUnverified, out).toBe(1)
      expect(trace(out, 'We have 120 employees.', { allowBareEvidence: true }).counts.unitUnverified, out).toBe(1)
    }
    expect(trace('Revenue was 5,829 million.', 'Revenue was $5,829 million.', { allowBareOutput: true }).counts.unitUnverified).toBe(1)
    expect(trace('Churn was 12%.', 'Churn was 12%.', { preset: 'report' }).counts.unitUnverified).toBe(0)
  })
  it('false-pass:F09 a measured unit against a unit-less number is unknown (reason unit-unverified), whichever side has it', () => {
    for (const [out, ev] of [['We shipped 7 kg.', 'We shipped 7.'], ['We shipped 7.', 'We shipped 7 kg.'], ['Temp 30°C', 'Temp 30'], ['Open 5 days', 'Rating 5.0']] as const) {
      for (const opts of [undefined, { preset: 'report' as const }]) {
        const r = trace(out, ev, opts)
        expect(r.verdict, `${out} | ${ev}`).toBe('unknown')
        expect(r.numbers[0], `${out} | ${ev}`).toMatchObject({ status: 'unknown', reason: 'unit-unverified' })
        expect(r.counts.unitUnverified).toBe(0)
      }
    }
    // The same unit, or no unit on either side, is a plain match.
    expect(trace('We shipped 7 kg.', 'We shipped 7 kg.').verdict).toBe('clean')
    expect(trace('We shipped 7.', 'We shipped 7.').verdict).toBe('clean')
  })
  it('false-pass:F09 a rounded match with a unit on one side only is unknown too', () => {
    expect(trace('We shipped 7.3 kg.', 'We shipped 7.31.').numbers[0]).toMatchObject({ status: 'unknown', reason: 'unit-unverified' })
    expect(trace('We shipped 7.3.', 'We shipped 7.31 kg.').numbers[0]).toMatchObject({ status: 'unknown', reason: 'unit-unverified' })
    expect(trace('We shipped 7.3 kg.', 'We shipped 7.31 kg.').numbers[0]).toMatchObject({ status: 'rounded' })
  })
  it('false-pass:F09 a derived number with a unit on one side only stays marked and counted', () => {
    const r = trace('We shipped 7 kg.', 'We shipped 3 and 4.', { derivations: ['sum'] })
    expect(r.numbers[0]).toMatchObject({ status: 'derived', unitUnverified: true })
    expect(r.counts.unitUnverified).toBe(1)
  })
})

describe('M6 false-pass:F12: a dropped sign reaches the counts, and signMode strict makes it unknown', () => {
  const LOSS = 'Net loss for the year: ($5.2 million).'
  it('false-pass:F12 the default keeps a dropped sign as a marked pass and counts it', () => {
    const r = trace('Net income was $5.2 million.', LOSS)
    expect(r.verdict).toBe('clean')
    expect(r.numbers[0]).toMatchObject({ status: 'traced', signDiffers: true })
    expect(r.counts.signDiffers).toBe(1)
    expect(trace('Net loss was ($5.2 million).', LOSS).counts.signDiffers).toBe(0)
    expect(trace('Net income was $5.2 million.', LOSS, { signMode: 'explicit' }).verdict).toBe('clean')
  })
  it('false-pass:F12 signMode strict: a loss restated as income is unknown (sign-differs)', () => {
    const r = trace('Net income was $5.2 million.', LOSS, { signMode: 'strict' })
    expect(r.verdict).toBe('unknown')
    expect(r.numbers[0]).toMatchObject({ status: 'unknown', reason: 'sign-differs' })
    expect(r.counts.signDiffers).toBe(0)
    // Rounded and derived matches follow the same rule.
    expect(trace('Margin was 4.1%.', 'Margin was -4.13%.', { signMode: 'strict' }).numbers[0]).toMatchObject({ status: 'unknown', reason: 'sign-differs' })
    expect(trace('Average was 35%.', 'Q1 was -30% and Q2 was -40%.', { signMode: 'strict', derivations: ['average'] }).numbers[0]).toMatchObject({
      status: 'unknown', reason: 'sign-differs',
    })
    // The same sign, a sign the output writes itself, and evidence that has both signs are not affected.
    expect(trace('Net loss was ($5.2 million).', LOSS, { signMode: 'strict' }).verdict).toBe('clean')
    expect(trace('Change was -5%.', 'Change was 5%.', { signMode: 'strict' }).verdict).toBe('untraced')
    expect(trace('Change was 5%.', 'Q1 was -5% and Q2 was 5%.', { signMode: 'strict' }).verdict).toBe('clean')
    expect(trace('It was 5.', 'It was 5.', { signMode: 'strict' }).verdict).toBe('clean')
  })
  it('false-pass:F12 signMode strict travels with the report preset, and magnitude still ignores signs', () => {
    expect(trace('Net income was $5.2 million.', LOSS, { preset: 'report', signMode: 'strict' }).verdict).toBe('unknown')
    expect(trace('Net income was $5.2 million.', LOSS, { signMode: 'magnitude' }).verdict).toBe('clean')
    expect(() => trace('5', '5', { signMode: 'loose' as never })).toThrow(/signMode must be/)
  })
})

describe('M2 false-pass:F03: "X to Y" shares a modifier only where the words say so', () => {
  const read = (text: string): string[] => extractNumbers(text).map((t) => `${t.raw}=${t.value}${t.kind === 'percent' ? '%' : t.kind === 'currency' ? ` ${t.currency}` : ''}`)

  it('false-pass:F03 a percent that rises to an amount keeps its own value and the amount keeps its magnitude', () => {
    expect(read('Revenue increased 8% to $4.2 billion')).toEqual(['8%=8%', '$4.2 billion=4200000000 USD'])
    expect(read('Revenue fell 12% to $310 million')).toEqual(['12%=12%', '$310 million=310000000 USD'])
    expect(read('Net income rose 10.2% to $1.05 billion, or $3.40 per diluted share.')).toEqual([
      '10.2%=10.2%', '$1.05 billion=1050000000 USD', '$3.40=3.40 USD',
    ])
  })
  it('false-pass:F03 a percent that rises to a count or a level does not turn the count into a percent', () => {
    expect(extractNumbers('Subscribers rose 8% to 1,200.').map((t) => [t.raw, t.kind])).toEqual([['8%', 'percent'], ['1,200', 'count']])
    expect(extractNumbers('Index fell 1.2% to 5,230.5 points').map((t) => [t.raw, t.kind])).toEqual([['1.2%', 'percent'], ['5,230.5', 'decimal']])
    expect(extractNumbers('Orders rose 25% to 8,900 units.').map((t) => [t.raw, t.kind])).toEqual([['25%', 'percent'], ['8,900', 'count']])
  })
  it('false-pass:F03 the same holds for the other ways of joining two numbers', () => {
    for (const text of ['from 8% to $4.2 billion', '8% – $4.2 billion', '8%-$4.2 billion', 'between 8% and $4.2 billion', '8% to 4.2 million']) {
      const [a, b] = extractNumbers(text)
      expect(a?.kind, text).toBe('percent')
      expect(a?.value, text).toBe('8')
      expect(b?.kind, text).not.toBe('percent')
    }
    for (const text of ['8% to 1,200', '8% – 1,200', 'between 8% and 1,200']) {
      expect(extractNumbers(text).map((t) => t.kind), text).toEqual(['percent', 'count'])
    }
    // A currency and a percent, or a currency and a measured unit, are different quantities.
    expect(read('Prices rose from $5 to 8%')).toEqual(['$5=5 USD', '8%=8%'])
    expect(extractNumbers('from $5 to 8 kg').map((t) => [t.raw, t.kind, t.unit])).toEqual([['$5', 'currency', undefined], ['8 kg', 'count', 'kg']])
  })
  it('false-pass:F03 a bare number with a magnitude does not give it to a percent, and a percent does not take it', () => {
    expect(extractNumbers('from 5 million to 8%').map((t) => [t.raw, t.value, t.kind])).toEqual([['5 million', '5000000', 'count'], ['8%', '8', 'percent']])
  })
  it('false-pass:F03 verdicts: the earnings sentence is restated cleanly, and a percent is never read off a count', () => {
    expect(trace('Net sales grew 8%.', 'Net sales increased 8% to $4.2 billion.').verdict).toBe('clean')
    expect(trace('Net sales reached $4.2 billion.', 'Net sales increased 8% to $4.2 billion.').verdict).toBe('clean')
    expect(trace('Subscribers reached 1,200.', 'Subscribers rose 8% to 1,200.').verdict).toBe('clean')
    expect(trace('Sales grew 1,200%.', 'Sales rose 8% to 1,200.').verdict).toBe('untraced')
    // The report preset opts into bare evidence: the match stays visible as a unit that was never checked.
    expect(trace('Sales grew 1,200%.', 'Sales rose 8% to 1,200.', { preset: 'report' }).counts.unitUnverified).toBe(1)
    expect(trace('Sales grew 8 billion percent.', 'Sales rose 8% to $4.2 billion.').verdict).toBe('untraced')
    expect(trace('Sales rose 8,000,000,000%.', 'Sales rose 8% to $4.2 billion.').verdict).toBe('untraced')
  })
  it('false-pass:F03 controls: a range still shares what is written once', () => {
    expect(extractNumbers('5 to 8%').map((t) => [t.raw, t.kind, t.value])).toEqual([['5', 'percent', '5'], ['8%', 'percent', '8']])
    expect(read('$4 to 5 million')).toEqual(['$4=4000000 USD', '5 million=5000000 USD'])
    expect(read('$5 to 10')).toEqual(['$5=5 USD', '10=10 USD'])
    expect(read('$5 to $10 CAD')).toEqual(['$5=5 CAD', '$10 CAD=10 CAD'])
    expect(extractNumbers('2 to 3 kg').map((t) => t.unit)).toEqual(['kg', 'kg'])
    expect(extractNumbers('from 5 to 10 percent').map((t) => t.kind)).toEqual(['percent', 'percent'])
    expect(extractNumbers('from 5% to 10%').map((t) => t.kind)).toEqual(['percent', 'percent'])
    expect(extractNumbers('1.5 to 2.5 million').map((t) => t.value)).toEqual(['1500000', '2500000'])
    expect(extractNumbers('5 – 8%').map((t) => t.kind)).toEqual(['percent', 'percent'])
    expect(extractNumbers('between 5 and 8%').map((t) => t.kind)).toEqual(['percent', 'percent'])
    expect(trace('Growth of 5 to 8%.', 'Forecast: 5% and 8%.').verdict).toBe('clean')
    expect(trace('Growth of 5% to 8%.', 'Forecast: 5 to 8%.').verdict).toBe('clean')
  })

  // Thirty earnings-release sentences. Each traces to itself, and each figure restated alone traces to it.
  const CORPUS: [string, string[]][] = [
    ['Revenue increased 8% to $4.2 billion.', ['Revenue grew 8%.', 'Revenue was $4.2 billion.']],
    ['Net sales rose 8.5% to $12.4 billion.', ['Net sales grew 8.5%.', 'Net sales were $12.4 billion.']],
    ['Operating income fell 12% to $310 million.', ['Operating income fell 12%.', 'Operating income was $310 million.']],
    ['Gross margin expanded 120 basis points to 41.3%.', ['Gross margin was 41.3%.']],
    ['Subscribers rose 8% to 1,200.', ['Subscribers grew 8%.', 'Subscribers reached 1,200.']],
    ['The index fell 1.2% to 5,230.5 points.', ['The index fell 1.2%.', 'The index closed at 5,230.5 points.']],
    ['Diluted EPS increased 15% to $2.15 per share.', ['EPS grew 15%.', 'EPS was $2.15.']],
    ['Free cash flow rose 22% to $1.8 billion.', ['Free cash flow rose 22%.', 'Free cash flow was $1.8 billion.']],
    ['Headcount grew 5% to 14,300 employees.', ['Headcount grew 5%.', 'Headcount was 14,300.']],
    ['Deliveries climbed 11% to 412,000 vehicles.', ['Deliveries climbed 11%.', 'Deliveries were 412,000.']],
    ['Cloud revenue jumped 31% to $9.6 billion.', ['Cloud revenue jumped 31%.', 'Cloud revenue was $9.6 billion.']],
    ['Same-store sales declined 2.4% to $88.1 million.', ['Same-store sales declined 2.4%.', 'Same-store sales were $88.1 million.']],
    ['Net loss narrowed 40% to $52 million.', ['Net loss narrowed 40%.', 'Net loss was $52 million.']],
    ['Adjusted EBITDA increased 9% to $720 million.', ['Adjusted EBITDA grew 9%.', 'Adjusted EBITDA was $720 million.']],
    ['Gross profit rose 7.5% to $5.1 billion.', ['Gross profit rose 7.5%.', 'Gross profit was $5.1 billion.']],
    ['Monthly active users rose 6% to 312 million.', ['Users rose 6%.', 'Users reached 312 million.']],
    ['Operating margin improved 2.1 percentage points to 18.4%.', ['Operating margin was 18.4%.', 'Margin improved 2.1 percentage points.']],
    ['Backlog increased 14% to $27.3 billion.', ['Backlog grew 14%.', 'Backlog was $27.3 billion.']],
    ['Total revenue grew 3% to €1.45 billion.', ['Revenue grew 3%.', 'Revenue was €1.45 billion.']],
    ['Capital expenditures decreased 18% to $640 million.', ['Capex fell 18%.', 'Capex was $640 million.']],
    ['Net income rose 10.2% to $1.05 billion, or $3.40 per diluted share.', ['Net income rose 10.2%.', 'Net income was $1.05 billion.', 'Earnings were $3.40 per share.']],
    ['Orders increased 25% to 8,900 units.', ['Orders grew 25%.', 'Orders were 8,900.']],
    ['Revenue was $4.2 billion, up 8% from $3.9 billion.', ['Revenue grew 8%.', 'Revenue was $3.9 billion last year.']],
    ['Full-year guidance was raised 3% to $16.5 billion.', ['Guidance rose 3%.', 'Guidance is $16.5 billion.']],
    ['Recurring revenue rose 19% to $2.2 billion, representing 61% of total revenue.', ['Recurring revenue rose 19%.', 'Recurring revenue was $2.2 billion.', 'It was 61% of revenue.']],
    ['Customers grew 12% to 48,500.', ['Customers grew 12%.', 'Customers numbered 48,500.']],
    ['Interest expense fell 5% to $98 million.', ['Interest expense fell 5%.', 'Interest expense was $98 million.']],
    ['Stock-based compensation rose 16% to $430 million.', ['Stock-based compensation rose 16%.', 'It was $430 million.']],
    ['Revenue from Asia grew 28% to $3.3 billion, or 24% of sales.', ['Asia revenue grew 28%.', 'Asia revenue was $3.3 billion.', 'Asia was 24% of sales.']],
    ['Dividends per share increased 6% to $0.88.', ['Dividends grew 6%.', 'The dividend is $0.88 per share.']],
  ]
  it('false-pass:F03 corpus: thirty earnings-release sentences all self-trace clean, and every figure restated alone is clean', () => {
    expect(CORPUS.length).toBe(30)
    for (const [sentence, restatements] of CORPUS) {
      for (const opts of [undefined, { preset: 'report' as const }]) {
        expect(trace(sentence, sentence, opts).verdict, sentence).toBe('clean')
        for (const r of restatements) expect(trace(r, sentence, opts).verdict, `${r} | ${sentence}`).toBe('clean')
      }
    }
  })
  it('false-pass:F03 corpus: only a figure written with a percent sign or word is read as a percent', () => {
    for (const [sentence] of CORPUS) {
      for (const t of extractNumbers(sentence)) {
        const written = /%|percent/.test(t.raw) || /^\s*(?:percentage points|percent)/i.test(sentence.slice(t.end))
        expect(t.kind === 'percent', `${t.raw} in ${sentence}`).toBe(written)
      }
    }
  })
})

describe('M3 false-pass:F04: identical values never form a derivation pair', () => {
  const INVOICE = 'Invoice 17: total due $1,299.00. Payment received: $1,299.00. 12 line items.'
  const ALL = ['sum', 'difference', 'ratio', 'percent-change', 'percent-of', 'average', 'product'] as const
  const only = (r: TraceResult): NumberTrace => {
    expect(r.numbers.length).toBe(1)
    return r.numbers[0] as NumberTrace
  }

  it('false-pass:F04 a repeated total cannot make 0, 0%, 100% or $0 come back derived and clean', () => {
    for (const out of ['There were 0 items.', 'Growth was 0%.', 'Share of total was 100%.', 'The balance is $0.']) {
      const r = trace(out, INVOICE, { preset: 'report' })
      expect(r.verdict, out).toBe('unknown')
      expect(only(r), out).toMatchObject({ status: 'unknown', reason: 'twin-operands' })
    }
    // Without the report preset a bare 0 has no amount to be derived from; the rest are the same.
    for (const out of ['Growth was 0%.', 'Share of total was 100%.', 'The balance is $0.']) {
      expect(only(trace(out, INVOICE, { derivations: [...ALL] })), out).toMatchObject({ status: 'unknown', reason: 'twin-operands' })
    }
    expect(trace('There were 0 items.', INVOICE, { derivations: [...ALL] }).verdict).toBe('untraced')
  })
  it('false-pass:F04 double the repeated total is unknown, never derived', () => {
    for (const opts of [{ preset: 'report' as const }, { derivations: ['sum' as const] }]) {
      const r = trace('Total is $2,598.00.', INVOICE, opts)
      expect(r.verdict).toBe('unknown')
      expect(only(r)).toMatchObject({ status: 'unknown', reason: 'twin-operands' })
    }
  })
  it('false-pass:F04 two rows of the same value: their sum is unknown, a direct match and other derivations are not affected', () => {
    expect(only(trace('15%', 'a 7.5% b 7.5%', { derivations: ['sum'] }))).toMatchObject({ status: 'unknown', reason: 'twin-operands' })
    expect(trace('7.5%', 'a 7.5% b 7.5%', { derivations: [...ALL] }).verdict).toBe('clean')
    // A value that no twin pair makes is still untraced.
    expect(only(trace('There were 7 items.', INVOICE, { preset: 'report' })).status).toBe('untraced')
    // A third number still combines with either copy of a twin (two ways to build it, under the cap of three).
    const r = trace('Net was $150.', 'Rows: $100, $100 and $50.', { derivations: ['sum'] })
    expect(only(r)).toMatchObject({ status: 'derived', derivation: { kind: 'sum', matches: 2 } })
  })
  it('false-pass:F04 distinct values still derive: the balance of a part payment is clean', () => {
    const r = trace('The balance is $299.00.', 'Invoice 17: total due $1,299.00. Payment received: $1,000.00. 12 line items.', { derivations: ['difference', 'percent-of'] })
    expect(r.verdict).toBe('clean')
    expect(r.numbers.map((n) => n.status)).toEqual(['derived'])
  })
  it('false-pass:F04 a twin inside a three-number derivation is unknown too', () => {
    const ev = 'Rows: $100, $100 and $50.'
    for (const out of ['Total is $250.', 'Average is $83.33.', 'Left is $0.', 'Left is -$150.']) {
      const r = trace(out, ev, { derivations: ['sum', 'average', 'difference'], maxOperands: 3, maxCandidates: 100_000 })
      expect(r.verdict, out).not.toBe('clean')
      expect(only(r).status, out).toBe('unknown')
    }
  })
  it('false-pass:F04 negative and signed twins are the same twin; zero is zero either way', () => {
    expect(only(trace('There were 0 items.', 'Change -5 and change -5.', { derivations: [...ALL] }))).toMatchObject({ status: 'unknown', reason: 'twin-operands' })
    expect(only(trace('Net was 0.', 'Gain 5 and loss -5.', { derivations: ['sum'] })).status).toBe('derived')
    expect(only(trace('There were 0 items.', 'Rows 0 and -0.', { derivations: ['sum'] }))).toMatchObject({ status: 'traced' })
  })
  it('false-pass:F04 twin candidates do not add to the guard counts or to the search size', () => {
    const base = trace('Net was $150.', 'Rows: $100 and $50.', { derivations: ['sum'], maxCandidates: 1 })
    expect(only(base)).toMatchObject({ status: 'derived' })
    // The same cap with a twin present: the candidate count is the same as before, so the cap result is too.
    expect(trace('Net was $150.', 'Rows: $100, $100 and $50.', { derivations: ['sum'], maxCandidates: 2 }).candidateCapHit).toBe(true)
  })
})

describe('M3 audit: derivation paths that pass a number the evidence says nothing about', () => {
  const only = (r: TraceResult): NumberTrace => {
    expect(r.numbers.length).toBe(1)
    return r.numbers[0] as NumberTrace
  }
  const ALL = ['sum', 'difference', 'ratio', 'percent-change', 'percent-of', 'average', 'product'] as const

  it('audit:D1 a year or an ordinal in the output is a label: a derivation never passes it', () => {
    for (const opts of [{ derivations: ['sum' as const] }, { preset: 'report' as const }]) {
      for (const [out, ev] of [
        ['The program started in 2025.', 'Costs were 1,000 and 1,025.'],
        ['In 2031 sales fell.', 'Units 2,000 and 31 shipped.'],
        ['He finished 3rd.', 'Scores were 1 and 2.'],
        ['On the 7th.', 'We had 3 and 4.'],
      ] as const) {
        const r = trace(out, ev, opts)
        expect(r.verdict, out).toBe('unknown')
        expect(only(r), out).toMatchObject({ status: 'unknown', reason: 'label-derivation' })
      }
    }
    // A year or an ordinal that is in the evidence still traces, and an ordinary count is still derived.
    expect(trace('It started in 2025.', 'Started 2025. Costs 1,000 and 1,025.', { derivations: ['sum'] }).verdict).toBe('clean')
    expect(trace('That is 2,025 in all.', 'Costs were 1,000 and 1,025.', { derivations: ['sum'] }).numbers[0]?.status).toBe('derived')
    // A year nothing builds is still untraced.
    expect(trace('It started in 2031.', 'Costs were 1,000 and 1,025.', { derivations: ['sum'] }).verdict).toBe('untraced')
  })
  it('audit:D2 a zero that only a zero operand builds is unknown, never derived', () => {
    const EV = '0 outages this quarter. Revenue was $5,000.'
    const r = trace('Profit was $0.', EV, { derivations: ['product'] })
    expect(only(r)).toMatchObject({ status: 'unknown', reason: 'zero-operand' })
    expect(only(trace('Profit was $0.', 'Churn was 0%. Revenue was $5,000.', { derivations: ['percent-of'] }))).toMatchObject({ status: 'unknown', reason: 'zero-operand' })
    expect(only(trace('Growth was 0%.', '0 outages. 5 sites.', { derivations: ['percent-of'] }))).toMatchObject({ status: 'unknown', reason: 'zero-operand' })
    expect(only(trace('Ratio was 0.', 'Churn 0%, growth 5%.', { derivations: ['ratio'] }))).toMatchObject({ status: 'unknown', reason: 'zero-operand' })
    // A zero that two different values build, a drop to zero, and a zero in the evidence are not affected.
    expect(only(trace('Net was 0.', 'Gain 5 and loss -5.', { derivations: ['sum'] })).status).toBe('derived')
    expect(only(trace('Revenue fell 100%.', 'Revenue was $5,000, then $0.', { derivations: ['percent-change'] })).status).toBe('derived')
    expect(only(trace('There were 0 outages.', EV, { derivations: [...ALL] })).status).toBe('traced')
    // A number nothing builds is still untraced.
    expect(only(trace('Profit was $7.', EV, { derivations: [...ALL] })).status).toBe('untraced')
  })
  it('audit:D3 an inexact ratio shown with one significant digit is unknown: a small integer lands on a ratio by chance', () => {
    const EV = 'Row A is 123. Row B is 25.'
    for (const opts of [{ derivations: ['ratio' as const] }, { preset: 'report' as const }, { derivations: [...ALL] }]) {
      expect(only(trace('We saw 5 issues.', EV, opts)), JSON.stringify(opts)).toMatchObject({ status: 'unknown', reason: 'coarse-derivation' })
    }
    expect(only(trace('That is 0.5 of it.', 'Row A is 21. Row B is 40.', { derivations: ['ratio'] }))).toMatchObject({ status: 'unknown', reason: 'coarse-derivation' })
    // Two significant digits, an exact result, and the other derivations are unchanged.
    expect(only(trace('The mean was 5.', 'Row A is 3. Row B is 6.', { derivations: ['average'] })).status).toBe('derived')
    expect(only(trace('The ratio was 4.9x.', EV, { derivations: ['ratio'] })).status).toBe('derived')
    expect(only(trace('The ratio was 3x.', 'Row A is 12. Row B is 4.', { derivations: ['ratio'] })).status).toBe('derived')
    expect(only(trace('Total was 5.', 'Row A is 2. Row B is 3.', { derivations: ['sum'] })).status).toBe('derived')
    expect(only(trace('That is 35% of it.', 'Row A is 35. Row B is 100.', { derivations: ['percent-of'] })).status).toBe('derived')
  })
})
