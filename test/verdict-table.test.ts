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
    expect(extractNumbers('foo_12 and 12_000 and x_1').map((t) => t.raw)).toEqual([])
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
