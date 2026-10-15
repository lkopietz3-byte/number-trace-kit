// Locale handling: which character is the decimal mark, and what order a
// numeric date is written in. Deliberately small and explicit. An unknown
// language is an error, not a guess.

export type DateOrder = 'MDY' | 'DMY'

export interface LocaleInfo {
  /** The lower-case language code, such as `en` or `de`. */
  readonly language: string
  /** Char code of the decimal mark: 0x2e (.) or 0x2c (,). */
  readonly decimal: number
  readonly order: DateOrder
  /** Indian digit grouping (12,34,567) as well as groups of three. */
  readonly indian: boolean
  /** An apostrophe groups digits (Swiss style 1'234'567). */
  readonly apostrophe: boolean
}

const DOT_DECIMAL = new Set(['en', 'ja', 'zh', 'ko', 'he', 'th', 'hi', 'ms', 'fil', 'ga', 'cy'])
const COMMA_DECIMAL = new Set([
  'de', 'fr', 'es', 'it', 'pt', 'nl', 'ru', 'pl', 'sv', 'da', 'nb', 'nn', 'no', 'fi', 'cs', 'sk',
  'sl', 'hr', 'ro', 'hu', 'bg', 'tr', 'id', 'vi', 'el', 'uk', 'sr', 'lt', 'lv', 'et',
])
// Regions that use the other mark than their language's default.
const DOT_REGIONS = new Set(['de-ch', 'de-li', 'es-mx', 'es-us', 'es-pr', 'es-gt', 'es-hn', 'es-ni', 'es-pa', 'es-pe', 'es-sv', 'es-do'])
const COMMA_REGIONS = new Set(['en-za'])
const MDY_REGIONS = new Set(['en-us', 'en', 'en-ph'])

export const SUPPORTED_LANGUAGES: readonly string[] = [...DOT_DECIMAL, ...COMMA_DECIMAL].sort()

const DEFAULT: LocaleInfo = { language: 'en', decimal: 0x2e, order: 'MDY', indian: false, apostrophe: false }

export function resolveLocale(locale: unknown, name = 'locale'): LocaleInfo {
  if (locale === undefined) return DEFAULT
  if (typeof locale !== 'string') throw new TypeError(`${name} must be a string such as "en-US", got ${typeof locale}.`)
  if (locale.length > 35 || !/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{1,8})*$/.test(locale)) {
    throw new RangeError(`${name} is not a language tag such as "en-US" or "de-DE" (at most 35 characters).`)
  }
  const parts = locale.toLowerCase().split(/[-_]/)
  const language = parts[0] ?? ''
  // Language, then script, region and variants, up to the first extension (a one-character subtag).
  let end = parts.length
  for (let i = 1; i < parts.length; i++) {
    if (parts[i]?.length === 1) {
      end = i
      break
    }
  }
  if (end < parts.length) {
    // "en-US-u-nu-latn", "ja-JP-u-ca-japanese": the Unicode extension holds calendar, hour-cycle and digit choices.
    // The kit reads every digit script it knows whatever "nu" says, so the keywords change nothing here.
    const singleton = parts[end] ?? ''
    if (singleton !== 'u') {
      throw new RangeError(`${name}: the "${singleton.slice(0, 1)}" extension is not supported; use a language-region tag such as "en-US", with or without a -u- extension.`)
    }
    if (parts.length === end + 1 || parts.slice(end + 1).some((p) => p.length === 1 || p.length < 2)) {
      throw new RangeError(`${name}: the -u- extension needs keywords of two to eight characters, such as "nu-latn".`)
    }
  }
  const head = parts.slice(1, end)
  const region = head.find((part) => /^[a-z]{2}$/.test(part))
  const regional = region === undefined ? language : `${language}-${region}`
  let decimal: number
  if (DOT_REGIONS.has(regional)) decimal = 0x2e
  else if (COMMA_REGIONS.has(regional)) decimal = 0x2c
  else if (DOT_DECIMAL.has(language)) decimal = 0x2e
  else if (COMMA_DECIMAL.has(language)) decimal = 0x2c
  else {
    throw new RangeError(
      `${name}: language "${language}" is not supported. Supported languages: ${SUPPORTED_LANGUAGES.join(', ')}.`,
    )
  }
  const order: DateOrder = MDY_REGIONS.has(regional) ? 'MDY' : 'DMY'
  // The platform groups Hindi in lakhs and crores whatever the region ("hi", "hi-US"), and English in India.
  return { language, decimal, order, indian: region === 'in' || language === 'hi', apostrophe: region === 'ch' || region === 'li' }
}
