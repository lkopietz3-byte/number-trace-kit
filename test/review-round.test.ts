import { describe, expect, it } from 'vitest'
import { extractNumbers, reconcile, traceNumbers } from '../src/index.js'
import type { NumberToken, TraceOptions, TraceResult } from '../src/index.js'

// Regression rows from the independent review of aa77074. Each one was
// reproduced against that commit before the fix.

function t(output: string, evidence: Parameters<typeof traceNumbers>[1], options?: TraceOptions): TraceResult {
  return traceNumbers(output, evidence, options)
}

function cpuMs(fn: () => void): number {
  const before = process.cpuUsage()
  fn()
  const used = process.cpuUsage(before)
  return (used.user + used.system) / 1e3
}

describe('units survive every numeric form', { timeout: 60_000 }, () => {
  it('scientific notation keeps its percent sign, currency and unit', () => {
    expect(t('1e2%', '100').verdict).toBe('untraced')
    expect(t('1.2e3 kg', '1200 days').verdict).toBe('untraced')
    expect(t('1.2e3 kg', '1200 kg').verdict).toBe('clean')
    expect(t('1e2%', '100%').verdict).toBe('clean')
    expect(extractNumbers('1e2%')[0]).toMatchObject({ kind: 'percent', value: '100' })
    expect(extractNumbers('1.2e3 kg')[0]).toMatchObject({ unit: 'kg', value: '1200' })
    expect(extractNumbers('$1e3')[0]).toMatchObject({ kind: 'currency', value: '1000' })
    expect(extractNumbers('1e3 USD')[0]).toMatchObject({ currency: 'USD' })
    expect(extractNumbers('1e2 percent')[0]).toMatchObject({ kind: 'percent' })
    expect(extractNumbers('1e3x')[0]).toMatchObject({ unit: 'x', value: '1000' })
  })

  it('a magnitude letter after an exponent is not read as a magnitude', () => {
    expect(extractNumbers('1e2K')).toEqual([])
  })

  it('spaced unit abbreviations keep the unit like glued ones do', () => {
    expect(t('10 x', '10 days').verdict).toBe('untraced')
    expect(t('5 g', '5 kg').verdict).toBe('untraced')
    expect(t('5 g', '5g').verdict).toBe('clean')
    expect(extractNumbers('5 g, 20 mL, 3 pm')).toMatchObject([{ unit: 'g' }, { unit: 'ml' }, { unit: 'pm' }])
  })

  it('full-width letters and symbols are folded for every lookup', () => {
    expect(t('ＣＡ＄５', 'US$5').verdict).toBe('untraced')
    expect(extractNumbers('ＣＡ＄５')[0]).toMatchObject({ currency: 'CAD', value: '5' })
    expect(extractNumbers('５ｋｇ')[0]).toMatchObject({ unit: 'kg', value: '5' })
    expect(t('５ｋｇ', '5 kg').verdict).toBe('clean')
    expect(extractNumbers('ＵＳＤ ５')[0]).toMatchObject({ currency: 'USD' })
    expect(extractNumbers('Ｏｃｔ ５')[0]).toMatchObject({ kind: 'date-part' })
    expect(t('10/12/２０２６', 'due 10/12/2026').verdict).toBe('clean')
  })
})

describe('exponents are consumed whole', { timeout: 60_000 }, () => {
  it('a very long exponent is too-long, not an invisible number', () => {
    const r = t('1e1000000', '')
    expect(r.numbers).toHaveLength(1)
    expect(r.numbers[0]).toMatchObject({ status: 'unknown', reason: 'too-long' })
    expect(r.verdict).toBe('unknown')
    expect(extractNumbers('1e0000030')[0]).toMatchObject({ value: '1000000000000000000000000000000', ambiguous: false })
    expect(extractNumbers('1e0000031')[0]).toMatchObject({ ambiguity: 'too-long' })
    expect(extractNumbers(`1e${'0'.repeat(300_000)}5`)[0]).toMatchObject({ value: '100000', ambiguous: false })
  })
})

describe('accounting parentheses', { timeout: 60_000 }, () => {
  it('amounts and grouped numbers between 1900 and 2100 stay negative', () => {
    expect(extractNumbers('($2024)')[0]).toMatchObject({ value: '-2024', signStyle: 'parentheses' })
    expect(extractNumbers('(2,024)')[0]).toMatchObject({ value: '-2024' })
    expect(extractNumbers('(2024%)')[0]).toMatchObject({ value: '-2024' })
    expect(t('-$2024', '($2024)').verdict).toBe('clean')
    // A bare parenthesized year is still a citation.
    expect(extractNumbers('(2024)')[0]).toMatchObject({ value: '2024', kind: 'year' })
  })
})

