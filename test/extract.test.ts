import { describe, expect, it } from 'vitest'
import { extractNumbers } from '../src/index.js'
import type { ExtractOptions, NumberToken } from '../src/index.js'

function one(text: string, options?: ExtractOptions): NumberToken {
  const tokens = extractNumbers(text, options)
  expect(tokens.length, JSON.stringify(tokens.map((t) => t.raw))).toBe(1)
  const [t] = tokens
  if (t === undefined) throw new Error('unreachable')
  return t
}

function fields(text: string, options?: ExtractOptions): Array<[string, string, string]> {
  return extractNumbers(text, options).map((t) => [t.raw, t.value, t.kind])
}

describe('plain numbers and separators', () => {
  it.each([
    ['1234', '1234', 0, 'count'],
    ['1,234', '1234', 0, 'count'],
    ['1,234,567', '1234567', 0, 'count'],
    ['1,234,567.89', '1234567.89', 2, 'decimal'],
    ['12.50', '12.50', 2, 'decimal'],
    ['0.5', '0.5', 1, 'decimal'],
    ['007', '7', 0, 'count'],
    ['3.14159', '3.14159', 5, 'decimal'],
  ])('en-US %s', (text, value, scale, kind) => {
    const t = one(text)
    expect([t.value, t.scale, t.kind, t.ambiguous]).toEqual([value, scale, kind, false])
  })

  it('reads German and French style under a comma-decimal locale', () => {
    expect(one('1.234,50', { locale: 'de-DE' })).toMatchObject({ value: '1234.50', scale: 2, ambiguous: false })
    expect(one('1.234.567', { locale: 'de-DE' })).toMatchObject({ value: '1234567', ambiguous: false })
    expect(one('3,14', { locale: 'de-DE' })).toMatchObject({ value: '3.14', ambiguous: false })
    expect(one('1 234,5', { locale: 'fr-FR' })).toMatchObject({ value: '1234.5', ambiguous: false })
    expect(one('1 234 567', { locale: 'fr-FR' })).toMatchObject({ value: '1234567' })
  })

  it('treats a single separator followed by three digits as ambiguous when it is the decimal mark', () => {
    const us = one('1.234')
    expect(us).toMatchObject({ value: '1.234', scale: 3, ambiguous: true, ambiguity: 'separator' })
    expect(us.alternates).toEqual([{ value: '1234', scale: 0 }])
    const de = one('1,234', { locale: 'de-DE' })
    expect(de).toMatchObject({ value: '1.234', ambiguous: true })
    expect(de.alternates).toEqual([{ value: '1234', scale: 0 }])
    // The group mark of the locale is not ambiguous.
    expect(one('1,234')).toMatchObject({ value: '1234', ambiguous: false })
    expect(one('1.234', { locale: 'de-DE' })).toMatchObject({ value: '1234', ambiguous: false })
  })

  it('does not call a leading-zero or long-prefix number ambiguous', () => {
    expect(one('0.123')).toMatchObject({ value: '0.123', ambiguous: false })
    expect(one('1234.567')).toMatchObject({ value: '1234.567', ambiguous: false })
  })

  it('flags a separator that does not fit the locale, with one reading', () => {
    const t = one('12,5')
    expect(t).toMatchObject({ value: '12.5', ambiguous: true, ambiguity: 'separator' })
    expect(t.alternates).toBeUndefined()
    expect(one('3.14', { locale: 'de-DE' })).toMatchObject({ ambiguous: true })
  })

  it('structure decides when both marks appear, whatever the locale', () => {
    expect(one('1.234,56')).toMatchObject({ value: '1234.56', ambiguous: false })
    expect(one('1,234.56', { locale: 'de-DE' })).toMatchObject({ value: '1234.56', ambiguous: false })
  })

  it('does not treat a version or address as a number', () => {
    expect(extractNumbers('1.2.3 and 192.168.1.1 and 10.0.0.1')).toEqual([])
    // A grouped integer is still a number.
    expect(one('1.234.567', { locale: 'de-DE' }).value).toBe('1234567')
  })

  it('splits an unseparated list instead of inventing a number', () => {
    expect(fields('7,8')).toEqual([['7,8', '7.8', 'decimal']])
    expect(extractNumbers('1,2,3').map((t) => t.raw)).toEqual(['1,2', '3'])
  })

  it('keeps trailing sentence punctuation out of the number', () => {
    expect(fields('It cost 5. Then 6, and 7.')).toEqual([['5', '5', 'count'], ['6', '6', 'count'], ['7', '7', 'count']])
  })
})

