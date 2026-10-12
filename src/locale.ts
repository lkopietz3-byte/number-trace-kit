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
  if (locale.length > 35 || !/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(locale)) {
    throw new RangeError(`${name} "${locale}" is not a language tag such as "en-US" or "de-DE".`)
  }
  const tag = locale.toLowerCase().replace(/_/g, '-')
  const language = tag.split('-')[0] ?? tag
  const region = tag.split('-').find((part, i) => i > 0 && /^[a-z]{2}$/.test(part))
  const regional = region === undefined ? language : `${language}-${region}`
  let decimal: number
  if (DOT_REGIONS.has(regional)) decimal = 0x2e
  else if (COMMA_REGIONS.has(regional)) decimal = 0x2c
  else if (DOT_DECIMAL.has(language)) decimal = 0x2e
  else if (COMMA_DECIMAL.has(language)) decimal = 0x2c
  else {
    throw new RangeError(
      `${name} "${locale}": language "${language}" is not supported. Supported languages: ${SUPPORTED_LANGUAGES.join(', ')}.`,
    )
  }
  const order: DateOrder = MDY_REGIONS.has(regional) ? 'MDY' : 'DMY'
  return { language, decimal, order, indian: region === 'in', apostrophe: region === 'ch' || region === 'li' }
}