describe('derivation lookups', { timeout: 60_000 }, () => {
  it('collisions do not rescan every candidate', () => {
    const evidence = Array.from({ length: 60 }, (_, i) => String(10000 + i)).join('; ')
    const output = '1.0x '.repeat(1200)
    let result: TraceResult | undefined
    const ms = cpuMs(() => {
      result = t(output, evidence, { derivations: ['ratio'], maxDerivationMatches: 1_000_000, maxDerivationDensity: 1_000_000 })
    })
    expect(result?.numbers).toHaveLength(1200)
    expect(result?.numbers[0]?.derivation?.matches).toBeGreaterThan(100)
    expect(ms).toBeLessThan(300)
  })

  it('exact derivations work with rounding turned off', () => {
    const r = t('7', '3 and 4', { derivations: ['sum'], rounding: [] })
    expect(r.numbers[0]).toMatchObject({ status: 'derived', derivation: { kind: 'sum', exact: true } })
    expect(t('0.8', 'a 80 b 100', { derivations: ['ratio'], rounding: [] }).numbers[0]?.status).toBe('derived')
    // An inexact value does not match when rounding is off.
    expect(t('0.33', 'a 1 b 3', { derivations: ['ratio'], rounding: [] }).numbers[0]?.status).toBe('untraced')
  })

  it('percent-of accepts two percents of the same class', () => {
    const r = t('50%', '10% and 20%', { derivations: ['percent-of'] })
    expect(r.numbers[0]).toMatchObject({ status: 'derived', derivation: { kind: 'percent-of' } })
    expect(t('50 pp', '10 pp and 20 pp', { derivations: ['percent-of'] }).numbers[0]?.status).toBe('untraced') // result is a percent, not pp
  })
})

describe('weak links check rounding and the cap', { timeout: 60_000 }, () => {
  it('an alternate reading that rounds to the output is unknown', () => {
    const r = t('$1.2K', '$1.234')
    expect(r.numbers[0]).toMatchObject({ status: 'unknown', reason: 'ambiguous-reading' })
    expect(t('$1.3K', '$1.234').numbers[0]?.status).toBe('untraced')
    // The output's own alternate reading, rounded against strong evidence.
    expect(t('4K', 'about 4.04').numbers[0]?.status).toBe('unknown')
    // A locale guess on the output side rounds the same way.
    expect(t('12,5', 'x 12.54').numbers[0]?.status).toBe('unknown')
  })

  it('a locale guess honors an incomplete derivation search', () => {
    const r = t('12,5', '3 and 4 and 5', { derivations: ['sum'], maxCandidates: 1 })
    expect(r.candidateCapHit).toBe(true)
    expect(r.numbers[0]).toMatchObject({ status: 'unknown', reason: 'candidate-cap' })
    // Without derivations it is a plain untraced.
    expect(t('12,5', '3 and 4 and 5').numbers[0]?.status).toBe('untraced')
  })
})

describe('French grouping with an ordinary space', { timeout: 60_000 }, () => {
  it('reads 1 234,50 as one number under a comma-decimal locale', () => {
    const tokens = extractNumbers('1 234,50', { locale: 'fr-FR' })
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({ value: '1234.50', ambiguous: false })
    expect(t('1 234,50', '1234,50', { locale: 'fr-FR' }).verdict).toBe('clean')
    expect(extractNumbers('12 345 678', { locale: 'fr-FR' })[0]).toMatchObject({ value: '12345678' })
  })

  it('does not glue unrelated numbers', () => {
    expect(extractNumbers('5 12 and 3 4567', { locale: 'fr-FR' }).map((x) => x.value)).toEqual(['5', '12', '3', '4567'])
    expect(extractNumbers('1 234', { locale: 'en-US' }).map((x) => x.value)).toEqual(['1', '234'])
    expect(extractNumbers('2024 123', { locale: 'fr-FR' }).map((x) => x.value)).toEqual(['2024', '123'])
  })
})

