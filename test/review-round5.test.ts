import { describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'
import type { TraceOptions, TraceResult } from '../src/index.js'

// Regression rows from the fifth independent review (34140c5).

function t(output: string, evidence: Parameters<typeof traceNumbers>[1], options?: TraceOptions): TraceResult {
  return traceNumbers(output, evidence, options)
}

describe('leading decimals', () => {
  it('a decimal mark with no digit before it still marks a decimal', () => {
    expect(extractNumbers('.5%')[0]).toMatchObject({ value: '0.5', scale: 1, kind: 'percent', raw: '.5%', start: 0 })
    expect(extractNumbers('$.99')[0]).toMatchObject({ value: '0.99', currency: 'USD', raw: '$.99' })
    expect(extractNumbers('-.25')[0]).toMatchObject({ value: '-0.25', signStyle: 'minus', raw: '-.25' })
    expect(extractNumbers('+.5')[0]).toMatchObject({ value: '0.5', signStyle: 'plus' })
    expect(extractNumbers('(.5%)')[0]).toMatchObject({ value: '-0.5', signStyle: 'parentheses' })
    expect(extractNumbers('about .75 of it')[0]).toMatchObject({ value: '0.75', raw: '.75' })
    expect(extractNumbers('1.5 and .5').map((x) => x.value)).toEqual(['1.5', '0.5'])
    expect(extractNumbers('Price: $.99.')[0]).toMatchObject({ raw: '$.99' })
    expect(extractNumbers('.5 million')[0]).toMatchObject({ value: '500000', scale: -5 })
    expect(extractNumbers('.5 kg')[0]).toMatchObject({ value: '0.5', unit: 'kg' })
  })

  it('traces as the decimal it is, never as the integer', () => {
    expect(t('.5%', '5%').verdict).toBe('untraced')
    expect(t('0.5%', '.5%').verdict).toBe('clean')
    expect(t('.5%', '0.5%').verdict).toBe('clean')
    expect(t('$.99', '$0.99').verdict).toBe('clean')
    expect(t('-.25', '-0.25').verdict).toBe('clean')
    expect(t('.5', '5').verdict).toBe('untraced')
    expect(t('.55', '0.5').verdict).toBe('untraced')
    expect(t('.5', '0.54').numbers[0]?.status).toBe('rounded')
  })

  it('a dot that is not a leading decimal stays out of the number', () => {
    expect(extractNumbers('wait...5 more').map((x) => x.raw)).toEqual(['5'])
    expect(extractNumbers('the end.5 apples')[0]?.raw).toBe('5')
    expect(extractNumbers('v1.2 and 5.')[0]).toMatchObject({ raw: '5' })
    expect(extractNumbers('10.5.3')).toEqual([])
  })

  it('under the other locale convention the mark is a guess, never dropped', () => {
    const de = extractNumbers('.5', { locale: 'de-DE' })[0]
    expect(de).toMatchObject({ value: '0.5', ambiguous: true, localeGuess: true })
    expect(t('.5', '0.5', { locale: 'de-DE', evidenceLocale: 'en-US' }).numbers[0]?.status).toBe('unknown')
    expect(extractNumbers('a ,5', { locale: 'de-DE' })[0]).toMatchObject({ value: '0.5', ambiguous: false })
    expect(extractNumbers('a ,5')[0]).toMatchObject({ value: '0.5', localeGuess: true })
    expect(extractNumbers('1,5 and a,5').map((x) => x.value)).toEqual(['1.5', '5'])
  })
})

describe('a unit or magnitude makes a year-shaped number not a year', () => {
  it('after inheriting from a range or a dimension', () => {
    expect(extractNumbers('1950-2200 kg').map((x) => [x.kind, x.unit])).toEqual([['count', 'kg'], ['count', 'kg']])
    expect(extractNumbers('1950-2000 million').map((x) => x.kind)).toEqual(['count', 'count'])
    expect(extractNumbers('1950-2000%').map((x) => x.kind)).toEqual(['percent', 'percent'])
    expect(extractNumbers('2000 x 3000 cm').map((x) => x.kind)).toEqual(['count', 'count'])
    expect(extractNumbers('1950-2000').map((x) => x.kind)).toEqual(['year', 'year'])
    expect(t('1950-2200 kg', '2200 kg', { ignoreYears: true }).verdict).toBe('untraced')
    expect(t('2000 x 3000 cm', '3000 cm', { ignoreYears: true }).verdict).toBe('untraced')
    expect(t('1950-2000', 'x', { ignoreYears: true }).verdict).toBe('clean')
  })
})

describe('derived results report a dropped sign', () => {
  it('signDiffers on every derivation kind', () => {
    const avg = t('35%', '-30%; -40%', { derivations: ['average'] })
    expect(avg.numbers[0]).toMatchObject({ status: 'derived', signDiffers: true, derivation: { kind: 'average', exact: true } })
    expect(t('-35%', '-30%; -40%', { derivations: ['average'] }).numbers[0]?.signDiffers).toBeUndefined()
    expect(t('70%', '-30%; -40%', { derivations: ['sum'] }).numbers[0]).toMatchObject({ status: 'derived', signDiffers: true })
    // Only a negative value gives 65: 5 - 40 - 30.
    expect(t('65', 'a 5 b 40 c 30', { derivations: ['difference'], maxOperands: 3 }).numbers[0]).toMatchObject({ status: 'derived', signDiffers: true })
    expect(t('-65', 'a 5 b 40 c 30', { derivations: ['difference'], maxOperands: 3 }).numbers[0]?.signDiffers).toBeUndefined()
    // A pair difference is a magnitude: the other order gives the positive value, so nothing is dropped.
    expect(t('35', 'a 5 b 40', { derivations: ['difference'] }).numbers[0]?.signDiffers).toBeUndefined()
    expect(t('35', 'a 40 b 5', { derivations: ['difference'] }).numbers[0]?.signDiffers).toBeUndefined()
    // Percent change of a fall, shown without its minus.
    expect(t('20%', 'from 100 to 80', { derivations: ['percent-change'] }).numbers[0]).toMatchObject({ status: 'derived', signDiffers: true })
    expect(t('-20%', 'from 100 to 80', { derivations: ['percent-change'] }).numbers[0]?.signDiffers).toBeUndefined()
  })
})

describe('zero keeps the sign it was written with', () => {
  it('-0.00% rounds from a negative evidence value, not a positive one', () => {
    expect(extractNumbers('-0.00%')[0]).toMatchObject({ value: '0.00', signStyle: 'minus', kind: 'percent' })
    expect(t('-0.00%', '-0.004%').numbers[0]).toMatchObject({ status: 'rounded' })
    expect(t('-0.00%', '0.004%').numbers[0]?.status).toBe('untraced')
    expect(t('0.00%', '-0.004%').numbers[0]).toMatchObject({ status: 'rounded', signDiffers: true })
    expect(t('(0.00%)', '-0.004%').numbers[0]?.status).toBe('rounded')
    // An exact zero has no sign to disagree about.
    expect(t('-0%', '0%').numbers[0]?.status).toBe('traced')
    expect(t('0%', '-0%').numbers[0]?.status).toBe('traced')
    expect(t('-0.0', '-0.00').numbers[0]?.status).toBe('traced')
  })
})