describe('signs and parentheses', () => {
  it('reads minus, plus and the Unicode minus', () => {
    expect(one('-5')).toMatchObject({ value: '-5', signStyle: 'minus' })
    expect(one('+5')).toMatchObject({ value: '5', signStyle: 'plus' })
    expect(one('−5')).toMatchObject({ value: '-5', signStyle: 'minus' })
    expect(one('x = -0.5')).toMatchObject({ value: '-0.5' })
    expect(one('-0')).toMatchObject({ value: '0' })
  })

  it('does not treat a hyphen between two numbers or after a word as a sign', () => {
    expect(extractNumbers('10-12').map((t) => t.value)).toEqual(['10', '12'])
    expect(one('pre-2020').value).toBe('2020')
    expect(extractNumbers('3 - 2').map((t) => t.value)).toEqual(['3', '2'])
  })

  it('reads accounting parentheses as negatives only for numbers that look like amounts', () => {
    expect(one('(1,234)')).toMatchObject({ value: '-1234', signStyle: 'parentheses', raw: '(1,234)' })
    expect(one('($5)')).toMatchObject({ value: '-5', currency: 'USD' })
    expect(one('(12.5%)')).toMatchObject({ value: '-12.5', kind: 'percent' })
    // Bare small numbers and years in parentheses are notes and citations.
    expect(one('(2)').value).toBe('2')
    expect(one('(500)').value).toBe('500')
    expect(one('(2024)')).toMatchObject({ value: '2024', kind: 'year' })
    expect(one('(1,234)', { parenthesesAreNegative: false }).value).toBe('1234')
  })

  it('treats an unclosed parenthesis as plain text', () => {
    expect(one('(1,234 widgets')).toMatchObject({ value: '1234', raw: '1,234' })
  })
})

describe('percent, currency, magnitude, units', () => {
  it.each([
    ['45%', '45', 'percent', '%'],
    ['45 %', '45', 'percent', '%'],
    ['45 percent', '45', 'percent', '%'],
    ['45 per cent', '45', 'percent', '%'],
    ['45pct', '45', 'percent', '%'],
    ['0.5 pp', '0.5', 'percent', 'pp'],
    ['0.5 percentage points', '0.5', 'percent', 'pp'],
    ['2 percentage point', '2', 'percent', 'pp'],
  ])('%s', (text, value, kind, unit) => {
    expect(one(text)).toMatchObject({ value, kind, unit, raw: text })
  })

  it.each([
    ['$1,234.50', '1234.50', 'USD'],
    ['USD 1,234.50', '1234.50', 'USD'],
    ['1,234.50 USD', '1234.50', 'USD'],
    ['US$5', '5', 'USD'],
    ['CA$5', '5', 'CAD'],
    ['A$5', '5', 'AUD'],
    ['€5', '5', 'EUR'],
    ['5 €', '5', 'EUR'],
    ['5 euros', '5', 'EUR'],
    ['5 dollars', '5', 'USD'],
    ['£5', '5', 'GBP'],
    ['＄500', '500', 'USD'],
  ])('currency %s', (text, value, currency) => {
    expect(one(text)).toMatchObject({ value, currency, kind: 'currency', ambiguous: false })
  })

  it('keeps an adjacent number from stealing a currency symbol', () => {
    expect(fields('5 $6')).toEqual([['5', '5', 'count'], ['$6', '6', 'currency']])
  })

  it.each([
    ['1.2 million', '1200000', -5],
    ['1.20 million', '1200000', -4],
    ['3 billion', '3000000000', -9],
    ['$3.4M', '3400000', -5],
    ['$3.4m', '3400000', -5],
    ['5 bn', '5000000000', -9],
    ['7 thousand', '7000', -3],
    ['$2K', '2000', -3],
    ['3.4M USD', '3400000', -5],
    ['5 million dollars', '5000000', -6],
  ])('magnitude %s', (text, value, scale) => {
    expect(one(text)).toMatchObject({ value, scale, ambiguous: false })
  })

  it('a magnitude letter with no money around it is ambiguous', () => {
    for (const text of ['4K', '4k', '2M', '3B', '1T']) {
      const t = one(text)
      expect(t.ambiguity, text).toBe('suffix')
      expect(t.alternates).toHaveLength(1)
    }
    expect(one('4K').alternates?.[0]).toEqual({ value: '4', scale: 0 })
  })

  it('reads ordinals, units and the multiplier x', () => {
    expect(one('3rd')).toMatchObject({ kind: 'ordinal', value: '3' })
    expect(one('21st')).toMatchObject({ kind: 'ordinal' })
    expect(one('5kg')).toMatchObject({ unit: 'kg', kind: 'count' })
    expect(one('2.5 hours')).toMatchObject({ unit: 'hour', kind: 'decimal' })
    expect(one('30-day')).toMatchObject({ unit: 'day', value: '30' })
    expect(one('10x')).toMatchObject({ unit: 'x' })
    expect(one('5 users')).not.toHaveProperty('unit')
  })

  it('classifies a bare four-digit number in range as a year', () => {
    expect(one('in 2025')).toMatchObject({ kind: 'year', value: '2025' })
    expect(one('2025.5')).toMatchObject({ kind: 'decimal' })
    expect(one('1,999')).toMatchObject({ kind: 'count' })
    expect(one('3000')).toMatchObject({ kind: 'count' })
  })
})

