import { describe, expect, it } from 'vitest'
import { extractNumbers } from '../src/index.js'
import { SUPPORTED_LANGUAGES, resolveLocale } from '../src/locale.js'
import { checkLocale, icuLocales } from '../scripts/crosscheck-lib.mjs'

// Locale handling against this Node's own ICU/CLDR: for every locale of every supported language that ICU has data for, print 51 numbers
// (integers and decimals, both signs, four grouping modes, written as exact decimal strings) with Intl.NumberFormat, read them back with
// extractNumbers, and compare the kit's decimal mark and numeric-date order with what ICU prints. A CLDR update that changes a
// locale makes this fail on purpose: the kit's locale table is then out of date.

const tags = icuLocales(SUPPORTED_LANGUAGES)

describe(`locales against ICU ${process.env.NODE_ICU_VERSION ?? ''} (icu-crosscheck:)`, { timeout: 120_000 }, () => {
  it('icu-crosscheck: the enumeration finds the regional locales of every supported language', () => {
    expect(tags.length).toBeGreaterThan(150)
    for (const lang of ['en', 'de', 'fr', 'es', 'pt', 'it', 'nl', 'ms', 'hi']) expect(tags.some((t) => t === lang || t.startsWith(`${lang}-`)), lang).toBe(true)
  })

  for (const lang of SUPPORTED_LANGUAGES) {
    const mine = tags.filter((t) => t === lang || t.startsWith(`${lang}-`))
    if (mine.length === 0) continue
    it(`icu-crosscheck: ${lang} (${mine.length} locales) reads back what ICU prints and matches its decimal mark and date order`, () => {
      const bad: string[] = []
      for (const tag of mine) bad.push(...checkLocale(extractNumbers, resolveLocale, tag).mismatches)
      expect(bad.slice(0, 8)).toEqual([])
    })
  }

  it('icu-crosscheck: English locales that print a decimal comma read it as one', () => {
    for (const tag of ['en-DE', 'en-NL', 'en-SE', 'en-AT', 'en-ZA']) {
      for (const value of ['123.456', '1.5']) {
        const printed = new Intl.NumberFormat(tag, { minimumFractionDigits: value.length - value.indexOf('.') - 1 }).format(value as unknown as number)
        const [t, ...rest] = extractNumbers(printed, { locale: tag })
        expect(rest, tag).toEqual([])
        expect(t, `${tag} ${printed}`).toMatchObject({ value })
      }
    }
  })

  it('icu-crosscheck: Spanish and Italian locales that print a decimal point read it as one', () => {
    for (const tag of ['es-419', 'es-BR', 'es-CU', 'it-CH', 'es-MX']) {
      for (const value of ['123.456', '1.5']) {
        const printed = new Intl.NumberFormat(tag, { minimumFractionDigits: value.length - value.indexOf('.') - 1 }).format(value as unknown as number)
        const [t, ...rest] = extractNumbers(printed, { locale: tag })
        expect(rest, tag).toEqual([])
        expect(t, `${tag} ${printed}`).toMatchObject({ value })
      }
    }
  })

  it('icu-crosscheck: the regional rules also hold with a Unicode extension and for a numeric region', () => {
    for (const [tag, text] of [['en-DE-u-nu-latn', '123,456'], ['es-419', '123.456'], ['es-419-u-nu-latn', '123.456'], ['ms-ID-u-ca-gregory', '123,456']] as const) {
      const [t, ...rest] = extractNumbers(text, { locale: tag })
      expect(rest, tag).toEqual([])
      expect(t, tag).toMatchObject({ value: '123.456' })
    }
    expect(resolveLocale('en-PR').order).toBe('MDY')
    expect(resolveLocale('en-PR-u-ca-gregory').order).toBe('MDY')
  })
})
