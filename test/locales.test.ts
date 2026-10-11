import { describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'

// Round-trip against the platform's own number formatting, so the separator
// rules are checked against how real locales print numbers and not only
// against examples written by hand.

const LOCALES = [
  'en-US', 'en-GB', 'en-IN', 'en-CA', 'en-AU', 'de-DE', 'de-CH', 'de-AT', 'fr-FR', 'fr-CH', 'fr-CA', 'es-ES', 'es-MX',
  'pt-BR', 'pt-PT', 'it-IT', 'nl-NL', 'ja-JP', 'ru-RU', 'sv-SE', 'pl-PL', 'tr-TR', 'da-DK', 'nb-NO', 'fi-FI', 'cs-CZ', 'id-ID',
]

function lcg(seed: number): () => number {
  let s = seed
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function randomDecimal(rnd: () => number): { text: string; fraction: number } {
  const digits = 1 + Math.floor(rnd() * 9)
  let int = ''
  for (let k = 0; k < digits; k++) int += String(Math.floor(rnd() * 10))
  int = int.replace(/^0+(?=\d)/, '')
  const fraction = Math.floor(rnd() * 4)
  let frac = ''
  for (let k = 0; k < fraction; k++) frac += String(Math.floor(rnd() * 10))
  return { text: int + (frac === '' ? '' : `.${frac}`), fraction }
}

describe('numbers as the platform prints them', { timeout: 60_000 }, () => {
  for (const locale of LOCALES) {
    it(`${locale}: every printed number reads back exactly, or is flagged with the right alternate`, () => {
      const rnd = lcg(42)
      let flagged = 0
      for (let i = 0; i < 300; i++) {
        const { text, fraction } = randomDecimal(rnd)
        const printed = new Intl.NumberFormat(locale, {
          minimumFractionDigits: fraction,
          maximumFractionDigits: fraction,
        }).format(text as unknown as number)
        const tokens = extractNumbers(printed, { locale })
        expect(tokens.length, printed).toBe(1)
        const t = tokens[0]
        if (t === undefined) throw new Error('unreachable')
        if (t.ambiguous) {
          flagged++
          expect([t.value, ...(t.alternates ?? []).map((a) => a.value)], printed).toContain(text)
        } else {
          expect(t.value, printed).toBe(text)
        }
      }
      // Ambiguity is the exception (a lone group of three digits), never the rule.
      expect(flagged).toBeLessThan(60)
    })
  }

  it('currency and percent styles read back with their unit', () => {
    const cases: Array<[string, Intl.NumberFormatOptions, string, string, string]> = [
      ['en-US', { style: 'currency', currency: 'USD' }, '1234.5', '1234.50', 'USD'],
      ['en-GB', { style: 'currency', currency: 'GBP' }, '1234.5', '1234.50', 'GBP'],
      ['en-IN', { style: 'currency', currency: 'INR' }, '1234567.5', '1234567.50', 'INR'],
      ['de-DE', { style: 'currency', currency: 'EUR' }, '1234.5', '1234.50', 'EUR'],
      ['fr-FR', { style: 'currency', currency: 'EUR' }, '1234567.5', '1234567.50', 'EUR'],
      ['es-ES', { style: 'currency', currency: 'EUR' }, '1234.5', '1234.50', 'EUR'],
      ['pt-BR', { style: 'currency', currency: 'BRL' }, '1234.5', '1234.50', 'BRL'],
      ['de-CH', { style: 'currency', currency: 'CHF' }, '1234567.5', '1234567.50', 'CHF'],
      // A bare dollar sign is read as USD even where it means another dollar: documented.
      ['en-CA', { style: 'currency', currency: 'CAD' }, '1234.5', '1234.50', 'USD'],
      ['en-CA', { style: 'currency', currency: 'CAD', currencyDisplay: 'code' }, '1234.5', '1234.50', 'CAD'],
      ['en-US', { style: 'currency', currency: 'AUD' }, '1234.5', '1234.50', 'AUD'],
      ['en-US', { style: 'currency', currency: 'EUR', currencyDisplay: 'code' }, '99.9', '99.90', 'EUR'],
      ['de-DE', { style: 'currency', currency: 'USD' }, '1234.5', '1234.50', 'USD'],
    ]
    for (const [locale, options, input, value, currency] of cases) {
      const printed = new Intl.NumberFormat(locale, options).format(input as unknown as number)
      const [t, ...rest] = extractNumbers(printed, { locale })
      expect(rest, printed).toEqual([])
      expect(t, printed).toMatchObject({ value, kind: 'currency', currency })
    }
    for (const locale of ['en-US', 'de-DE', 'fr-FR', 'es-ES', 'ja-JP', 'pt-BR', 'it-IT']) {
      const printed = new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1 }).format(0.1234)
      const tokens = extractNumbers(printed, { locale })
      expect(tokens.map((x) => [x.value, x.kind, x.unit]), printed).toEqual([['12.3', 'percent', '%']])
    }
  })

  it('a German amount traces to the same amount printed by another locale', () => {
    const de = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(1234567.5)
    const us = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR', currencyDisplay: 'code' }).format(1234567.5)
    expect(traceNumbers(de, us, { locale: 'de-DE', evidenceLocale: 'en-US' }).verdict).toBe('clean')
    expect(traceNumbers(us, de, { locale: 'en-US', evidenceLocale: 'de-DE' }).verdict).toBe('clean')
  })

  it('negative numbers use the platform minus', () => {
    for (const locale of ['en-US', 'de-DE', 'fr-FR', 'sv-SE', 'nb-NO']) {
      const printed = new Intl.NumberFormat(locale).format(-1234.5)
      const [t] = extractNumbers(printed, { locale })
      expect(t, printed).toMatchObject({ value: '-1234.5', signStyle: 'minus' })
    }
  })
})