describe('exponents and fractions', () => {
  it('reads scientific notation exactly, with the precision it shows', () => {
    expect(one('1.5e3')).toMatchObject({ value: '1500', scale: -2, ambiguous: false })
    expect(one('2E-4')).toMatchObject({ value: '0.0002', scale: 4, kind: 'decimal' })
    expect(one('6.02e+23', { })).toMatchObject({ value: '602000000000000000000000' })
    expect(one('1e999')).toMatchObject({ ambiguous: true, ambiguity: 'too-long' })
    expect(extractNumbers('5e and 0x1F')).toEqual([])
  })

  it('flags an inline exponent instead of reading the base alone', () => {
    expect(one('10^6')).toMatchObject({ ambiguous: true, ambiguity: 'superscript', raw: '10^6' })
    expect(one('2^-3')).toMatchObject({ ambiguity: 'superscript' })
    expect(one('10\u00b2')).toMatchObject({ ambiguity: 'superscript' })
  })

  it('flags both halves of a fraction; a date is not a fraction', () => {
    const [a, b] = extractNumbers('3/4 of users')
    expect([a?.ambiguity, b?.ambiguity]).toEqual(['fraction', 'fraction'])
    expect(extractNumbers('1/2/3').every((t) => t.ambiguity === 'fraction')).toBe(true)
    expect(extractNumbers('3/4/2026').every((t) => t.kind === 'date-part')).toBe(true)
  })
})

describe('ranges', () => {
  it('splits a range and shares a trailing unit or leading currency', () => {
    const [a, b] = extractNumbers('10-12%')
    expect([a?.kind, a?.range, b?.kind, b?.range]).toEqual(['percent', 'start', 'percent', 'end'])
    const [c, d] = extractNumbers('$10-12')
    expect([c?.currency, d?.currency, d?.kind]).toEqual(['USD', 'USD', 'currency'])
    const [e, f] = extractNumbers('5–10 days')
    expect([e?.unit, f?.unit]).toEqual(['day', 'day'])
    expect(extractNumbers('$10-$12').map((t) => t.currency)).toEqual(['USD', 'USD'])
  })
})