describe('inputs', { timeout: 60_000 }, () => {
  it('a sparse array does not read inherited items', () => {
    const evidence = new Array<unknown>(1)
    Object.setPrototypeOf(evidence, { 0: { id: 'fake', text: '5' } })
    expect(() => t('5', evidence as never)).toThrow(TypeError)
    const rows = new Array<unknown>(1)
    Object.setPrototypeOf(rows, { 0: { label: 'a', amount: '1' } })
    expect(() => reconcile({ rows: rows as never, total: '1' })).toThrow(TypeError)
  })

  it('supplied tokens obey the 60-digit policy whatever their flags say', () => {
    const v = '9'.repeat(61)
    const tok: NumberToken = { raw: v, start: 0, end: 61, value: v, scale: 0, kind: 'count', ambiguous: false }
    const r = traceNumbers([tok], [tok])
    expect(r.numbers[0]).toMatchObject({ status: 'unknown', reason: 'too-long' })
    expect(r.verdict).toBe('unknown')
    const ok = traceNumbers([{ ...tok, value: '9'.repeat(60), raw: '9'.repeat(60), end: 60 }], [{ ...tok, value: '9'.repeat(60), raw: '9'.repeat(60), end: 60 }])
    expect(ok.verdict).toBe('clean')
    const frac: NumberToken = { ...tok, value: `0.${'9'.repeat(61)}`, scale: 61 }
    expect(traceNumbers([frac], [frac]).numbers[0]?.reason).toBe('too-long')
  })
})

describe('NFC and NFD agree', { timeout: 60_000 }, () => {
  it('identifiers keep their boundary under combining marks', () => {
    const nfc = 'café' + '3'
    const nfd = 'café' + '3'
    expect(t(nfc, '').verdict).toBe('clean')
    expect(t(nfd, '').verdict).toBe('clean')
    for (const text of ['café 5 é 7%', 'X3 éé3', '5é', '5é', 'naïve9 and v2']) {
      const a = extractNumbers(text.normalize('NFC')).map((x) => [x.value, x.kind])
      const b = extractNumbers(text.normalize('NFD')).map((x) => [x.value, x.kind])
      expect(b, text).toEqual(a)
    }
  })

  it('a combining mark after a digit does not hide the number', () => {
    expect(extractNumbers('5́')[0]).toMatchObject({ value: '5' })
    expect(t('Total 5́', 'x').verdict).toBe('untraced')
  })
})

describe('compound fractions', { timeout: 60_000 }, () => {
  it('the whole slash chain is the group, so fragments cannot vouch for it', () => {
    const r = t('1/2/3', '1/2 and 2/3')
    expect(r.verdict).toBe('unknown')
    expect(t('1/2/3', 'ratio 1/2/3').verdict).toBe('clean')
    expect(extractNumbers('1/2/3').map((x) => x.groupRaw)).toEqual(['1/2/3', '1/2/3', '1/2/3'])
  })
})

describe('the self-hunt pass on the same classes', () => {
  it('units follow every numeric form', () => {
    expect(extractNumbers('1e3-day')[0]).toMatchObject({ unit: 'day' })
    expect(extractNumbers('1.5e3 USD')[0]).toMatchObject({ currency: 'USD', value: '1500' })
    expect(extractNumbers('1e3 per cent')[0]).toMatchObject({ kind: 'percent' })
    expect(extractNumbers('2E-3 hours')[0]).toMatchObject({ unit: 'hour', value: '0.002' })
    expect(extractNumbers('5-10 g')).toMatchObject([{ unit: 'g' }, { unit: 'g' }])
    expect(extractNumbers('1,234.5 kg')[0]).toMatchObject({ unit: 'kg' })
    expect(extractNumbers('１ｅ２ ％')[0]).toMatchObject({ kind: 'percent', value: '100' })
    expect(t('2 hours', '2 days').verdict).toBe('untraced')
  })

  it('folded forms feed every lookup', () => {
    expect(extractNumbers('５ ｐｅｒ ｃｅｎｔ')[0]).toMatchObject({ kind: 'percent' })
    expect(extractNumbers('５ ｍｉｌｌｉｏｎ')[0]).toMatchObject({ value: '5000000' })
    expect(extractNumbers('１０ Ｓｅｐ ５')).toHaveLength(3)
  })

  it('an alternate reading that is a derivation is unknown, and a locale guess too', () => {
    // 4K could be 4: and 4 = 1 + 3.
    expect(t('4K', 'a 1 b 3', { derivations: ['sum'] }).numbers[0]).toMatchObject({ status: 'unknown', reason: 'ambiguous-reading' })
    expect(t('12,5', 'a 5 b 7.5', { derivations: ['sum'] }).numbers[0]).toMatchObject({ status: 'unknown', reason: 'ambiguous-reading' })
    // With the cap hit, the incomplete search wins.
    expect(t('4K', 'a 1 b 3 c 9', { derivations: ['sum', 'difference'], maxCandidates: 2 }).numbers[0]?.reason).toBe('candidate-cap')
  })

  it('a combining mark between a letter and a unit keeps one boundary', () => {
    expect(extractNumbers('5kg'.normalize('NFD'))[0]).toMatchObject({ unit: 'kg' })
    expect(extractNumbers('5ékg')).toEqual([])
  })
})