describe('dates and times', () => {
  it('reads ISO dates by part', () => {
    const t = extractNumbers('on 2026-10-09 ok')
    expect(t.map((x) => [x.value, x.part, x.kind])).toEqual([
      ['2026', 'year', 'date-part'], ['10', 'month', 'date-part'], ['9', 'day', 'date-part'],
    ])
    expect(t.every((x) => x.groupRaw === '2026-10-09')).toBe(true)
  })

  it('reads numeric dates by locale and flags an unclear order', () => {
    const us = extractNumbers('10/12/2026')
    expect(us.map((x) => [x.value, x.part ?? null, x.ambiguity ?? null])).toEqual([
      ['10', null, 'date-order'], ['12', null, 'date-order'], ['2026', 'year', null],
    ])
    // Structure decides when one number is above 12.
    expect(extractNumbers('13/10/2026').map((x) => [x.value, x.part])).toEqual([['13', 'day'], ['10', 'month'], ['2026', 'year']])
    expect(extractNumbers('10/13/2026').map((x) => [x.value, x.part])).toEqual([['10', 'month'], ['13', 'day'], ['2026', 'year']])
    // Equal numbers cannot be mixed up.
    expect(extractNumbers('10/10/2026').every((x) => !x.ambiguous)).toBe(true)
    // German dates use dots.
    expect(extractNumbers('13.10.2026', { locale: 'de-DE' }).map((x) => x.part)).toEqual(['day', 'month', 'year'])
  })

  it('reads month names and attaches the month as a date part', () => {
    const t = extractNumbers('Due October 12, 2026 and 3 March 2027.')
    expect(t.map((x) => [x.raw, x.value, x.part])).toEqual([
      ['October', '10', 'month'], ['12', '12', 'day'], ['2026', '2026', 'year'],
      ['3', '3', 'day'], ['March', '3', 'month'], ['2027', '2027', 'year'],
    ])
    expect(extractNumbers('the 3rd of July').map((x) => [x.raw, x.part])).toEqual([['3rd', 'day'], ['July', 'month']])
    expect(extractNumbers('the 1st of May, 2026').map((x) => [x.raw, x.part])).toEqual([
      ['1st', 'day'], ['May', 'month'], ['2026', 'year'],
    ])
    // A number after a date is a year only when it can be one.
    expect(extractNumbers('on 5 March, 3000 people came').map((x) => [x.raw, x.part ?? x.kind])).toEqual([
      ['5', 'day'], ['March', 'month'], ['3000', 'count'],
    ])
  })

  it('does not read a lowercase modal verb as a month', () => {
    expect(extractNumbers('you may 5 times')).toEqual([expect.objectContaining({ raw: '5', kind: 'count' })])
  })

  it('reads times of day', () => {
    expect(extractNumbers('at 14:30:05').map((x) => [x.value, x.part])).toEqual([['14', 'hour'], ['30', 'minute'], ['5', 'second']])
  })
})

describe('glued letters', () => {
  it('skips identifiers: model names, versions, codes', () => {
    const text = 'The X3, v2.1, COVID-19, H2O, GPT-4, F-16, 5G, A4, 3D, FY2025, Q3, iPhone15 and x86_64.'
    expect(extractNumbers(text)).toEqual([])
  })

  it('still reads a number after a skipped identifier', () => {
    expect(fields('Model X3 sold 45 units in Q3-2026')).toEqual([['45', '45', 'count'], ['2026', '2026', 'year']])
  })

  it('never reaches Object.prototype through a glued word', () => {
    expect(extractNumbers('5constructor 5__proto__ 5toString 3 hasOwnProperty').map((t) => t.raw)).toEqual(['3'])
    expect(extractNumbers('May 5 constructor 7 valueOf')).toHaveLength(3)
  })
})

describe('input validation', () => {
  it('rejects a non-string text and unknown options', () => {
    expect(() => extractNumbers(5 as unknown as string)).toThrow(TypeError)
    expect(() => extractNumbers(new String('5') as unknown as string)).toThrow(TypeError)
    expect(() => extractNumbers('5', { locale: 'xx-YY' })).toThrow(RangeError)
    expect(() => extractNumbers('5', { locale: 'not a locale!' })).toThrow(RangeError)
    expect(() => extractNumbers('5', { locale: 5 as unknown as string })).toThrow(TypeError)
    expect(() => extractNumbers('5', { localee: 'en' } as unknown as ExtractOptions)).toThrow(RangeError)
    expect(() => extractNumbers('5', [] as unknown as ExtractOptions)).toThrow(TypeError)
  })

  it('returns frozen tokens with offsets into the original text', () => {
    const text = 'a   1,234.5 and (7%)'
    for (const t of extractNumbers(text)) {
      expect(Object.isFrozen(t)).toBe(true)
      expect(text.slice(t.start, t.end)).toBe(t.raw)
    }
  })
})
