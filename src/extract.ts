import { MAX_DIGITS } from './decimal.js'
import { MAX_TEXT_LENGTH, noProto, readBoolean, readOptions } from './input.js'
import { resolveLocale } from './locale.js'
import type { LocaleInfo } from './locale.js'
import type {
  AmbiguityReason,
  DatePart,
  ExtractOptions,
  NumberKind,
  NumberToken,
  Reading,
  SignStyle,
} from './types.js'

// A hand-written scanner. Every character is visited a bounded number of
// times: the only look-behind and look-ahead are fixed-size windows, and a
// digit-and-separator chain is collected once and then consumed left to right.

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
type Tok = Mutable<NumberToken>

/** U+2013. Read as a minus sign it is a guess, so a number glued behind one is flagged (`sign`). */
const EN_DASH = 0x2013

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
  june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
}

/**
 * Month names in German, French, Spanish, Italian, Portuguese, Dutch and Swedish, lower case, January first.
 * Written out in full they need no capital letter and no dot ("5 mars 2026", "5 de marzo de 2026"); English
 * names need a capital (MONTHS above) because "may" and "mar" are words.
 */
const MONTH_WORDS: readonly (readonly string[])[] = [
  ['janvier', 'januar', 'jänner', 'janner', 'enero', 'gennaio', 'janeiro', 'januari'],
  ['février', 'fevrier', 'februar', 'febrero', 'febbraio', 'fevereiro', 'februari'],
  ['mars', 'märz', 'maerz', 'marzo', 'março', 'maart'],
  ['avril', 'april', 'abril', 'aprile'],
  ['mai', 'mayo', 'maggio', 'maio', 'mei', 'maj'],
  ['juin', 'juni', 'junio', 'giugno', 'junho'],
  ['juillet', 'juli', 'julio', 'luglio', 'julho'],
  ['août', 'aout', 'august', 'agosto', 'augustus', 'augusti'],
  ['septembre', 'september', 'septiembre', 'setiembre', 'settembre', 'setembro'],
  ['octobre', 'oktober', 'octubre', 'ottobre', 'outubro'],
  ['novembre', 'november', 'noviembre', 'novembro'],
  ['décembre', 'decembre', 'dezember', 'december', 'diciembre', 'dicembre', 'dezembro'],
]
/** Abbreviations that count only with their dot ("janv.", "févr.", "sept."). */
const MONTH_ABBREVIATIONS_BY_MONTH: readonly (readonly string[])[] = [
  ['janv', 'jan', 'ene', 'gen'], ['févr', 'fevr', 'feb', 'fev'], ['mär', 'mrz'], ['avr', 'apr', 'abr'], ['mag'], ['giu', 'jun'],
  ['juil', 'jul', 'lug'], ['août', 'aoû', 'ago', 'aug'], ['sept', 'sep', 'set'], ['oct', 'okt', 'ott', 'out'], ['nov'], ['déc', 'dec', 'dez', 'dic'],
]

/** A word to month map. A word that two tables give different months is left out. */
function monthMap(table: readonly (readonly string[])[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>()
  const clash = new Set<string>()
  table.forEach((words, index) => {
    for (const w of words) {
      const had = out.get(w)
      if (had !== undefined && had !== index + 1) clash.add(w)
      out.set(w, index + 1)
    }
  })
  for (const w of clash) out.delete(w)
  return out
}
const MONTH_NAMES = monthMap(MONTH_WORDS)
const MONTH_ABBREVIATIONS = monthMap(MONTH_ABBREVIATIONS_BY_MONTH)
/** Languages whose worded dates are read (the rest are `unread-date`, see below), and the East Asian ones read by their markers. */
/** Words that are a month in another language and also an English word or name ("Mars 2020", "Mayo Clinic"): capitalized, they count only when the locale is not English. */
const MONTH_NAME_COLLISIONS: ReadonlySet<string> = new Set(['mars', 'mayo', 'mai', 'maj', 'mei', 'juli', 'juni'])
/** Languages with a month table of their own. */
const MONTH_TABLE_LANGUAGES: ReadonlySet<string> = new Set(['de', 'fr', 'es', 'it', 'pt', 'nl', 'sv'])
const READ_DATE_LANGUAGES: ReadonlySet<string> = new Set(['en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'sv', 'ja', 'zh', 'ko'])

// A Map, so an inherited property on Object.prototype can never read as a currency symbol.
const CURRENCY_SYMBOLS: ReadonlyMap<number, string> = new Map([
  [0x24, 'USD'], [0x20ac, 'EUR'], [0xa3, 'GBP'], [0xa5, '¥'], [0x20b9, 'INR'], [0x20a9, 'KRW'],
  [0x20bd, 'RUB'], [0x20ba, 'TRY'], [0x20ab, 'VND'], [0x20aa, 'ILS'], [0x20b1, 'PHP'], [0xe3f, 'THB'],
  [0x20b4, 'UAH'], [0x20a6, 'NGN'],
])
const CURRENCY_CODES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'MXN', 'BRL', 'KRW', 'SEK',
  'NOK', 'DKK', 'NZD', 'SGD', 'HKD', 'PLN', 'ZAR', 'RUB', 'TRY', 'TWD',
])
// Letters glued before a dollar sign that say which dollar ("CA$5", "NT$5", "Mex$5").
const DOLLAR_PREFIXES: Record<string, string> = {
  US: 'USD', CA: 'CAD', AU: 'AUD', NZ: 'NZD', HK: 'HKD', MX: 'MXN', SG: 'SGD', TW: 'TWD', NT: 'TWD', Mex: 'MXN', MEX: 'MXN',
  C: 'CAD', A: 'AUD', S: 'SGD', R: 'BRL',
  USD: 'USD', CAD: 'CAD', AUD: 'AUD', NZD: 'NZD', HKD: 'HKD', MXN: 'MXN', SGD: 'SGD', TWD: 'TWD',
}
// The codes a bare dollar sign can stand for, and the ones a bare yen sign can.
const DOLLAR_CODES: ReadonlySet<string> = new Set(['USD', 'CAD', 'AUD', 'NZD', 'HKD', 'SGD', 'MXN', 'TWD'])
const YEN_CODES: ReadonlySet<string> = new Set(['JPY', 'CNY'])

/** A currency written before the amount. `family` is set for a bare `$` or `¥`, which a code may make specific. */
interface CurrencyMatch {
  start: number
  code: string
  family?: 'dollar' | 'yen'
  /** A code before a symbol that cannot be that currency ("EUR $500"). */
  conflict?: true
}

/**
 * The currency of an amount that has a symbol or prefix before it and a code or word after it
 * ("$500 CAD", "CA$500 dollars"). Returns the code to use, or null when the two disagree.
 */
function resolveCurrency(cur: CurrencyMatch, found: string, dollarWord: boolean): string | null {
  if (found === cur.code) return cur.code
  if (dollarWord) return cur.family === 'dollar' || DOLLAR_CODES.has(cur.code) ? cur.code : null
  if (cur.family === 'dollar') return DOLLAR_CODES.has(found) ? found : null
  if (cur.family === 'yen') return YEN_CODES.has(found) ? found : null
  return null
}
const CURRENCY_WORDS: Record<string, string> = {
  dollars: 'USD', dollar: 'USD', euros: 'EUR', euro: 'EUR', usd: 'USD', eur: 'EUR', gbp: 'GBP',
  cad: 'CAD', aud: 'AUD', chf: 'CHF', jpy: 'JPY', cny: 'CNY', inr: 'INR',
}

// A word before "dollars" that says which dollar ("5 US dollars", "$5 Canadian dollars").
const DOLLAR_ADJECTIVES: Record<string, string> = {
  us: 'USD', american: 'USD', canadian: 'CAD', australian: 'AUD', singapore: 'SGD', singaporean: 'SGD', taiwan: 'TWD',
}

// Words that say "percent" ("45 percent", "45-percent").
const PERCENT_WORDS: Record<string, '%'> = {
  percent: '%', pct: '%', prozent: '%', procent: '%', procento: '%', procenten: '%', prosent: '%', pourcent: '%',
}

// Units written right against the number ("5kg"). Case matters here.
const GLUED_UNITS: Record<string, string> = {
  c: 'c', cpp: 'cpp', mo: 'month', mos: 'month', pt: 'pt', pts: 'pt', kg: 'kg', g: 'g', mg: 'mg', 'μm': 'μm', 'μs': 'μs', 'μg': 'μg', 'μL': 'μl', 'μl': 'μl', lb: 'lb', lbs: 'lb', oz: 'oz', km: 'km', m: 'm', cm: 'cm', mm: 'mm',
  mi: 'mi', ft: 'ft', ms: 'ms', s: 'second', h: 'hour', hr: 'hour', hrs: 'hour', min: 'minute',
  mins: 'minute', sec: 'second', secs: 'second', yr: 'year', yrs: 'year', KB: 'KB', kB: 'KB',
  MB: 'MB', GB: 'GB', TB: 'TB', PB: 'PB', EB: 'EB', Kb: 'Kb', Mb: 'Mb', Gb: 'Gb', Tb: 'Tb', Pb: 'Pb',
  KiB: 'KiB', MiB: 'MiB', GiB: 'GiB', TiB: 'TiB', PiB: 'PiB', ml: 'ml', mL: 'ml', L: 'l', l: 'l', kW: 'kW', kWh: 'kWh', MW: 'MW',
  GHz: 'GHz', MHz: 'MHz', mph: 'mph', kph: 'kph', x: 'x', am: 'am', pm: 'pm', bps: 'bps',
  KBps: 'KBps', kBps: 'KBps', MBps: 'MBps', GBps: 'GBps', TBps: 'TBps',
  // All lower case is the everyday shorthand for bytes ("5 gb"); a capital M, G, T, K or P with a lower-case b is bits.
  kb: 'KB', mb: 'MB', gb: 'GB', tb: 'TB', pb: 'PB',
}
// Bit rates are lower-cased into one unit, so a capital B (a byte rate, "MBps") must be kept out of them.
const BIT_RATES: ReadonlySet<string> = new Set(['kbps', 'mbps', 'gbps', 'tbps'])
const isByteRateWord = (w: string): boolean => w.length === 4 && w.charCodeAt(1) === 0x42 && BIT_RATES.has(w.toLowerCase())

/** The unit a word after a number or a hyphen says, compared in lower case; a byte rate ("MBps") is not a bit rate. */
function spacedUnit(w: string): string | undefined {
  return isByteRateWord(w) ? undefined : own(SPACED_UNITS, w.toLowerCase())
}
// Units written as a following word ("3 days"). Compared in lower case.
const SPACED_UNITS: Record<string, string> = {
  day: 'day', days: 'day', week: 'week', weeks: 'week', month: 'month', months: 'month',
  year: 'year', years: 'year', yr: 'year', yrs: 'year', hour: 'hour', hours: 'hour', hr: 'hour',
  hrs: 'hour', minute: 'minute', minutes: 'minute', min: 'minute', mins: 'minute', second: 'second',
  seconds: 'second', sec: 'second', secs: 'second', cent: 'c', cents: 'c', pt: 'pt', pts: 'pt', kg: 'kg', kilogram: 'kg', kilograms: 'kg',
  gram: 'g', grams: 'g', mg: 'mg', 'μm': 'μm', 'μs': 'μs', 'μg': 'μg', 'μl': 'μl', lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb', oz: 'oz',
  ounce: 'oz', ounces: 'oz', mile: 'mi', miles: 'mi', km: 'km', kilometer: 'km', kilometers: 'km',
  kilometre: 'km', kilometres: 'km', meter: 'm', meters: 'm', metre: 'm', metres: 'm', cm: 'cm',
  mm: 'mm', foot: 'ft', feet: 'ft', ft: 'ft', inch: 'in', inches: 'in', gallon: 'gal',
  gallons: 'gal', liter: 'l', liters: 'l', litre: 'l', litres: 'l', ml: 'ml', bps: 'bps', mph: 'mph',
  celsius: '°C', fahrenheit: '°F', centigrade: '°C',
  hz: 'Hz', khz: 'kHz', mhz: 'MHz', ghz: 'GHz', db: 'dB', kw: 'kW', kwh: 'kWh', kcal: 'kcal', mah: 'mAh',
  kbps: 'kbps', mbps: 'Mbps', gbps: 'Gbps',
  kilobit: 'Kb', kilobits: 'Kb', megabit: 'Mb', megabits: 'Mb', gigabit: 'Gb', gigabits: 'Gb', terabit: 'Tb', terabits: 'Tb',
  kbit: 'Kb', mbit: 'Mb', gbit: 'Gb', tbit: 'Tb',
  kilobyte: 'KB', kilobytes: 'KB', megabyte: 'MB', megabytes: 'MB', gigabyte: 'GB', gigabytes: 'GB', terabyte: 'TB', terabytes: 'TB',
  petabyte: 'PB', petabytes: 'PB', kbyte: 'KB', mbyte: 'MB', gbyte: 'GB', tbyte: 'TB',
  ppm: 'ppm', ppb: 'ppb', rpm: 'rpm', bpm: 'bpm', fps: 'fps', psi: 'psi', kpa: 'kPa', mpa: 'MPa', hp: 'hp', gal: 'gal',
  yd: 'yd', yds: 'yd', yard: 'yd', yards: 'yd', acre: 'ac', acres: 'ac', ha: 'ha', hectare: 'ha', hectares: 'ha', sqft: 'ft2', sqm: 'm2',
}
// Length units that square or cube when a 2 or 3 (or a superscript) follows: "800 m2", "3 km\u00b3". Lower case only: "M2" is a chip.
const POWER_BASES: ReadonlySet<string> = new Set(['m', 'cm', 'mm', 'km', 'ft', 'in', 'yd', 'mi'])
// Units written right against the number only ("250W"). A spaced single letter is too often a label
// ("5 W" is not watts), so these are not read as the next word.
const GLUED_EXTRA: Record<string, string> = {
  W: 'W', GW: 'GW', TW: 'TW', mW: 'mW', Wh: 'Wh', MWh: 'MWh', GWh: 'GWh', TWh: 'TWh', J: 'J', kJ: 'kJ', MJ: 'MJ',
  cal: 'cal', kcal: 'kcal', mA: 'mA', Ah: 'Ah', mAh: 'mAh', kV: 'kV', mV: 'mV',
  Hz: 'Hz', kHz: 'kHz', MHz: 'MHz', GHz: 'GHz', THz: 'THz', dB: 'dB', dBm: 'dBm',
  rpm: 'rpm', bpm: 'bpm', fps: 'fps', ppm: 'ppm', ppb: 'ppb', psi: 'psi', kPa: 'kPa', MPa: 'MPa', Pa: 'Pa',
  nm: 'nm', kbps: 'kbps', Kbps: 'kbps', Mbps: 'Mbps', Gbps: 'Gbps', Tbps: 'Tbps',
  d: 'day', wk: 'week', wks: 'week', y: 'year', bp: 'bp', X: 'x', sqft: 'ft2', sqm: 'm2', hp: 'hp', gal: 'gal', yd: 'yd', ha: 'ha',
}
// Glued units whose capitals never change the meaning (KG is kg, MHZ is MHz). Keys are lower case.
// Units where a capital does (mW and MW, Mb and MB, mm and MM) are exact-case entries above.
const GLUED_FOLD: Record<string, string> = {
  kg: 'kg', km: 'km', cm: 'cm', ms: 'ms', oz: 'oz', ft: 'ft', lb: 'lb', lbs: 'lb', hz: 'Hz', khz: 'kHz', mhz: 'MHz',
  ghz: 'GHz', kw: 'kW', kwh: 'kWh', mwh: 'MWh', gwh: 'GWh', twh: 'TWh', db: 'dB', kcal: 'kcal', mah: 'mAh', wh: 'Wh',
  kbps: 'kbps', mbps: 'Mbps', gbps: 'Gbps', tbps: 'Tbps', ppm: 'ppm', rpm: 'rpm', bpm: 'bpm', fps: 'fps', psi: 'psi',
  kpa: 'kPa', mpa: 'MPa', mph: 'mph', kph: 'kph',
}
// Letters glued after a number that make an identifier or a code, not a quantity ("3D", "5G", "2FA", "4WD").
const IDENT_SUFFIXES: ReadonlySet<string> = new Set(['D', 'G', 'FA', 'WD', 'AWD'])
const RESOLUTIONS: ReadonlySet<string> = new Set(['144', '240', '360', '480', '576', '720', '1080', '1440', '2160', '4320'])
// A letter prefix that is a currency written before the amount ("Rs1,500", "kr9999"): a quantity, not an identifier.
const CURRENCY_PREFIX_WORDS: ReadonlySet<string> = new Set([
  'Rs', 'RS', 'rs', 'RM', 'Rp', 'kr', 'Kr', 'KR', 'R', 'zł', 'Fr', 'Php', 'PHP', 'Tk', 'Kč', 'Ft', 'lei', 'Lei', 'Br', 'Bs',
])

const MAGNITUDE_WORDS: Record<string, number> = {
  thousand: 3, million: 6, billion: 9, trillion: 12, bn: 9, mn: 6, tn: 12,
}
// Magnitude words that mean one power of ten wherever they are used. Keys are lower case.
const FIXED_MAGNITUDE: Record<string, number> = {
  hundred: 2, tausend: 3, tsd: 3, tys: 3, lakh: 5, lakhs: 5, lac: 5, lacs: 5, crore: 7, crores: 7,
  millions: 6, millionen: 6, mio: 6, mln: 6, 'mill\u00f3n': 6, millon: 6, millones: 6, milione: 6, milioni: 6,
  'milh\u00e3o': 6, milhao: 6, 'milh\u00f5es': 6, milhoes: 6, miljoen: 6, miljon: 6, miljoner: 6,
  mrd: 9, mld: 9, milliarde: 9, milliarden: 9, milliard: 9, milliards: 9, miliardo: 9, miliardi: 9, miljard: 9, miljarder: 9,
}
// Words that are a magnitude but whose value depends on the language or on the reader (the German Billion
// is 10^12, the Spanish mil is 1,000, Cr is also an accounting credit): the number is unknown, never guessed.
const UNREAD_MAGNITUDE: ReadonlySet<string> = new Set([
  'bio', 'billionen', 'bill\u00f3n', 'billon', 'billones', 'bilh\u00e3o', 'bilhao', 'bilh\u00f5es', 'bilhoes', 'biljoen', 'biljon',
  'bln', 'mille', 'tusen', 'tusind', 'duizend',
])
// Magnitude abbreviations written with a dot ("3,5 Mio. €").
const MAGNITUDE_ABBREVIATIONS: ReadonlySet<string> = new Set(['mio', 'mrd', 'tsd', 'mln', 'mld', 'tys', 'mil', 'bln'])
const POINT_WORDS: Record<string, 'pp'> = { pp: 'pp', ppt: 'pp', ppts: 'pp', prozentpunkte: 'pp', prozentpunkt: 'pp' }
const PERCENT_PHRASES: Record<string, readonly string[]> = { per: ['cent', 'cento'], pour: ['cent'], por: ['ciento', 'cento'] }
// Magnitude words in scripts that do not use spaces, matched by their first character. Longest first.
const CJK_MAGNITUDE: ReadonlyMap<number, readonly (readonly [string, number | null])[]> = (() => {
  const words: [string, number | null][] = [
    ['\u4e07', 4], ['\u842c', 4], ['\u5104', 8], ['\u4ebf', 8],
    ['\u4e07\u4ebf', null], ['\u842c\u5104', null], ['\u767e\u4e07', null], ['\u767e\u842c', null], ['\u5343\u4e07', null], ['\u5343\u842c', null],
    ['\u5343', null], ['\u767e', null], ['\u5146', null], ['\ub9cc', null], ['\uc5b5', null], ['\uc870', null], ['\ucc9c', null], ['\ubc31', null],
  ]
  const map = new Map<number, [string, number | null][]>()
  for (const entry of words) {
    const key = entry[0].charCodeAt(0)
    const list = map.get(key) ?? []
    list.push(entry)
    map.set(key, list)
  }
  for (const list of map.values()) list.sort((a, b) => b[0].length - a[0].length)
  return map
})()
// Magnitude words in Cyrillic, Devanagari and Arabic script: read as a run of letters, then looked up.
const RUN_MAGNITUDE: ReadonlyMap<string, number | null> = new Map<string, number | null>([
  ['\u0442\u044b\u0441', null], ['\u0442\u044b\u0441\u044f\u0447', null], ['\u0442\u044b\u0441\u044f\u0447\u0438', null], ['\u0442\u044b\u0441\u044f\u0447\u0430', null],
  ['\u043c\u043b\u043d', null], ['\u043c\u043b\u0440\u0434', null], ['\u0442\u0440\u043b\u043d', null], ['\u0442\u0438\u0441', null],
  ['\u043c\u0438\u043b\u043b\u0438\u043e\u043d', null], ['\u043c\u0438\u043b\u043b\u0438\u043e\u043d\u0430', null], ['\u043c\u0438\u043b\u043b\u0438\u043e\u043d\u043e\u0432', null],
  ['\u043c\u0438\u043b\u043b\u0438\u0430\u0440\u0434', null], ['\u043c\u0438\u043b\u043b\u0438\u0430\u0440\u0434\u0430', null], ['\u043c\u0438\u043b\u043b\u0438\u0430\u0440\u0434\u043e\u0432', null],
  ['\u043c\u0456\u043b\u044c\u0439\u043e\u043d', null], ['\u043c\u0456\u043b\u044c\u0439\u043e\u043d\u0456\u0432', null], ['\u043c\u0456\u043b\u044c\u044f\u0440\u0434', null], ['\u043c\u0456\u043b\u044c\u044f\u0440\u0434\u0456\u0432', null],
  ['\u0932\u093e\u0916', 5], ['\u0915\u0930\u094b\u0921\u093c', 7], ['\u0915\u0930\u094b\u095c', 7], ['\u0915\u0930\u094b\u0921', 7],
  ['\u0939\u091c\u093c\u093e\u0930', 3], ['\u0939\u095b\u093e\u0930', 3], ['\u0939\u091c\u093e\u0930', 3], ['\u0905\u0930\u092c', null], ['\u0916\u0930\u092c', null],
  ['\u0645\u0644\u064a\u0648\u0646', null], ['\u0645\u0644\u064a\u0627\u0631', null], ['\u0623\u0644\u0641', null], ['\u0627\u0644\u0641', null], ['\u0622\u0644\u0627\u0641', null], ['\u0645\u0644\u0627\u064a\u064a\u0646', null],
])

// How a magnitude word in the text reads: its power of ten (and whether a bare letter makes it a guess),
// `null` when it is a magnitude the kit cannot value, `undefined` when it is not a magnitude word.
type Magnitude = { readonly exp: number; readonly loose: boolean } | null

function magnitudeOf(w: string, hasCurrency: boolean, language: string, spaced: boolean): Magnitude | undefined {
  const lower = w.toLowerCase()
  const fixed = own(MAGNITUDE_WORDS, lower) ?? own(FIXED_MAGNITUDE, lower)
  if (fixed !== undefined) {
    // Billion and trillion are 10^9 and 10^12 in English and 10^12 and 10^18 in most other languages.
    if ((lower === 'billion' || lower === 'trillion') && language !== 'en') return null
    return { exp: fixed, loose: false }
  }
  if (UNREAD_MAGNITUDE.has(lower)) return null
  if (lower === 'mil') return hasCurrency && language === 'en' ? { exp: 6, loose: false } : null
  if (lower === 'cr') return hasCurrency ? { exp: 7, loose: false } : null
  if (w === 'MM') return hasCurrency ? { exp: 6, loose: false } : spaced ? undefined : { exp: 6, loose: true }
  if (w === 'mm' && hasCurrency) return { exp: 6, loose: false }
  return undefined
}

/** The power of ten of a single magnitude letter (K, M, B, T in either case), or -1. */
function letterExp(w: string): number {
  return w === 'K' || w === 'k' ? 3 : w === 'M' || w === 'm' ? 6 : w === 'B' || w === 'b' ? 9 : w === 'T' || w === 't' ? 12 : -1
}

// Vulgar fraction characters: the digits after the decimal point when the fraction is exact, `null` when it is not.
const VULGAR_FRACTIONS: ReadonlyMap<number, string | null> = new Map<number, string | null>([
  [0xbc, '25'], [0xbd, '5'], [0xbe, '75'], [0x2150, null], [0x2151, null], [0x2152, '1'], [0x2153, null], [0x2154, null],
  [0x2155, '2'], [0x2156, '4'], [0x2157, '6'], [0x2158, '8'], [0x2159, null], [0x215a, null], [0x215b, '125'], [0x215c, '375'],
  [0x215d, '625'], [0x215e, '875'], [0x2189, ''],
])

/** A table lookup that never reaches Object.prototype ("constructor", "toString", ...). */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

/** What a word after a hyphen ("100-days", "12-percent", "50-dollars") says about the number before it. */
function hyphenWord(w: string): { unit?: string; percent?: '%'; currency?: string } | undefined {
  const lower = w.toLowerCase()
  const unit = spacedUnit(w)
  if (unit !== undefined) return { unit }
  const percent = own(PERCENT_WORDS, lower)
  if (percent !== undefined) return { percent }
  const currency = own(CURRENCY_WORDS, lower)
  if (currency !== undefined && lower.length > 3) return { currency }
  return undefined
}

/** The unit of a word glued to a number: exact case first, then the forms where case makes no difference. */
function glueUnit(w: string): string | undefined {
  const exact = own(GLUED_UNITS, w) ?? own(GLUED_EXTRA, w)
  if (exact !== undefined) return exact
  const lower = w.toLowerCase()
  if (w.length >= 3) {
    const spaced = spacedUnit(w)
    if (spaced !== undefined) return spaced
  }
  return isByteRateWord(w) ? undefined : own(GLUED_FOLD, lower)
}

const NBSP = 0xa0
const NNBSP = 0x202f
const THIN = 0x2009

function isGroupSpace(c: number): boolean {
  return c === NBSP || c === NNBSP || c === THIN
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39
}

/** A letter of any script that has words (Latin, Greek, Cyrillic, Hebrew, Arabic, Devanagari, Thai): for the worded-date check. */
function isWordLetter(c: number): boolean {
  return isLetter(c) || (c >= 0x370 && c <= 0x6ff && c !== 0x37e && c !== 0x387 && c !== 0x589) || (c >= 0x900 && c <= 0x97f) || (c >= 0xe00 && c <= 0xe7f)
}

function isUpper(c: number): boolean {
  return c >= 0x41 && c <= 0x5a
}

/**
 * Letters that glue a number into an identifier or a unit: the Latin
 * alphabet. Letters of other scripts end a number instead ("100円", "第3回"),
 * so a look-alike letter cannot hide a number from the check.
 */
function isLetter(c: number): boolean {
  if (c < 0x80) return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
  if (c < 0xc0) return c === 0xaa || c === 0xba
  return (c <= 0x24f && c !== 0xd7 && c !== 0xf7) || (c >= 0x1e00 && c <= 0x1eff)
}

/** Combining marks. NFD text spells "é" as a letter plus a mark; the mark stays with the letter. */
function isMark(c: number): boolean {
  return (
    (c >= 0x300 && c <= 0x36f) || (c >= 0x1ab0 && c <= 0x1aff) || (c >= 0x1dc0 && c <= 0x1dff) ||
    (c >= 0x20d0 && c <= 0x20ff) || (c >= 0xfe20 && c <= 0xfe2f)
  )
}

function isAlnum(c: number): boolean {
  return isDigit(c) || isLetter(c)
}

function isSuper(c: number): boolean {
  return (
    c === 0xb2 || c === 0xb3 || c === 0xb9 ||
    (c >= 0x2070 && c <= 0x207f && c !== 0x2071) ||
    (c >= 0x2080 && c <= 0x208e)
  )
}

/**
 * First code point (the digit zero) of every decimal-digit block in the Basic
 * Multilingual Plane except ASCII and full-width. Sorted, for binary search.
 */
const DIGIT_ZEROS: readonly number[] = [
  0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6,
  0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0,
  0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0,
  0xaa50, 0xabf0,
]

/**
 * Decimal digits above the Basic Multilingual Plane as [first code point, how many], sorted. These are
 * not folded (a surrogate pair cannot become one code unit), so the scanner lists them as skipped.
 */
const ASTRAL_DIGITS: readonly (readonly [number, number])[] = [
  [0x104a0, 10], [0x10d30, 10], [0x10d40, 10], [0x11066, 10], [0x110f0, 10], [0x11136, 10], [0x111d0, 10], [0x112f0, 10],
  [0x11450, 10], [0x114d0, 10], [0x11650, 10], [0x116c0, 10], [0x116d0, 20], [0x11730, 10], [0x118e0, 10], [0x11950, 10],
  [0x11bf0, 10], [0x11c50, 10], [0x11d50, 10], [0x11da0, 10], [0x11de0, 10], [0x11f50, 10], [0x16130, 10], [0x16a60, 10],
  [0x16ac0, 10], [0x16b50, 10], [0x16d70, 10], [0x1ccf0, 10], [0x1d7ce, 50], [0x1e140, 10], [0x1e2f0, 10], [0x1e4f0, 10],
  [0x1e5f1, 10], [0x1e950, 10], [0x1fbf0, 10],
]

/** True when the code point is a decimal digit outside the Basic Multilingual Plane. */
function isAstralDigit(cp: number): boolean {
  let lo = 0
  let hi = ASTRAL_DIGITS.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const block = ASTRAL_DIGITS[mid]
    if (block === undefined) return false
    if (cp < block[0]) hi = mid - 1
    else if (cp >= block[0] + block[1]) lo = mid + 1
    else return true
  }
  return false
}

/** The value 0 to 9 of a non-ASCII decimal digit, or -1. */
function foreignDigit(c: number): number {
  let lo = 0
  let hi = DIGIT_ZEROS.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((DIGIT_ZEROS[mid] ?? 0) <= c) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (found < 0) return -1
  const d = c - (DIGIT_ZEROS[found] ?? 0)
  return d <= 9 ? d : -1
}

/**
 * Fold code units the way NFKC would for the characters that matter here, one
 * unit to one unit so offsets stay valid in the original text: full-width
 * ASCII, the ideographic space, the decimal digits of every script in the
 * Basic Multilingual Plane (Arabic-Indic, Devanagari, Thai and the rest), the
 * Arabic separators, the minus sign and non-breaking hyphens.
 */
function fold(text: string): Uint16Array {
  const n = text.length
  const f = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    let c = text.charCodeAt(i)
    if (c >= 0x80) {
      if (c >= 0xff01 && c <= 0xff5e) c -= 0xfee0
      else if (c === 0x3000) c = 0x20
      else if (c === 0x2044 || c === 0x2215) c = 0x2f // fraction slash and division slash: a slash
      else if (c === 0x066b) c = 0x2e
      else if (c === 0x066c) c = 0x2c
      else if (c === 0x066a) c = 0x25
      else if (c === 0x2212 || c === 0x2010 || c === 0x2011) c = 0x2d
      else if (c === 0xb5) c = 0x3bc // micro sign: the Greek letter mu, as in unit prefixes
      else if (c === 0x212a) c = 0x4b // Kelvin sign: canonically K
      else if (c === 0x212b) c = 0xc5 // Angstrom sign: canonically \u00c5
      else if (c === 0xffe5) c = 0xa5
      else if (c === 0xffe1) c = 0xa3
      else if (c === 0xffe6) c = 0x20a9
      else if (c >= 0x0660) {
        const d = foreignDigit(c)
        if (d >= 0) c = 0x30 + d
      }
    }
    f[i] = c
  }
  return f
}

function decimalString(neg: boolean, int: string, frac: string, exp10: number): string {
  let digits = int + frac
  let pointAt = int.length + exp10
  if (pointAt < 0) {
    digits = '0'.repeat(-pointAt) + digits
    pointAt = 0
  }
  if (pointAt >= digits.length) {
    digits += '0'.repeat(pointAt - digits.length)
    pointAt = digits.length
  }
  let a = 0
  while (a < pointAt - 1 && digits.charCodeAt(a) === 0x30) a++
  let ip = digits.slice(a, pointAt)
  const fp = digits.slice(pointAt)
  if (ip === '') ip = '0'
  let zero = true
  for (let k = 0; k < digits.length; k++) {
    if (digits.charCodeAt(k) !== 0x30) {
      zero = false
      break
    }
  }
  return `${neg && !zero ? '-' : ''}${ip}${fp === '' ? '' : `.${fp}`}`
}

function makeToken(raw: string, start: number, end: number, value: string, scale: number, kind: NumberKind): Tok {
  return noProto({ raw, start, end, value, scale, kind, ambiguous: false })
}

/** A whole hour from 1 to 12 written as a plain integer, or -1. */
function plainHour(t: Tok): number {
  if (t.kind !== 'count' || t.scale !== 0 || t.magnitude !== undefined || t.signStyle !== undefined || t.parenthesized === true) return -1
  if (t.ambiguous && t.ambiguity !== 'superscript') return -1
  if (t.value.length > 2) return -1
  for (let k = 0; k < t.value.length; k++) {
    const c = t.value.charCodeAt(k)
    if (c < 0x30 || c > 0x39) return -1
  }
  const h = Number(t.value)
  return h >= 1 && h <= 12 ? h : -1
}

/**
 * An hour with am or pm ("5pm", "5 PM", the 5 in "5-6pm") is a time of day: its value is the minutes since
 * midnight. A range takes its meridiem from its end, and the start moves to the other half of the day when it
 * would otherwise come after the end ("9-5pm" is 9 am to 5 pm, "11-1pm" is 11 am to 1 pm).
 */
function readClockHours(tokens: Tok[]): void {
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]
    if (t === undefined || (t.unit !== 'am' && t.unit !== 'pm')) continue
    const h = plainHour(t)
    if (h < 0) continue
    let unit: 'am' | 'pm' = t.unit
    const last = t.raw.charCodeAt(t.raw.length - 1)
    const inherited = t.range === 'start' && last >= 0x30 && last <= 0x39
    if (inherited) {
      const next = tokens[k + 1]
      if (next !== undefined && next.range === 'end') {
        const endHour = next.kind === 'time' ? Math.floor(Number(next.value) / 60) % 12 : plainHour(next) % 12
        if (endHour >= 0 && h % 12 > endHour) unit = unit === 'pm' ? 'am' : 'pm'
      }
    }
    t.kind = 'time'
    t.unit = unit
    t.value = String((h % 12) * 60 + (unit === 'pm' ? 720 : 0))
  }
}

interface SubToken {
  /** Index of the first and last digit run (into parts) this token spans. */
  first: number
  last: number
  int: string
  frac: string
  ambiguity?: AmbiguityReason
  alt?: { int: string; frac: string }
}

type SkipKind = 'identifier' | 'unread-glued-form'

/** A stretch of text the scanner passed over although it holds digits. */
export interface SkipRecord {
  readonly start: number
  readonly end: number
  readonly reason: SkipKind
}

interface Suffix {
  end: number
  percent?: '%' | 'pp'
  currency?: string
  unit?: string
  exp10: number
  ordinal: boolean
  superscript: boolean
  /** The single-letter magnitude (K, M, B, T) with nothing to say it is money. */
  looseMagnitude: boolean
  /** The text glued to the number is an identifier or an unread form; resume scanning here. */
  skipTo: number
  /** Why it is skipped, when `skipTo` is set. */
  skipReason: SkipKind
  /** An exponent too large to expand ("1e999"). */
  tooLong: boolean
  /** The scale came from scientific notation, which belongs to this number alone. */
  scientific: boolean
  /** A magnitude word follows that the kit cannot value ("2 Billionen", "5 Cr"). */
  unreadMagnitude: boolean
  /** The currency came from the word "dollar" or "dollars", which names no particular dollar. */
  dollarWord: boolean
}

/** Extract the numbers from a text. Linear time; never throws on odd characters. */
export function extractNumbers(text: string, options?: ExtractOptions): NumberToken[] {
  if (typeof text !== 'string') throw new TypeError(`extractNumbers: text must be a string, got ${typeof text}.`)
  const opts = readOptions(options, ['locale', 'parenthesesAreNegative'] as const, 'extractNumbers')
  const info = resolveLocale(opts.locale)
  const parenNeg = readBoolean(opts.parenthesesAreNegative, 'parenthesesAreNegative', true)
  return scan(text, info, parenNeg)
}

/**
 * Internal entry used by traceNumbers with already-validated options. With
 * `identifiers` set (evidence only), the digits inside skipped identifiers such
 * as `FY2025` come back as tokens flagged `identifier`, which can only ever
 * make an output number `unknown`, never `traced`. With `skips` set, every
 * stretch that holds digits but was not read as a number is appended to it.
 */
/** Thrown by `scan` when the text holds more numbers than the caller allowed. */
export class NumberLimitError extends RangeError {}

export function scan(
  text: string,
  info: LocaleInfo,
  parenNeg: boolean,
  identifiers = false,
  skips: SkipRecord[] | null = null,
  maxTokens = Infinity,
): NumberToken[] {
  const n = text.length
  if (n > MAX_TEXT_LENGTH) {
    throw new RangeError(`Text has ${n} characters; the limit is ${MAX_TEXT_LENGTH}.`)
  }
  const f = fold(text)
  const out: Tok[] = []
  const idTokens: Tok[] = []
  const fractionChains: Tok[][] = []
  let fractionChain: Tok[] = []
  // What each number token was built from, so a magnitude found on one end of a range
  // can be applied to the others.
  const numInfo = new Map<Tok, { neg: boolean; int: string; frac: string; exp: number; loose: boolean; sci: boolean }>()
  interface Group {
    kind: 'range' | 'dimension'
    members: Tok[]
    percent?: string
    currency?: string
    unit?: string
    exp: number
    loose: boolean
    /** A member has a magnitude word the kit cannot value, so the others cannot be read either. */
    unread?: boolean
    /** The group's currency is only a bare `$` or `¥` so far: a code on another member may make it specific. */
    currencyBare?: 'dollar' | 'yen'
    /** Two members name currencies that cannot be the same ("$5-10 EUR"). */
    conflict?: boolean
  }
  // The currency symbols and words that name no particular currency ("$", "¥", "dollars"), by token.
  const bareCurrency = new Map<Tok, 'dollar' | 'yen'>()
  let rangeGroup: Group | null = null
  let dimensionGroup: Group | null = null
  let floor = 0
  let lastMonth: { start: number; end: number } | null = null
  const unreadDates = new Map<number, string>()
  let lastDateEnd = -1

  const at = (k: number): number => (k >= 0 && k < n ? (f[k] ?? -1) : -1)
  const runEnd = (k: number): number => {
    while (k < n && isDigit(f[k] ?? 0)) k++
    return k
  }
  const slice = (a: number, b: number): string => {
    // Folded digits as a string, in chunks so a huge run never hits an argument limit.
    if (b - a <= 24) {
      let small = ''
      for (let k = a; k < b; k++) small += String.fromCharCode(f[k] ?? 0)
      return small
    }
    const pieces: string[] = []
    for (let k = a; k < b; k += 4096) {
      pieces.push(String.fromCharCode.apply(null, Array.from(f.subarray(k, Math.min(b, k + 4096)))))
    }
    return pieces.join('')
  }
  const isGroupSep = (c: number): boolean =>
    isGroupSpace(c) || (info.apostrophe && (c === 0x27 || c === 0x2019)) || (c === 0x20 && info.decimal === 0x2c)
  const lastToken = (): Tok | undefined => out[out.length - 1]
  const lastPlain = (): Tok | undefined => {
    const t = lastToken()
    return t !== undefined && t.kind !== 'date-part' && t.kind !== 'time' ? t : undefined
  }

  const pushDate = (
    s: number,
    e: number,
    value: number,
    part: DatePart | undefined,
    groupRaw: string | undefined,
    ambiguity?: AmbiguityReason,
  ): Tok => {
    const t = makeToken(text.slice(s, e), s, e, String(value), 0, 'date-part')
    if (part !== undefined) t.part = part
    if (groupRaw !== undefined) t.groupRaw = groupRaw
    if (ambiguity !== undefined) {
      t.ambiguous = true
      t.ambiguity = ambiguity
    }
    out.push(t)
    floor = e
    return t
  }

  /**
   * A month name starting at s: an English name or abbreviation with a capital, a full name in the other
   * languages (any case), or one of their abbreviations followed by a dot. `end` excludes the dot, `next` includes it.
   */
  const monthWordAt = (s: number): { end: number; next: number; month: number } | null => {
    if (!isLetter(at(s))) return null
    let q = s
    while (q < n && q - s < 14 && (isLetter(at(q)) || (q > s && isMark(at(q))))) q++
    if (isLetter(at(q))) return null
    const word = slice(s, q).normalize('NFC').toLowerCase()
    let month = isUpper(at(s)) ? own(MONTHS, word) : undefined
    if (month === undefined && !(isUpper(at(s)) && MONTH_NAME_COLLISIONS.has(word) && !MONTH_TABLE_LANGUAGES.has(info.language))) {
      month = MONTH_NAMES.get(word)
    }
    if (month !== undefined) return { end: q, next: q, month }
    if (at(q) === 0x2e) {
      month = MONTH_ABBREVIATIONS.get(word)
      if (month !== undefined) return { end: q, next: q + 1, month }
    }
    return null
  }

  const monthWordBefore = (i: number): { start: number; end: number; month: number; fresh: boolean } | null => {
    let p = i - 1
    if (at(p) === 0x20 || at(p) === NBSP) p--
    // "marzo de 2026": the connector between a month and its year.
    if ((at(p) | 0x20) === 0x65 && (at(p - 1) | 0x20) === 0x64 && (at(p - 2) === 0x20 || at(p - 2) === NBSP)) p -= 3
    else if ((at(p) | 0x20) === 0x6c && (at(p - 1) | 0x20) === 0x65 && (at(p - 2) | 0x20) === 0x64 && (at(p - 3) === 0x20 || at(p - 3) === NBSP)) p -= 4
    if (at(p) === 0x2e) p--
    let q = p
    while (q >= 0 && p - q < 14 && (isLetter(at(q)) || isMark(at(q)))) q--
    const s = q + 1
    const e = p + 1
    if (e <= s) return null
    const reusing = lastMonth !== null && lastMonth.end === e && lastMonth.start === s
    if (!reusing && s < floor) return null
    if (q >= 0 && isLetter(at(q))) return null
    const w = monthWordAt(s)
    if (w === null || w.end !== e) return null
    return { start: s, end: e, month: w.month, fresh: !reusing }
  }

  /** The month name that ends right before e (a hyphen, say), or null. */
  const monthWordEndingAt = (e: number): { start: number; month: number } | null => {
    let q = e - 1
    while (q >= 0 && e - 1 - q < 14 && (isLetter(at(q)) || isMark(at(q)))) q--
    const s = q + 1
    if (s >= e || s < floor || (q >= 0 && isLetter(at(q)))) return null
    const w = monthWordAt(s)
    return w === null || w.end !== e ? null : { start: s, month: w.month }
  }

  const pushMonth = (s: number, e: number, month: number): Tok => {
    const t = pushDate(s, e, month, 'month', undefined)
    t.value = String(month)
    lastMonth = { start: s, end: e }
    return t
  }

  // A month-name date is several tokens; the ones written together are one date.
  const dateClusters: Tok[][] = []
  let dateCluster: Tok[] | null = null
  const openCluster = (tokens: Tok[]): void => {
    dateCluster = tokens
    dateClusters.push(tokens)
  }

  /** ISO dates, times of day and numeric D/M/Y dates. Returns the end index or -1. */
  const tryDate = (i: number, clockOnly: boolean): number => {
    // The tail of a longer slash chain ("1/2/3/45") is part of that chain, not a date of its own.
    if (at(i - 1) === 0x2f && isDigit(at(i - 2))) return -1
    const a = runEnd(i) - i
    if (a === 0 || a > 4) return -1
    const sep = at(i + a)
    // After the first number of a range ("6am to 6:30pm") only a time of day can still start here.
    if (clockOnly && sep !== 0x3a) return -1
    // 2026年3月4日, 3月4日, 2026년 3월 4일
    if ((a === 4 && (sep === 0x5e74 || sep === 0xb144)) || ((a === 1 || a === 2) && (sep === 0x6708 || sep === 0xc6d4))) {
      return tryEastAsianDate(i, a)
    }
    const num = (s: number, e: number): number => Number(slice(s, e))
    if (a === 4 && (sep === 0x2d || sep === 0x2f || sep === 0x2e)) {
      const r2 = i + 5
      const b1 = runEnd(r2) - r2
      if ((b1 === 1 || b1 === 2) && at(r2 + b1) === sep) {
        const r3 = r2 + b1 + 1
        const b2 = runEnd(r3) - r3
        const after = r3 + b2
        if ((b2 === 1 || b2 === 2) && !isDigit(at(after)) && !(at(after) === sep && isDigit(at(after + 1)))) {
          const m = num(r2, r2 + b1)
          const d = num(r3, after)
          if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            const raw = slice(i, after)
            pushDate(i, i + 4, num(i, i + 4), 'year', raw)
            pushDate(r2, r2 + b1, m, 'month', raw)
            const end = exponentEnd(after)
            pushDate(r3, end, d, 'day', raw, end > after ? 'superscript' : undefined)
            return end
          }
        }
      }
      return -1
    }
    if ((a === 1 || a === 2) && sep === 0x3a) {
      const r2 = i + a + 1
      const mLen = runEnd(r2) - r2
      // "9:30", "18:05", and the on-the-hour "18:0" some data sources print.
      if (mLen === 2 || (mLen === 1 && at(r2) === 0x30)) {
        const h = num(i, i + a)
        const mi = num(r2, r2 + mLen)
        let after = r2 + mLen
        let sec: number | null = null
        if (mLen === 2 && at(after) === 0x3a && runEnd(after + 1) - (after + 1) === 2) {
          sec = num(after + 1, after + 3)
          after += 3
        }
        if (!isDigit(at(after)) && h <= 24 && mi <= 59 && (sec === null || sec <= 60)) {
          const raw = slice(i, after)
          const mer = h >= 1 && h <= 12 ? meridiemAt(after) : null
          if (sec === null) {
            // One time of day: minutes since midnight. Without am or pm a 12-hour-looking time may be either.
            const stop = mer === null ? after : mer.end
            const end = exponentEnd(stop)
            let minutes = h * 60 + mi
            let alt: number | null = null
            if (mer !== null) {
              minutes = (h % 12) * 60 + mi + (mer.unit === 'pm' ? 720 : 0)
            } else if (h >= 1 && h <= 12 && !(a === 2 && at(i) === 0x30)) {
              alt = h === 12 ? mi : minutes + 720
            }
            const t = makeToken(slice(i, end), i, end, String(minutes), 0, 'time')
            if (mer !== null) t.unit = mer.unit
            if (end > stop) {
              t.ambiguous = true
              t.ambiguity = 'superscript'
            } else if (alt !== null) {
              t.ambiguous = true
              t.ambiguity = 'meridiem'
              t.alternates = [{ value: String(alt), scale: 0 }]
            }
            out.push(t)
            floor = end
            return end
          }
          // With seconds the parts stay separate; a meridiem moves the hour to the 24-hour clock.
          const stop = mer === null ? after : mer.end
          const end = exponentEnd(stop)
          const flag = end > stop ? ('superscript' as const) : undefined
          const hour = mer === null ? h : (h % 12) + (mer.unit === 'pm' ? 12 : 0)
          pushDate(i, i + a, hour, 'hour', raw)
          pushDate(r2, r2 + 2, mi, 'minute', raw)
          pushDate(r2 + 3, end, sec, 'second', raw, flag)
          return end
        }
      }
      return -1
    }
    if ((a === 1 || a === 2) && (sep === 0x2f || sep === 0x2e || sep === 0x2d)) {
      const r2 = i + a + 1
      const b1 = runEnd(r2) - r2
      if ((b1 === 1 || b1 === 2) && at(r2 + b1) === sep) {
        const r3 = r2 + b1 + 1
        const b2 = runEnd(r3) - r3
        const after = r3 + b2
        const yearOk = b2 === 4 || (b2 === 2 && sep === 0x2f)
        if (yearOk && !isDigit(at(after)) && !(at(after) === sep && isDigit(at(after + 1)))) {
          const p = num(i, i + a)
          const q = num(r2, r2 + b1)
          const y = num(r3, after)
          if (p > 12 && q > 12) return -1
          // Which number is the day. Structure decides when one value is above 12;
          // otherwise the locale does, and the date is flagged as ambiguous.
          const decisive = p > 12 || q > 12 || p === q
          const firstIsDay = p > 12 ? true : q > 12 ? false : info.order === 'DMY'
          const day = firstIsDay ? p : q
          const month = firstIsDay ? q : p
          if (day < 1 || day > 31 || month < 1 || month > 12) return -1
          const raw = slice(i, after)
          const reason = decisive ? undefined : 'date-order'
          pushDate(i, i + a, p, decisive ? (firstIsDay ? 'day' : 'month') : undefined, raw, reason)
          pushDate(r2, r2 + b1, q, decisive ? (firstIsDay ? 'month' : 'day') : undefined, raw, reason)
          const end = exponentEnd(after)
          pushDate(r3, end, y, 'year', raw, end > after ? 'superscript' : undefined)
          return end
        }
      }
    }
    return -1
  }

  /** Year, month and day written with the East Asian markers: 年月日 (Chinese, Japanese) and 년월일 (Korean). */
  const tryEastAsianDate = (i: number, a: number): number => {
    const isMark = (c: number, kind: 'year' | 'month' | 'day'): boolean =>
      kind === 'year' ? c === 0x5e74 || c === 0xb144 : kind === 'month' ? c === 0x6708 || c === 0xc6d4 : c === 0x65e5 || c === 0xc77c
    const found: { s: number; e: number; value: number; part: DatePart }[] = []
    let p = i
    if (a === 4) {
      found.push({ s: i, e: i + 5, value: Number(slice(i, i + 4)), part: 'year' })
      p = i + 5
      if (at(p) === 0x20) p++
    }
    const ma = runEnd(p) - p
    if ((ma === 1 || ma === 2) && isMark(at(p + ma), 'month')) {
      const month = Number(slice(p, p + ma))
      if (month >= 1 && month <= 12) {
        found.push({ s: p, e: p + ma + 1, value: month, part: 'month' })
        p += ma + 1
        if (at(p) === 0x20) p++
        const da = runEnd(p) - p
        if ((da === 1 || da === 2) && isMark(at(p + da), 'day')) {
          const day = Number(slice(p, p + da))
          if (day >= 1 && day <= 31) found.push({ s: p, e: p + da + 1, value: day, part: 'day' })
        }
      }
    }
    const last = found[found.length - 1]
    if (last === undefined) return -1
    const raw = text.slice(i, last.e)
    for (const part of found) pushDate(part.s, part.e, part.value, part.part, raw)
    return last.e
  }

  /** "8-Jun-2026" and "Jun-08-2026": a month name between hyphens, with the year last. Returns the end index or -1. */
  const tryHyphenMonthDate = (i: number, e0: number, v: number): number => {
    const yearAfter = (at0: number): { end: number; value: number } | null => {
      const ys = at0
      const ye = runEnd(ys)
      if (ye - ys !== 4 || isDigit(at(ye))) return null
      const value = Number(slice(ys, ye))
      return value >= 1000 && value <= 2999 ? { end: ye, value } : null
    }
    if (at(e0) !== 0x2d) return -1
    // 8-Jun-2026
    const w = monthWordAt(e0 + 1)
    if (w !== null && w.end === w.next && at(w.end) === 0x2d) {
      const y = yearAfter(w.end + 1)
      if (y !== null) {
        const raw = text.slice(i, y.end)
        pushDate(i, e0, v, 'day', raw)
        pushDate(e0 + 1, w.end, w.month, 'month', raw)
        const end = exponentEnd(y.end)
        pushDate(w.end + 1, end, y.value, 'year', raw, end > y.end ? 'superscript' : undefined)
        return end
      }
    }
    // Jun-08-2026
    if (at(i - 1) === 0x2d) {
      const m = monthWordEndingAt(i - 1)
      const y = m === null ? null : yearAfter(e0 + 1)
      if (m !== null && y !== null) {
        const raw = text.slice(m.start, y.end)
        pushDate(m.start, i - 1, m.month, 'month', raw)
        pushDate(i, e0, v, 'day', raw)
        const end = exponentEnd(y.end)
        pushDate(e0 + 1, end, y.value, 'year', raw, end > y.end ? 'superscript' : undefined)
        return end
      }
    }
    return -1
  }

  /** "October 10", "10 October", "Oct 10, 2026". Returns the end index or -1. */
  const tryMonthName = (i: number): number => {
    const e0 = runEnd(i)
    const a = e0 - i
    if (a === 0 || a > 4) return -1
    // A digit run that continues as 1,234 or 1.5 is a number, not a date part.
    if ((at(e0) === 0x2c || at(e0) === 0x2e) && isDigit(at(e0 + 1))) return -1
    const v = Number(slice(i, e0))
    if (a <= 2 && v >= 1 && v <= 31) {
      const h = tryHyphenMonthDate(i, e0, v)
      if (h >= 0) return h
    }
    // "Oct 5-7": the second day of a range inside one date.
    const lastOut = out[out.length - 1]
    if (
      lastOut !== undefined && lastOut.part === 'day' && lastDateEnd === lastOut.end && a <= 2 && v >= 1 && v <= 31 &&
      rangeGap(lastOut.end, i)
    ) {
      let e = e0
      const suf = ordinalSuffixAt(e)
      if (suf > 0) e += suf
      const end = exponentEnd(e)
      const day = pushDate(i, end, v, 'day', undefined, end > e ? 'superscript' : undefined)
      day.range = 'end'
      lastOut.range = 'start'
      if (dateCluster !== null && dateCluster[dateCluster.length - 1] === lastOut) dateCluster.push(day)
      lastDateEnd = end
      return end
    }
    const before = monthWordBefore(i)
    if (before !== null) {
      if (a <= 2 && v >= 1 && v <= 31) {
        if (before.fresh) openCluster([pushMonth(before.start, before.end, before.month)])
        let e = e0
        const suf = ordinalSuffixAt(e)
        if (suf > 0) e += suf
        const end = exponentEnd(e)
        dateCluster?.push(pushDate(i, end, v, 'day', undefined, end > e ? 'superscript' : undefined))
        lastDateEnd = end
        return end
      }
      if (a === 4) {
        if (before.fresh) openCluster([pushMonth(before.start, before.end, before.month)])
        const end = exponentEnd(e0)
        dateCluster?.push(pushDate(i, end, v, 'year', undefined, end > e0 ? 'superscript' : undefined))
        return end
      }
      return -1
    }
    if (a === 4 && v >= 1000 && v <= 2999 && lastDateEnd >= 0 && floor === lastDateEnd) {
      const gap = i - lastDateEnd
      if ((gap === 1 && (at(lastDateEnd) === 0x20 || at(lastDateEnd) === 0x2c)) ||
        (gap === 2 && at(lastDateEnd) === 0x2c && at(lastDateEnd + 1) === 0x20) ||
        (gap === 4 && at(lastDateEnd) === 0x20 && (at(lastDateEnd + 1) | 0x20) === 0x64 && (at(lastDateEnd + 2) | 0x20) === 0x65 && at(lastDateEnd + 3) === 0x20) ||
        (gap === 5 && at(lastDateEnd) === 0x20 && (at(lastDateEnd + 1) | 0x20) === 0x64 && (at(lastDateEnd + 2) | 0x20) === 0x65 && (at(lastDateEnd + 3) | 0x20) === 0x6c && at(lastDateEnd + 4) === 0x20)) {
        const end = exponentEnd(e0)
        dateCluster?.push(pushDate(i, end, v, 'year', undefined, end > e0 ? 'superscript' : undefined))
        return end
      }
    }
    if (a <= 2 && v >= 1 && v <= 31) {
      let e = e0
      const suf = ordinalSuffixAt(e)
      if (suf > 0) e += suf
      else if ((at(e) | 0x20) === 0x65 && (at(e + 1) | 0x20) === 0x72 && !isLetter(at(e + 2)) && !isDigit(at(e + 2))) e += 2 // 1er mars
      else if (at(e) === 0xba || at(e) === 0xb0) e += 1 // 1º de marzo
      let p = e
      if (at(p) === 0x2e) p++ // 5. März
      if (at(p) === 0x20) {
        p++
        // "5th of October", "5 de marzo", "5 di marzo"
        p += connectorLength(p)
        const w = monthWordAt(p)
        if (w !== null) {
          // "5-7 October": the first day of a range was read as a plain number before the month appeared.
          const first = out[out.length - 1]
          if (
            first !== undefined && first.kind === 'count' && first.unit === undefined && !first.ambiguous &&
            first.signStyle === undefined && rangeGap(first.end, i) &&
            Number(first.value) >= 1 && Number(first.value) <= 31
          ) {
            first.kind = 'date-part'
            first.part = 'day'
            first.range = 'start'
          }
          const end = exponentEnd(e)
          const day = pushDate(i, end, v, 'day', undefined, end > e ? 'superscript' : undefined)
          if (first?.part === 'day' && first.range === 'start') day.range = 'end'
          const monthTok = pushMonth(p, w.end, w.month)
          openCluster(first?.part === 'day' && first.range === 'start' ? [first, day, monthTok] : [day, monthTok])
          lastDateEnd = w.end
          return w.next
        }
      }
    }
    noteUnreadDate(i, e0, v)
    return -1
  }

  /** The length of "of ", "de " or "di " at p (the words between a day and a month), or 0. */
  const connectorLength = (p: number): number => {
    const a = at(p) | 0x20
    const b = at(p + 1) | 0x20
    if (at(p + 2) !== 0x20) return 0
    return (a === 0x6f && b === 0x66) || (a === 0x64 && (b === 0x65 || b === 0x69)) ? 3 : 0
  }

  /**
   * A worded date this locale has no month table for ("5 марта 2026"): the day and the year would be checked as
   * independent numbers, so a wrong day could trace to an unrelated "5". Both are marked, and become `unknown`
   * (`unread-date`) unless the same phrase is in the evidence.
   */
  const noteUnreadDate = (i: number, e0: number, v: number): void => {
    if (READ_DATE_LANGUAGES.has(info.language) || e0 - i > 2 || v < 1 || v > 31) return
    let p = e0
    if (at(p) === 0x2e) p++
    if (at(p) !== 0x20) return
    p++
    const ws = p
    while (p < n && p - ws < 16 && isWordLetter(at(p))) p++
    if (p - ws < 2 || isWordLetter(at(p))) return
    if (at(p) === 0x2e) p++
    if (at(p) !== 0x20) return
    p++
    const ye = runEnd(p)
    if (ye - p !== 4 || isLetter(at(ye)) || isDigit(at(ye))) return
    const year = Number(slice(p, ye))
    if (year < 1900 || year > 2100) return
    const raw = text.slice(i, ye)
    unreadDates.set(i, raw)
    unreadDates.set(p, raw)
  }

  const ordinalSuffixAt = (e: number): number => {
    const c1 = at(e) | 0x20
    const c2 = at(e + 1) | 0x20
    const ok =
      (c1 === 0x73 && c2 === 0x74) || (c1 === 0x6e && c2 === 0x64) ||
      (c1 === 0x72 && c2 === 0x64) || (c1 === 0x74 && c2 === 0x68)
    return ok && !isLetter(at(e + 2)) && !isDigit(at(e + 2)) ? 2 : 0
  }

  /** True when a number (optionally after one space or a sign) starts at k. */
  const startsNumber = (k: number): boolean => {
    let q = k
    if (at(q) === 0x20 || at(q) === NBSP) q++
    if (isSignCode(at(q))) q++
    // A leading decimal (".99") starts a number too.
    return isDigit(at(q)) || ((at(q) === 0x2e || at(q) === 0x2c) && isDigit(at(q + 1)))
  }

  /** The folded letters at p (a combining mark stays with its letter), up to max + 1 of them. */
  const readWord = (p: number, max: number): string => {
    let q = p
    while (q < n && q - p <= max && (isLetter(at(q)) || (q > p && isMark(at(q))) || (q === p && at(q) === 0x3bc && isLetter(at(q + 1))))) q++
    return slice(p, q)
  }

  /** True when only a range separator ("-", "\u2013", " \u2013 ", " to ") lies between `end` and `start`. */
  const rangeGap = (end: number, start: number): boolean => {
    const gap = start - end
    const g0 = at(end)
    if (gap === 1) return g0 === 0x2d || g0 === 0x2013
    if (gap === 3) return g0 === 0x20 && at(end + 1) === 0x2013 && at(end + 2) === 0x20
    return gap === 4 && g0 === 0x20 && (at(end + 1) | 0x20) === 0x74 && (at(end + 2) | 0x20) === 0x6f && at(end + 3) === 0x20
  }

  /** True when "between " (any case, a space or no-break space) is written right before `pos`. */
  const betweenBefore = (pos: number): boolean => {
    const b = pos - 8
    if (b < 0) return false
    const word = 'between'
    for (let k = 0; k < 7; k++) if ((at(b + k) | 0x20) !== word.charCodeAt(k)) return false
    const sp = at(pos - 1)
    return (sp === 0x20 || sp === NBSP) && (b === 0 || !isLetter(at(b - 1)))
  }

  /** "between 10 and 12": the word "and" joins two numbers into a range when "between" opens it. */
  const betweenGap = (prev: Tok, start: number): boolean => {
    if (start - prev.end !== 5) return false
    const g = prev.end
    return (
      at(g) === 0x20 && (at(g + 1) | 0x20) === 0x61 && (at(g + 2) | 0x20) === 0x6e && (at(g + 3) | 0x20) === 0x64 && at(g + 4) === 0x20 &&
      betweenBefore(prev.start)
    )
  }

  /**
   * The previous number when only an x, X or \u00d7 (and spaces) separates it from `pos`:
   * "3 x 4", "3x4", "2 \u00d7 4".
   */
  const operatorBefore = (pos: number): Tok | undefined => {
    let j = pos - 1
    for (let guard = 0; guard < 8 && (at(j) === 0x20 || at(j) === NBSP); guard++) j--
    const c = at(j)
    if (c !== 0x78 && c !== 0x58 && c !== 0xd7) return undefined
    j--
    for (let guard = 0; guard < 8 && (at(j) === 0x20 || at(j) === NBSP); guard++) j--
    const prev = lastPlain()
    return prev !== undefined && prev.end === j + 1 ? prev : undefined
  }

  /** True when the character at k is a Latin letter, or a mark on one. */
  const letterAt = (k: number): boolean => {
    let j = k
    while (j >= 0 && isMark(at(j))) j--
    return j >= 0 && isLetter(at(j))
  }

  /** Evidence only: keep the digit runs of a skipped identifier as weak tokens. */
  const noteIdentifier = (a: number, b: number): void => {
    if (!identifiers) return
    let k = a
    while (k < b) {
      if (!isDigit(at(k))) {
        k++
        continue
      }
      const e = runEnd(k)
      const t = makeToken(text.slice(k, e), k, e, decimalString(false, slice(k, e), '', 0), 0, 'count')
      t.ambiguous = true
      t.ambiguity = e - k > MAX_DIGITS ? 'too-long' : 'identifier'
      idTokens.push(t)
      k = e
    }
  }

  /** Where the last recorded skip ended, so two skips never overlap. */
  let skipFloor = 0
  /** Pass over [a, b): keep its digits as weak evidence and, if asked, record it as skipped. */
  const skip = (a: number, b: number, reason: SkipKind): void => {
    noteIdentifier(a, b)
    if (skips === null) return
    const from = Math.max(a, skipFloor)
    if (b <= from) return
    skips.push({ start: from, end: b, reason })
    skipFloor = b
  }

  /** The start of the alphanumeric word that ends at `pos` (the letters glued before a number). */
  const wordStart = (pos: number): number => {
    const lim = Math.max(floor, skipFloor, pos - 80)
    let q = pos
    while (q > lim) {
      const c = at(q - 1)
      if (isAlnum(c) || c === 0x5f || isMark(c)) q--
      else if (c === 0x2d && q - 2 >= lim && letterAt(q - 2)) q--
      else break
    }
    return q
  }

  const skipIdentifier = (from: number): number => {
    let j = from
    while (j < n) {
      const ch = at(j)
      if (isAlnum(ch) || ch === 0x5f || isMark(ch)) j++
      else if (ch === 0x2e && isAlnum(at(j + 1))) j++
      else break
    }
    return j
  }

  /**
   * The end of a superscript or inline exponent ("5\u00b2", "5^-2") starting at `e`, or `e` itself.
   * A date part followed by one is flagged, not read as a clean part.
   */
  const exponentEnd = (e: number): number => {
    if (isSuper(at(e))) {
      let j = e
      while (isSuper(at(j))) j++
      return j
    }
    if (at(e) === 0x5e && (isDigit(at(e + 1)) || (isSignCode(at(e + 1)) && isDigit(at(e + 2))))) {
      let j = e + 2
      while (isDigit(at(j))) j++
      return j
    }
    return e
  }

  /**
   * If the number at `pos` sits in a hyphenated model-style name (Llama-3.3-70B-Instruct,
   * gpt-5.4-nano-2026-03-17, Qwen3-8B), the end of that name; otherwise -1. A name has
   * letters before its first number and letters after it (gpt-4 and pre-2020 stay numbers),
   * or starts with a letter-and-digit word and has a later word with letters (Qwen3-8B).
   */
  let hyphenStart = 0
  const hyphenIdentifierEnd = (pos: number): number => {
    const wordChar = (c: number): boolean => isLetter(c) || isDigit(c) || isMark(c) || c === 0x2e || c === 0x5f || c === 0x2d
    let s0 = pos
    while (s0 > 0 && pos - s0 < 80 && wordChar(at(s0 - 1))) s0--
    let e0 = pos
    while (e0 < n && e0 - pos < 80 && wordChar(at(e0))) e0++
    if ((s0 > 0 && wordChar(at(s0 - 1))) || (e0 < n && wordChar(at(e0)))) return -1
    while (e0 > pos && (at(e0 - 1) === 0x2e || at(e0 - 1) === 0x2d)) e0--
    // Split on hyphens and note which words have letters and which have digits.
    const letters: boolean[] = []
    const digits: boolean[] = []
    let hasL = false
    let hasD = false
    let firstMixedLetterStart = false
    let wordStart = s0
    for (let k = s0; k <= e0; k++) {
      if (k === e0 || at(k) === 0x2d) {
        letters.push(hasL)
        digits.push(hasD)
        if (letters.length === 1) firstMixedLetterStart = hasL && hasD && isLetter(at(wordStart))
        hasL = false
        hasD = false
        wordStart = k + 1
      } else if (isLetter(at(k))) hasL = true
      else if (isDigit(at(k))) hasD = true
    }
    if (letters.length < 2) return -1
    const firstDigit = digits.indexOf(true)
    if (firstDigit < 0) return -1
    const laterLetters = letters.slice(firstDigit + 1).includes(true)
    const earlierLetters = letters.slice(0, firstDigit).includes(true)
    if ((firstDigit >= 1 && earlierLetters && laterLetters) || (firstMixedLetterStart && letters.slice(1).includes(true))) {
      hyphenStart = s0
      return e0
    }
    return -1
  }

  /**
   * True when the digits at `pos` are followed by a hyphen and a unit, percent or currency word
   * ("first-100-days", "year-over-year-12-percent"): a quantity written in kebab case, not a name.
   */
  const hyphenQuantityAt = (pos: number): boolean => {
    let e = runEnd(pos)
    if (at(e) === 0x2e && isDigit(at(e + 1))) e = runEnd(e + 1)
    if (at(e) !== 0x2d || !isLetter(at(e + 1))) return false
    const w = readWord(e + 1, 12)
    const after = at(e + 1 + w.length)
    if (w.length > 12 || isLetter(after) || isDigit(after)) return false
    return hyphenWord(w.toLowerCase()) !== undefined
  }

  /** After a version core: "+build.5", "-rc.1", "-beta.2+exp.sha" are all part of the identifier. */
  const skipVersionTail = (from: number): number => {
    let j = from
    while ((at(j) === 0x2b || at(j) === 0x2d) && isAlnum(at(j + 1))) j = skipIdentifier(j + 1)
    return j
  }

  /** True when the underscore at `u` belongs to a name (`foo_12`, `x86_64`), not to markup around a number (`_12_`). */
  const underscoreGlues = (u: number): boolean => {
    let q = u
    while (q > floor && at(q - 1) === 0x5f) q--
    return q - 1 >= floor && (isAlnum(at(q - 1)) || isMark(at(q - 1)))
  }

  /**
   * Why [wStart, j) is skipped. A currency written as a letter prefix ("Rs1,500", "kr9999") is
   * a quantity the kit cannot read; every other letter prefix is an identifier.
   */
  const prefixedFormReason = (wStart: number, i0: number, j: number): SkipKind => {
    const prefix = slice(wStart, i0)
    if (!CURRENCY_PREFIX_WORDS.has(prefix)) return 'identifier'
    let marks = false
    for (let k = i0; k < j; k++) {
      const ch = at(k)
      if (ch === 0x2c || ch === 0x2e) marks = true
      else if (!isDigit(ch)) return 'identifier'
    }
    return prefix.length >= 2 || marks || j - i0 >= 3 ? 'unread-glued-form' : 'identifier'
  }

  const matchCurrencyEnding = (pos: number): CurrencyMatch | null => {
    const found = matchCurrencyEndingRaw(pos)
    return found === null ? null : noProto(found)
  }

  const matchCurrencyEndingRaw = (pos: number): CurrencyMatch | null => {
    let p = pos - 1
    if (p >= floor && (at(p) === 0x20 || at(p) === NBSP)) p--
    if (p < floor) return null
    const c = at(p)
    const symbol = CURRENCY_SYMBOLS.get(c)
    if (symbol !== undefined) {
      if (c === 0x24) {
        // US$, CA$, C$, CAD$, NT$, Mex$: up to three letters glued before the dollar sign say which dollar.
        let q = p
        while (q - 1 >= floor && p - q < 3 && isLetter(at(q - 1))) q--
        if (q < p && !(q - 1 >= floor && isLetter(at(q - 1)))) {
          const letters = slice(q, p)
          const code = own(DOLLAR_PREFIXES, letters)
          if (code !== undefined) return { start: q, code }
          // A three-letter code in any case ("EUR$500", "cad$500"): a dollar code makes the dollar specific, the rest contradict it.
          if (letters.length === 3) {
            const upper = letters.toUpperCase()
            if (CURRENCY_CODES.has(upper)) {
              return DOLLAR_CODES.has(upper) ? { start: q, code: upper } : { start: q, code: symbol, family: 'dollar', conflict: true }
            }
          }
        }
        // A code and a space before the sign ("CAD $500"): the code makes the dollar specific, or contradicts it.
        if (at(p - 1) === 0x20 && p - 4 >= floor && isUpper(at(p - 2)) && isUpper(at(p - 3)) && isUpper(at(p - 4)) && !isLetter(at(p - 5))) {
          const code = slice(p - 4, p - 1)
          if (CURRENCY_CODES.has(code)) {
            return DOLLAR_CODES.has(code) ? { start: p - 4, code } : { start: p - 4, code: symbol, family: 'dollar', conflict: true }
          }
        }
        return { start: p, code: symbol, family: 'dollar' }
      }
      return c === 0xa5 ? { start: p, code: symbol, family: 'yen' } : { start: p, code: symbol }
    }
    if (p - 2 >= floor && isUpper(c) && isUpper(at(p - 1)) && isUpper(at(p - 2)) && !isLetter(at(p - 3))) {
      const code = slice(p - 2, p + 1)
      if (CURRENCY_CODES.has(code)) return { start: p - 2, code }
    }
    return null
  }

  const isSignCode = (c: number): boolean => c === 0x2d || c === 0x2b

  /**
   * A temperature unit right after a number: `°C`, `° F`, `℃`, `degrees Celsius`, `deg F`. A degree sign
   * with no C or F after it is an angle or a bearing and is left alone.
   */
  const temperatureAt = (p0: number): { unit: string; end: number } | null => {
    let q = p0
    if (at(q) === 0x20 || at(q) === NBSP) q++
    const c = at(q)
    if (c === 0x2103) return { unit: '°C', end: q + 1 }
    if (c === 0x2109) return { unit: '°F', end: q + 1 }
    let r = -1
    if (c === 0xb0 || c === 0xba || c === 0x2da) {
      // "° C": one space may separate the sign from the letter.
      r = q + 1
      if (at(r) === 0x20 || at(r) === NBSP) r++
    } else if (isLetter(c)) {
      const w = readWord(q, 7).toLowerCase()
      if ((w === 'degrees' || w === 'degree' || w === 'deg') && (at(q + w.length) === 0x20 || at(q + w.length) === NBSP)) r = q + w.length + 1
    }
    if (r < 0) return null
    const letter = at(r) | 0x20
    if ((letter === 0x63 || letter === 0x66) && isLetter(at(r)) && !isLetter(at(r + 1)) && !isDigit(at(r + 1))) {
      return { unit: letter === 0x63 ? '°C' : '°F', end: r + 1 }
    }
    const w = readWord(r, 10).toLowerCase()
    const unit = w === 'celsius' || w === 'centigrade' ? '°C' : w === 'fahrenheit' ? '°F' : undefined
    if (unit !== undefined && !isLetter(at(r + w.length)) && !isDigit(at(r + w.length))) return { unit, end: r + w.length }
    return null
  }

  /**
   * A meridiem right after a number, in any case and with or without dots: `5pm`, `5 PM`, `9 a.m.`, `5 P.M.`.
   * A time of day is a number with a unit, so it cannot be confirmed by a unit-less number.
   */
  const meridiemAt = (p0: number): { unit: string; end: number } | null => {
    let q = p0
    if (at(q) === 0x20 || at(q) === NBSP) q++
    const first = at(q) | 0x20
    if (first !== 0x61 && first !== 0x70) return null
    const unit = first === 0x61 ? 'am' : 'pm'
    let r = q + 1
    if (at(r) === 0x2e) {
      if ((at(r + 1) | 0x20) !== 0x6d || at(r + 2) !== 0x2e) return null
      r += 3
    } else {
      if ((at(r) | 0x20) !== 0x6d) return null
      r++
    }
    if (isLetter(at(r)) || isDigit(at(r))) return null
    return { unit, end: r }
  }

  /** True when the folded text at `q` starts with `word` (BMP characters only). */
  const startsWithAt = (q: number, word: string): boolean => {
    for (let k = 0; k < word.length; k++) if (at(q + k) !== word.charCodeAt(k)) return false
    return true
  }

  /**
   * A magnitude word in another script right after a number, optionally after one space:
   * 万, 億, млн, लाख. `exp` is null for a word the kit cannot value.
   */
  const scriptMagnitudeAt = (p0: number): { end: number; exp: number | null } | null => {
    let q = p0
    if (at(q) === 0x20 || at(q) === NBSP) q++
    const c = at(q)
    if (c < 0x400) return null
    const cjk = CJK_MAGNITUDE.get(c)
    if (cjk !== undefined) {
      for (const [word, exp] of cjk) if (startsWithAt(q, word)) return { end: q + word.length, exp }
      return null
    }
    const lo = c >= 0x900 && c <= 0x97f ? 0x900 : c >= 0x600 && c <= 0x6ff ? 0x600 : c >= 0x400 && c <= 0x52f ? 0x400 : -1
    if (lo < 0) return null
    const hi = lo === 0x900 ? 0x97f : lo === 0x600 ? 0x6ff : 0x52f
    let r = q
    while (r < n && r - q < 12 && at(r) >= lo && at(r) <= hi) r++
    const exp = RUN_MAGNITUDE.get(slice(q, r).toLowerCase())
    return exp === undefined ? null : { end: r, exp }
  }

  /** "m2", "ft\u00b2", "km3": a length unit squared or cubed. Returns the unit and where it ends, or null. */
  const powerUnitAt = (w: string, we: number): { unit: string; end: number } | null => {
    if (!POWER_BASES.has(w)) return null
    const c = at(we)
    const power = c === 0xb2 || c === 0x32 ? '2' : c === 0xb3 || c === 0x33 ? '3' : ''
    if (power === '') return null
    const next = at(we + 1)
    if (isDigit(next) || isLetter(next)) return null
    return { unit: w + power, end: we + 1 }
  }

  /** The four digits before e are a decade year (1900 to 2090, ending in 0): "the 1990s". */
  const decadeBefore = (e: number): boolean => {
    if (!isDigit(at(e - 1)) || !isDigit(at(e - 4)) || isDigit(at(e - 5)) || at(e - 5) === 0x2e || at(e - 5) === 0x2c) return false
    const year = Number(slice(e - 4, e))
    return year >= 1900 && year <= 2090 && year % 10 === 0
  }

  const readSuffix = (e: number, hasCurrency: boolean, isInteger: boolean, isZero: boolean, resolution: boolean): Suffix => {
    const sfx: Suffix = noProto({
      end: e, exp10: 0, ordinal: false, superscript: false, looseMagnitude: false, skipTo: -1, skipReason: 'identifier', tooLong: false, scientific: false, unreadMagnitude: false, dollarWord: false,
    })
    let p = e
    if (at(p) === 0x5f) {
      let q = p
      while (at(q) === 0x5f) q++
      if (isAlnum(at(q)) || isMark(at(q))) {
        // 12_000, 5_foo: the number is part of a name.
        sfx.skipTo = skipIdentifier(p)
        return sfx
      }
      // Underscores and then a boundary ("_12.5_", "1766____") are markup or filler, not part of the number.
      return sfx
    }
    if (isSuper(at(p))) {
      while (isSuper(at(p))) p++
      sfx.superscript = true
      sfx.end = p
      return sfx
    }
    if (at(p) === 0x5e && (isDigit(at(p + 1)) || (isSignCode(at(p + 1)) && isDigit(at(p + 2))))) {
      // 10^6: an exponent written inline. Not expanded, so not guessed.
      p += 2
      while (isDigit(at(p))) p++
      sfx.superscript = true
      sfx.end = p
      return sfx
    }
    if (at(p) === 0xa2) {
      // 1.9\u00a2: cents.
      sfx.unit = 'c'
      sfx.end = p + 1
      return sfx
    }
    let scientific = false
    if ((at(p) | 0x20) === 0x65) {
      // Scientific notation: 1.5e3, 2E-4. The whole exponent is consumed, however long,
      // and then a percent sign, currency or unit may still follow.
      let q = p + 1
      const negative = at(q) === 0x2d
      if (negative || at(q) === 0x2b) q++
      const digitsStart = q
      while (isDigit(at(q))) q++
      if (q > digitsStart && at(q) !== 0x5f) {
        let z = digitsStart
        while (z < q - 1 && at(z) === 0x30) z++
        if (q - z > 2 || Number(slice(z, q)) > 30) sfx.tooLong = true
        else sfx.exp10 = negative ? -Number(slice(z, q)) : Number(slice(z, q))
        sfx.end = q
        p = q
        scientific = true
        sfx.scientific = true
      }
    }
    if (at(p) === 0x25) {
      sfx.percent = '%'
      sfx.end = p + 1
      return sfx
    }
    if ((at(p) === 0x20 || at(p) === NBSP) && at(p + 1) === 0x25) {
      sfx.percent = '%'
      sfx.end = p + 2
      return sfx
    }
    const degrees = temperatureAt(p)
    if (degrees !== null) {
      sfx.unit = degrees.unit
      sfx.end = degrees.end
      return sfx
    }
    const meridiem = meridiemAt(p)
    if (meridiem !== null) {
      sfx.unit = meridiem.unit
      sfx.end = meridiem.end
      return sfx
    }
    let magnitudeRead = false
    // A dot after a magnitude abbreviation ("3,5 Mio. €") belongs to it when a currency or unit follows.
    let magAbbreviation = false
    const script = scientific ? null : scriptMagnitudeAt(p)
    if (script !== null) {
      if (script.exp === null) sfx.unreadMagnitude = true
      else sfx.exp10 = script.exp
      p = script.end
      // 350万円: the currency word that closes the magnitude.
      if (at(p) === 0x5186) {
        sfx.currency = 'JPY'
        p++
      } else if (at(p) === 0x5143) {
        sfx.currency = 'CNY'
        p++
      }
      magnitudeRead = true
    } else if (isLetter(at(p)) || (at(p) === 0x3bc && isLetter(at(p + 1)))) {
      const w = readWord(p, 16)
      const we = p + w.length
      if ((w === 'x' || w === 'X') && (isDigit(at(we)) || (at(we) === 0x2e && isDigit(at(we + 1)))) && !isZero) {
        // 3x4: a multiplication sign, so the 3 has no suffix.
        return sfx
      }
      const power = powerUnitAt(w, we)
      if (power !== null) {
        sfx.unit = power.unit
        sfx.end = power.end
        return sfx
      }
      if (w.length > 16 || isDigit(at(we)) || isLetter(at(we))) {
        sfx.skipTo = skipIdentifier(we)
        return sfx
      }
      if (w === 's' && isInteger && !isLetter(at(we)) && decadeBefore(e)) {
        // "the 1990s": a decade, not seconds.
        sfx.unit = 'decade'
        sfx.end = we
        return sfx
      }
      const lower = w.toLowerCase()
      const single = !scientific && (w === 'K' || w === 'k' || w === 'M' || w === 'B' || w === 'T')
      const singleLower = !scientific && hasCurrency && (w === 'm' || w === 'b' || w === 't')
      const mag = scientific || single || singleLower ? undefined : magnitudeOf(w, hasCurrency, info.language, false)
      if (single || singleLower) {
        sfx.exp10 = letterExp(w)
        sfx.looseMagnitude = !hasCurrency
        p = we
        magnitudeRead = true
      } else if (mag !== undefined) {
        if (mag === null) sfx.unreadMagnitude = true
        else {
          sfx.exp10 = mag.exp
          sfx.looseMagnitude = mag.loose
        }
        magAbbreviation = MAGNITUDE_ABBREVIATIONS.has(lower)
        p = we
        magnitudeRead = true
      } else if (isInteger && !scientific && (lower === 'st' || lower === 'nd' || lower === 'rd' || lower === 'th')) {
        sfx.ordinal = true
        sfx.end = we
        return sfx
      } else if (own(POINT_WORDS, lower) !== undefined) {
        sfx.percent = 'pp'
        sfx.end = we
        return sfx
      } else if (own(PERCENT_WORDS, lower) !== undefined) {
        sfx.percent = '%'
        sfx.end = we
        return sfx
      } else if (w.length === 3 && CURRENCY_CODES.has(w)) {
        sfx.currency = w
        sfx.end = we
        return sfx
      } else {
        const unit = glueUnit(w)
        if (unit === undefined) {
          // A micro sign with no known unit is a boundary. Any other unknown word is an identifier
          // when it is a known code shape ("3D", "5G"), and otherwise a form the kit cannot read.
          if (w.charCodeAt(0) !== 0x3bc) {
            sfx.skipTo = skipIdentifier(we)
            const code = IDENT_SUFFIXES.has(w) || ((w === 'p' || w === 'i') && resolution)
            sfx.skipReason = code ? 'identifier' : 'unread-glued-form'
          }
          return sfx
        }
        sfx.unit = unit
        sfx.end = we
        return sfx
      }
    }
    // Spaced words: "1.2 million", "5 percent", "30 days", "4 dollars".
    const readSpaced = (from: number): number => {
      // Reads one recognized word starting after one space at `from`; returns its end or -1.
      if (at(from) === 0x25) {
        sfx.percent = '%'
        return from + 1
      }
      if (at(from) !== 0x20 && at(from) !== NBSP) return -1
      const s = from + 1
      if (!(isLetter(at(s)) || (at(s) === 0x3bc && isLetter(at(s + 1))))) {
        if (at(s) === 0x25) {
          sfx.percent = '%'
          return s + 1
        }
        const sym = CURRENCY_SYMBOLS.get(at(s))
        // "5 $6" is a 5 and a $6, not "5 dollars" followed by a bare 6.
        if (sym !== undefined && !startsNumber(s + 1)) {
          sfx.currency = sym
          return s + 1
        }
        return -1
      }
      const w = readWord(s, 20)
      if (w.length > 20) return -1
      const we = s + w.length
      const power = powerUnitAt(w, we)
      if (power !== null) {
        sfx.unit = power.unit
        return power.end
      }
      if (isDigit(at(we))) return -1
      const lower = w.toLowerCase()
      if (!scientific) {
        // "$5 M": a lone magnitude letter after a currency amount, when nothing but a boundary follows it.
        const letter = hasCurrency && w.length === 1 ? letterExp(w) : -1
        const boundary = letter >= 0 && (we >= n || at(we) === 0x20 || at(we) === NBSP || at(we) === 0x29 || at(we) === 0x2c || at(we) === 0x2e || at(we) === 0x3b || at(we) === 0x3a || at(we) === 0x21 || at(we) === 0x3f)
        const mag = boundary ? { exp: letter, loose: false } : magnitudeOf(w, hasCurrency, info.language, true)
        if (mag !== undefined) {
          // Two magnitude words in a row multiply ("1 hundred thousand", "3 lakh crore"): not read.
          if (magnitudeRead || mag === null) sfx.unreadMagnitude = true
          else sfx.exp10 = mag.exp
          if (magnitudeRead) return we
          magnitudeRead = true
          let next = -1
          if (at(we) === 0x2e && MAGNITUDE_ABBREVIATIONS.has(lower)) next = readSpaced(we + 1)
          if (next < 0) next = readSpaced(we)
          return next < 0 ? we : next
        }
      }
      if (own(PERCENT_WORDS, lower) !== undefined) {
        sfx.percent = '%'
        return we
      }
      const second = own(PERCENT_PHRASES, lower)
      if (second !== undefined && at(we) === 0x20) {
        const w2 = readWord(we + 1, 6).toLowerCase()
        if (second.includes(w2)) {
          sfx.percent = '%'
          return we + 1 + w2.length
        }
      }
      if (lower === 'percentage') {
        const w2 = readWord(we + 1, 8).toLowerCase()
        if (at(we) === 0x20 && (w2 === 'point' || w2 === 'points')) {
          sfx.percent = 'pp'
          return we + 1 + w2.length
        }
        return -1
      }
      if (own(POINT_WORDS, lower) !== undefined) {
        sfx.percent = 'pp'
        return we
      }
      if (w.length === 3 && CURRENCY_CODES.has(w)) {
        sfx.currency = w
        return we
      }
      const dollarCode = own(DOLLAR_ADJECTIVES, lower)
      if (dollarCode !== undefined && at(we) === 0x20) {
        const w2 = readWord(we + 1, 8).toLowerCase()
        const e2 = we + 1 + w2.length
        if ((w2 === 'dollar' || w2 === 'dollars') && !isLetter(at(e2)) && !isDigit(at(e2))) {
          sfx.currency = dollarCode
          return e2
        }
      }
      const currency = own(CURRENCY_WORDS, lower)
      if (currency !== undefined && (lower.length > 3 || w === w.toUpperCase() || lower === w)) {
        sfx.currency = currency
        sfx.dollarWord = lower === 'dollar' || lower === 'dollars'
        return we
      }
      if ((w === 'x' || w === 'X') && startsNumber(we)) return -1
      // A lone "c" after a space is a label (option c), not cents; "12 cents" is in the spaced table.
      const unit = spacedUnit(w) ?? (w === 'c' ? undefined : own(GLUED_UNITS, w))
      if (unit !== undefined) {
        sfx.unit = unit
        return we
      }
      return -1
    }
    if (magnitudeRead) {
      let next = -1
      if (magAbbreviation && at(p) === 0x2e) next = readSpaced(p + 1)
      if (next < 0) next = readSpaced(p)
      if (next >= 0) p = next
      sfx.end = p
      if (sfx.currency !== undefined || sfx.percent !== undefined) sfx.looseMagnitude = false
      return sfx
    }
    if (at(p) === 0x2d && isLetter(at(p + 1))) {
      const w = readWord(p + 1, 12)
      const word = hyphenWord(w)
      if (word !== undefined && w.length <= 12 && !isLetter(at(p + 1 + w.length)) && !isDigit(at(p + 1 + w.length))) {
        if (word.unit !== undefined) sfx.unit = word.unit
        if (word.percent !== undefined) sfx.percent = word.percent
        if (word.currency !== undefined) sfx.currency = word.currency
        sfx.end = p + 1 + w.length
      }
      return sfx
    }
    const sym = CURRENCY_SYMBOLS.get(at(p))
    if (sym !== undefined && at(p) !== 0x24 && !startsNumber(p + 1)) {
      sfx.currency = sym
      sfx.end = p + 1
      return sfx
    }
    const spacedEnd = readSpaced(p)
    if (spacedEnd >= 0) {
      sfx.end = spacedEnd
      if (sfx.exp10 !== 0 && sfx.currency === undefined && sfx.percent === undefined) {
        sfx.looseMagnitude = false
      }
    }
    return sfx
  }

  /** Interpret one digit-and-separator chain as numbers. */
  const interpretChain = (
    parts: number[],
    seps: number[],
  ): { tokens: SubToken[]; skippedRest: boolean; restStart: number } => {
    const tokens: SubToken[] = []
    const count = parts.length / 2
    const partStart = (k: number): number => parts[2 * k] ?? 0
    const partEnd = (k: number): number => parts[2 * k + 1] ?? 0
    const partLen = (k: number): number => partEnd(k) - partStart(k)
    const D = info.decimal
    // For Indian grouping: the first index at or after q that is not a two-digit group
    // joined by a comma. Built once per chain so a long run of pairs is not rescanned.
    let nextNonPair: Int32Array | null = null
    const pairRunEnd = (q: number): number => {
      if (nextNonPair === null) {
        const table = new Int32Array(count + 1)
        table[count] = count
        for (let i = count - 1; i >= 0; i--) {
          const isPair = i >= 1 && partLen(i) === 2 && seps[i - 1] === 0x2c
          table[i] = isPair ? (table[i + 1] ?? count) : i
        }
        nextNonPair = table
      }
      return nextNonPair[q] ?? count
    }
    let k = 0
    while (k < count) {
      const firstLen = partLen(k)
      const groupable = firstLen <= 3 && at(partStart(k)) !== 0x30
      const X = k + 1 < count ? (seps[k] ?? 0) : 0
      const groupSep = X === 0x2c || X === 0x2e || isGroupSep(X)
      let e1 = k
      if (groupable && groupSep) {
        let p = k + 1
        while (p < count && seps[p - 1] === X && partLen(p) === 3) p++
        e1 = p - 1
        if (info.indian && firstLen <= 2 && X === 0x2c) {
          // 12,34,567: pairs of digits, then a final group of three.
          const q = pairRunEnd(k + 1)
          if (q > k + 1 && q < count && seps[q - 1] === X && partLen(q) === 3 && q > e1) e1 = q
        }
      }
      const groups = e1 - k
      let dec = -1
      if (e1 + 1 < count) {
        const s = seps[e1] ?? 0
        if ((s === 0x2c || s === 0x2e) && (groups === 0 || s !== X)) dec = e1 + 1
      }
      const first = k
      const last = dec >= 0 ? dec : e1
      let int = ''
      let frac = ''
      let ambiguity: AmbiguityReason | undefined
      let alt: { int: string; frac: string } | undefined
      for (let q = k; q <= e1; q++) int += slice(partStart(q), partEnd(q))
      if (dec >= 0) {
        // A dotted chain with a second dot after the decimal ("1.2.3", "192.168.1.1") is a
        // version or an address: an identifier, not a number.
        const decSep = seps[dec - 1] ?? 0
        if (decSep === 0x2e && dec + 1 < count && seps[dec] === 0x2e) {
          return { tokens, skippedRest: true, restStart: partStart(k) }
        }
        frac = slice(partStart(dec), partEnd(dec))
        if (groups === 0 && decSep !== D) ambiguity = 'separator'
      } else if (groups === 1 && (X === 0x2c || X === 0x2e) && X === D) {
        // "1.234" where the dot is the decimal mark: a decimal, but also a grouped integer.
        const second = slice(partStart(e1), partEnd(e1))
        const head = slice(partStart(k), partEnd(k))
        frac = second
        int = head
        alt = { int: head + second, frac: '' }
        ambiguity = 'separator'
      }
      tokens.push(noProto({
        first, last, int, frac,
        ...(ambiguity !== undefined ? { ambiguity } : {}),
        ...(alt !== undefined ? { alt: noProto(alt) } : {}),
      }))
      k = last + 1
    }
    return { tokens, skippedRest: false, restStart: -1 }
  }

  /** The end of a run of decimal digits above the BMP starting at k (surrogate pairs), or k. */
  const astralDigitsEnd = (k: number): number => {
    let q = k
    while (q + 1 < n) {
      const hi = f[q] ?? 0
      const lo = f[q + 1] ?? 0
      if (hi < 0xd800 || hi > 0xdbff || lo < 0xdc00 || lo > 0xdfff) break
      if (!isAstralDigit(((hi - 0xd800) << 10) + (lo - 0xdc00) + 0x10000)) break
      q += 2
    }
    return q
  }

  let i = 0
  while (i < n) {
    // Stop as soon as the text has more numbers than allowed, before the rest of it is read and stored.
    if (out.length + idTokens.length > maxTokens) throw new NumberLimitError(`The text has more than ${maxTokens} numbers.`)
    const c = f[i] ?? 0
    if (c < 0x30 || c > 0x39) {
      if (VULGAR_FRACTIONS.has(c)) {
        i = handle(i)
        continue
      }
      if (c >= 0xd800 && c <= 0xdbff) {
        // Mathematical and other astral digits cannot be folded; they are listed, never dropped quietly.
        const e = astralDigitsEnd(i)
        if (e > i) {
          skip(i, e, 'unread-glued-form')
          i = e
          continue
        }
      }
      i++
      continue
    }
    i = handle(i)
  }

  /** True when a decimal mark at `m + 1` has nothing but a boundary before it: ".5", "$.99", "-.25". */
  function leadingMarkBoundary(m: number, mark: number): boolean {
    const c = at(m)
    if (c === -1) return true
    if (c === 0x20 || c === NBSP || c === 0x28) return true
    if (mark === 0x2c) {
      // A decimal comma (",5" under a comma-decimal locale) keeps the same boundaries after symbols
      // and opening punctuation; after a letter, digit or closing punctuation it is a separator.
      return (
        c === 0x7e || c === 0x2248 || c === 0x7c || c === 0x23 || c === 0x5f || c === 0x60 || c === 0x2265 || c === 0x2264 ||
        c === 0x201c || c === 0x2018 || c === 0x22 || c === 0x27 || c === 0x5b || c === 0x7b || c === 0x3c || c === 0x3e ||
        c === 0x3d || c === 0x3a || c === 0x3b || c === 0x2f || c === 0x2a || c === 0x2d || c === 0x2b || c === 0x2013 ||
        c === 0x2014 || CURRENCY_SYMBOLS.has(c)
      )
    }
    // An x or a multiplication sign right after a number: ".5x.7", "5 x.7".
    if (c === 0x78 || c === 0x58 || c === 0xd7) {
      let q = m - 1
      if (at(q) === 0x20 || at(q) === NBSP) q--
      return isDigit(at(q))
    }
    // Anything else keeps the point ("~.5", "|.99", "#.5", curly quotes), except where the point is
    // punctuation: after a letter or digit ("item.5"), another point or an ellipsis ("wait...5"), or
    // right after a number that ends there ("5%.5").
    if (isDigit(c) || isLetter(c) || isMark(c) || c === 0x2e || c === 0x2026) return false
    const prev = lastPlain()
    return !(prev !== undefined && prev.end === m + 1)
  }

  function handle(d0: number): number {
    // A vulgar fraction on its own ("½", "¼%") starts here instead of a digit.
    const bare = !isDigit(at(d0))
    // A decimal mark right before the digits, with nothing numeric before it, belongs to the number.
    const mark = at(d0 - 1)
    const lead = !bare && (mark === 0x2e || mark === 0x2c) && d0 - 1 >= floor && leadingMarkBoundary(d0 - 2, mark)
    // `i0` is where the number's own text starts, the mark included.
    const i0 = lead ? d0 - 1 : d0
    // ---- prefix: sign, currency, opening parenthesis --------------------------
    let signPos = -1
    let cur: CurrencyMatch | null
    if (i0 - 1 >= floor && (isSignCode(at(i0 - 1)) || at(i0 - 1) === EN_DASH)) {
      signPos = i0 - 1
      cur = matchCurrencyEnding(signPos)
    } else {
      cur = matchCurrencyEnding(i0)
      if (cur !== null && cur.start - 1 >= floor && (isSignCode(at(cur.start - 1)) || at(cur.start - 1) === EN_DASH)) signPos = cur.start - 1
    }
    // "$(557)": the currency sits outside the accounting parentheses.
    let parenAfterCurrency = false
    if (cur === null && signPos < 0 && at(i0 - 1) === 0x28 && i0 - 2 >= floor) {
      const outside = matchCurrencyEnding(i0 - 1)
      if (outside !== null) {
        cur = outside
        parenAfterCurrency = true
      }
    }
    let signValid = false
    if (signPos >= 0) {
      const pc = at(signPos - 1)
      const prevTok = lastPlain()
      signValid =
        (pc === -1 || (!isAlnum(pc) && pc !== 0x29 && pc !== 0x5d)) &&
        !(prevTok !== undefined && prevTok.end === signPos)
      // "+/-5%" and "+-5%" are a tolerance, read like "\u00b15%": the number has no sign.
      if (signValid && at(signPos) !== 0x2b && (pc === 0x2b || (pc === 0x2f && at(signPos - 2) === 0x2b))) signValid = false
    }
    let start = i0
    if (cur !== null) start = cur.start
    if (signValid && signPos < start) start = signPos
    // The dash that is not a sign: a range separator between two numbers.
    // The second endpoint may carry its own sign ("-5\u2013-3%"), so this is decided apart from the sign.
    let rangeDash = -1
    let rangePrev: Tok | undefined
    {
      // "10-12", "10\u201312", "10 \u2013 12" and "10 to 12" join two numbers into a range.
      const prev = lastPlain()
      if (prev !== undefined && prev.end >= floor && (rangeGap(prev.end, start) || betweenGap(prev, start))) {
        rangeDash = prev.end
        rangePrev = prev
      }
    }
    // "3 x 4", "3x4", "2 \u00d7 4": a multiplication sign between two numbers, not a letter glued on.
    const timesPrev = operatorBefore(start)

    // ---- identifiers glued to the number ("X3", "v2.1", "COVID-19") ------------
    if (cur === null && !bare) {
      const before = at(i0 - 1)
      if (before === 0x2d && i0 - 1 >= floor && !hyphenQuantityAt(i0)) {
        // Llama-3.3-70B-Instruct, gpt-5.4-nano-2026-03-17
        const we = hyphenIdentifierEnd(i0)
        if (we > i0) {
          skip(hyphenStart, we, 'identifier')
          return we
        }
      }
      if (
        (i0 - 1 >= floor && ((letterAt(i0 - 1) && !(timesPrev !== undefined && (before === 0x78 || before === 0x58))) || (before === 0x5f && underscoreGlues(i0 - 1)))) ||
        (i0 - 2 >= floor && before === 0x2d && isUpper(at(i0 - 2)))
      ) {
        const wStart = wordStart(i0)
        let j = skipIdentifier(i0)
        if (at(j) === 0x2d) {
          const we = hyphenIdentifierEnd(i0)
          if (we > j) j = we
        }
        // v1.2.3+4, v1.2-rc.1: a "v" followed by a dotted number is a version, suffixes included.
        if (before === 0x76 || before === 0x56) {
          let dotted = false
          for (let k = i0; k < j && !dotted; k++) dotted = at(k) === 0x2e
          if (dotted) j = skipVersionTail(j)
        }
        // Rs1,500, H2,500: a comma chain after a letter prefix is one form, not an identifier and a number.
        while (at(j) === 0x2c && isDigit(at(j + 1))) j = skipIdentifier(j + 1)
        skip(wStart, j, prefixedFormReason(wStart, i0, j))
        return j
      }
    }

    // ---- dates, times, month names -----------------------------------------------
    if (cur === null && !signValid && !bare) {
      const d = !lead ? tryDate(i0, rangeDash >= 0) : -1
      if (d >= 0) {
        // "5-6:30pm": the time that ends a range shares its meridiem with the number that starts it.
        const t = out[out.length - 1]
        if (rangePrev !== undefined && t !== undefined && t.kind === 'time' && rangeCanShare(rangePrev, t, start - rangeDash !== 1)) {
          joinGroup('range', rangePrev, t)
        }
        return d
      }
      const m = lead ? -1 : tryMonthName(i0)
      if (m >= 0) return m
    }

    // ---- the digit chain ----------------------------------------------------------
    const parts: number[] = []
    const seps: number[] = []
    let p = d0
    for (;;) {
      const e = runEnd(p)
      parts.push(p, e)
      const s = at(e)
      // An ordinary space groups digits only under a comma-decimal locale, and only as
      // "1 234": a short first group, then exactly three digits, as in French.
      const spaceOk =
        s === 0x20 && info.decimal === 0x2c && isDigit(at(e + 1)) && runEnd(e + 1) - (e + 1) === 3 &&
        (parts.length === 2 ? e - p <= 3 : e - p === 3)
      if (((s === 0x2c || s === 0x2e || isGroupSep(s)) && s !== 0x20 && isDigit(at(e + 1))) || spaceOk) {
        seps.push(s)
        p = e + 1
      } else {
        p = e
        break
      }
    }
    // A dotted chain of three or more numbers that is not a grouped integer
    // ("192.168.1.1", "1.2.3") is a version or an address: an identifier.
    if (seps.length >= 2 && seps.every((x) => x === 0x2e)) {
      const count = parts.length / 2
      let grouped = (parts[1] ?? 0) - (parts[0] ?? 0) <= 3 && at(parts[0] ?? 0) !== 0x30
      for (let q = 1; q < count && grouped; q++) grouped = (parts[2 * q + 1] ?? 0) - (parts[2 * q] ?? 0) === 3
      // 1.234.567-rc.1 and 1.234.567+4 are versions even though the parts look like groups.
      const versionSuffix = (at(p) === 0x2d && isLetter(at(p + 1))) || (at(p) === 0x2b && isAlnum(at(p + 1)))
      if (!grouped || versionSuffix) {
        const j = skipVersionTail(skipIdentifier(p))
        skip(i0, j, 'identifier')
        return j
      }
    }
    // A vulgar fraction right after the digits ("3½", "1 ½") or standing alone ("¼%") is part of the number.
    let vulgar: string | null | undefined
    let vulgarEnd = -1
    {
      const gap = !bare && (at(p) === 0x20 || at(p) === NBSP) ? 1 : 0
      const code = at(p + gap)
      if (VULGAR_FRACTIONS.has(code)) {
        vulgar = VULGAR_FRACTIONS.get(code) ?? null
        vulgarEnd = p + gap + 1
      }
    }
    const chain = interpretChain(parts, seps)
    const tokenCount = chain.tokens.length
    const chainEnd = vulgarEnd >= 0 ? vulgarEnd : p
    // The fraction belongs to the last number of the chain. It is read exactly when the fraction is
    // exact and the number has no decimals of its own; otherwise the whole form is passed over, and listed.
    let vulgarRead = false
    if (vulgarEnd >= 0) {
      const lastSub = chain.tokens[tokenCount - 1]
      if (lastSub !== undefined && !chain.skippedRest && vulgar !== null && vulgar !== undefined && lastSub.frac === '' && lastSub.alt === undefined) {
        lastSub.frac = vulgar
        lastSub.ambiguity = 'fraction'
        vulgarRead = true
      }
    }
    // A chain such as 1,234.5.6 is not a number: the part that could not be read is passed over, and listed.
    if (chain.skippedRest) skip(chain.restStart, chainEnd, 'identifier')
    let result = chainEnd
    for (let ti = 0; ti < tokenCount; ti++) {
      const sub = chain.tokens[ti]
      if (sub === undefined) continue
      const isFirst = ti === 0
      const isLast = ti === tokenCount - 1 && !chain.skippedRest
      // ".5" is 0.5. When the chain is more than the one run (".5.3", ".5,000") the mark is
      // kept as a guess instead of being dropped.
      const leadSingle = lead && isFirst && parts.length === 2
      if (leadSingle) {
        sub.frac = sub.int
        sub.int = '0'
      }
      const digitsStart = parts[2 * sub.first] ?? d0
      const digitsEnd = isLast && vulgarEnd >= 0 ? vulgarEnd : parts[2 * sub.last + 1] ?? chainEnd
      let tokStart = digitsStart
      let tokEnd = digitsEnd
      const tok = makeToken('', tokStart, tokEnd, '0', 0, 'count')
      let neg = false
      let signStyle: SignStyle | undefined
      let dashSign = false
      let currency: string | undefined
      let hasPrefixCurrency = false
      let currencyConflict = false
      if (isFirst) {
        tokStart = start
        if (cur !== null) {
          currency = cur.code
          hasPrefixCurrency = true
          if (cur.conflict === true) currencyConflict = true
        }
        if (signValid && at(signPos) !== -1) {
          // An en dash is a minus in typeset text and a dash everywhere else: no sign is read, and the number says so.
          dashSign = at(signPos) === EN_DASH
          if (!dashSign) {
            neg = at(signPos) === 0x2d
            signStyle = neg ? 'minus' : 'plus'
          }
        }
      }
      if (isLast && vulgarEnd >= 0 && !vulgarRead) {
        // ⅓, 2⅔: no exact decimal. The kit does not read it, and says so.
        skip(digitsStart, vulgarEnd, 'unread-glued-form')
        result = Math.max(result, vulgarEnd)
        continue
      }
      let sfx: Suffix | undefined
      if (isLast) {
        const intDigits = sub.frac === ''
        sfx = readSuffix(digitsEnd, hasPrefixCurrency, intDigits && sub.alt === undefined, sub.int === '0' && intDigits, intDigits && RESOLUTIONS.has(sub.int))
        if (sfx.skipTo >= 0) {
          // The number is glued to an identifier ("3D", "5G") or to letters the kit cannot read ("12foo").
          result = Math.max(sfx.skipTo, chainEnd)
          skip(digitsStart, result, sfx.skipReason)
          continue
        }
        tokEnd = sfx.end
        if (sfx.currency !== undefined) {
          if (currency === undefined) currency = sfx.currency
          else if (cur !== null && hasPrefixCurrency) {
            // "$500 CAD" names the dollar; "$500 EUR" contradicts itself.
            const resolved = resolveCurrency(cur, sfx.currency, sfx.dollarWord)
            if (resolved === null) currencyConflict = true
            else currency = resolved
          }
        }
      }

      // ---- parentheses as a negative ----------------------------------------------------
      const exp10 = sfx?.tooLong === true ? 0 : (sfx?.exp10 ?? 0)
      let rawStart = tokStart
      let rawEnd = tokEnd
      let parenthesized = false
      let ambiguity = sub.ambiguity
      if (sfx?.superscript === true) ambiguity = 'superscript'
      if (sfx?.tooLong === true || sub.int.length + sub.frac.length > MAX_DIGITS) ambiguity = 'too-long'
      if (sfx?.unreadMagnitude === true && ambiguity !== 'too-long' && ambiguity !== 'superscript') ambiguity = 'magnitude'
      if (currencyConflict && ambiguity !== 'too-long' && ambiguity !== 'superscript' && ambiguity !== 'magnitude') ambiguity = 'currency'
      if (isFirst && isLast && parenNeg && !neg && signStyle === undefined && ambiguity !== 'too-long') {
        const openAt = parenAfterCurrency ? i0 - 1 : rawStart - 1
        const open = openAt >= floor && at(openAt) === 0x28
        const close = at(rawEnd) === 0x29
        if (open && close) {
          // Only a bare parenthesized year is a citation; an amount or a grouped number is not.
          const yearShaped =
            sub.int.length === 4 && sub.frac === '' && sub.first === sub.last && currency === undefined &&
            sfx?.percent === undefined && sfx?.looseMagnitude !== true && Number(sub.int) >= 1900 && Number(sub.int) <= 2100
          // A bare "(500)" or "(2)" is usually a note or a list marker, so only numbers
          // that carry a separator, decimals, a currency or a percent sign read as negatives.
          const hasMark =
            sub.first !== sub.last || sub.frac !== '' || currency !== undefined ||
            sfx?.percent !== undefined || sfx?.looseMagnitude === true
          if (hasMark && !yearShaped) {
            neg = true
            signStyle = 'parentheses'
            if (!parenAfterCurrency) rawStart -= 1
            rawEnd += 1
          } else if (!yearShaped) {
            // A bare "(557)" is read as positive, but it may be an accounting negative.
            parenthesized = true
          }
        }
      }

      // ---- value ----------------------------------------------------------------------
      tok.value = decimalString(neg, sub.int, sub.frac, exp10)
      tok.scale = sub.frac.length - exp10
      // The digit limit counts the expanded value, so "1...1e1" is as long as its tokens say.
      if (ambiguity !== 'too-long' && tok.value.length - (neg ? 1 : 0) - (tok.value.includes('.') ? 1 : 0) > MAX_DIGITS) ambiguity = 'too-long'
      if (exp10 !== 0) tok.magnitude = exp10
      const alternates: Reading[] = []
      if (ambiguity !== 'too-long') {
        if (sub.alt !== undefined) {
          alternates.push({ value: decimalString(neg, sub.alt.int, sub.alt.frac, exp10), scale: sub.alt.frac.length - exp10 })
        }
        if (sfx?.looseMagnitude === true) {
          // "4K": 4000, or the label "4K". The unscaled reading is the alternate.
          alternates.push({ value: decimalString(neg, sub.int, sub.frac, 0), scale: sub.frac.length })
          ambiguity = ambiguity ?? 'suffix'
        }
        if (dashSign && (ambiguity === undefined || ambiguity === 'separator' || ambiguity === 'suffix')) {
          // "\u20133.2%": positive as written, negative if the dash was a minus. Neither reading may trace on its own.
          const readings = [{ value: tok.value, scale: tok.scale }, ...alternates]
          for (const r of readings) {
            if (r.value !== '0' && !r.value.startsWith('-')) alternates.push({ value: `-${r.value}`, scale: r.scale })
          }
          ambiguity = 'sign'
        }
        if (vulgarRead && isLast && sub.int !== '' && ambiguity === 'fraction') {
          // "3½": 3.5, or the 3 the fraction character was dropped from.
          alternates.push({ value: decimalString(neg, sub.int, '', exp10), scale: -exp10 })
        }
      }

      // ---- kind and unit ---------------------------------------------------------------------
      let kind: NumberKind
      if (sfx?.percent !== undefined) {
        kind = 'percent'
        tok.unit = sfx.percent
      } else if (currency !== undefined) {
        kind = 'currency'
        tok.currency = currency
      } else if (sfx?.ordinal === true) {
        kind = 'ordinal'
      } else if (
        sub.first === sub.last && sub.frac === '' && sub.int.length === 4 && !neg && signStyle === undefined &&
        exp10 === 0 && sfx?.unit === undefined && Number(sub.int) >= 1900 && Number(sub.int) <= 2100
      ) {
        kind = 'year'
      } else {
        kind = sub.frac !== '' || tok.scale > 0 ? 'decimal' : 'count'
      }
      if (sfx?.unit !== undefined && kind !== 'percent' && kind !== 'currency') tok.unit = sfx.unit
      tok.kind = kind
      tok.start = rawStart
      tok.end = rawEnd
      tok.raw = text.slice(rawStart, rawEnd)
      // The same words written the same way in the evidence vouch for these (like a fraction written 3/4 twice).
      if (ambiguity === 'magnitude' || ambiguity === 'currency' || ambiguity === 'sign' || (vulgarRead && isLast)) tok.groupRaw = tok.raw
      if (signStyle !== undefined) tok.signStyle = signStyle
      if (parenthesized) tok.parenthesized = true
      if (ambiguity !== undefined) {
        tok.ambiguous = true
        tok.ambiguity = ambiguity
        if (alternates.length > 0) tok.alternates = alternates
      }
      const leadGuess = lead && isFirst && (mark !== info.decimal || !leadSingle)
      if (leadGuess && ambiguity !== 'too-long' && ambiguity !== 'superscript') {
        tok.ambiguous = true
        tok.ambiguity = tok.ambiguity ?? 'separator'
        tok.localeGuess = true
      }
      if (sub.ambiguity === 'separator' && sub.alt === undefined && ambiguity !== 'too-long' && ambiguity !== 'superscript') {
        // The separator does not fit the locale: the reading is a guess, whatever else is later added.
        tok.localeGuess = true
      }
      if (kind === 'currency' && ambiguity !== 'currency') {
        if (hasPrefixCurrency && cur !== null && cur.family !== undefined && (sfx?.currency === undefined || sfx.dollarWord)) bareCurrency.set(tok, cur.family)
        else if (!hasPrefixCurrency && sfx?.dollarWord === true) bareCurrency.set(tok, 'dollar')
      }
      numInfo.set(tok, { neg, int: sub.int, frac: sub.frac, exp: exp10, loose: sfx?.looseMagnitude === true, sci: sfx?.scientific === true })
      if (isFirst && rangeDash >= 0) {
        const prev = lastPlain()
        if (prev !== undefined && rangeCanShare(prev, tok, start - rangeDash !== 1)) joinGroup('range', prev, tok)
      }
      if (isFirst && timesPrev !== undefined && rangeDash < 0) joinGroup('dimension', timesPrev, tok)
      if (isFirst && at(i0 - 1) === 0x2f && start === i0) {
        // 3/4: a fraction or a ratio, which this kit does not evaluate. Both parts are flagged.
        const prev = lastPlain()
        if (prev !== undefined && prev.end === i0 - 1) {
          // 1/2/3 is one group: every member carries the whole slash chain, set once at the end.
          if (fractionChain[fractionChain.length - 1] !== prev) {
            fractionChain = [prev]
            fractionChains.push(fractionChain)
          }
          fractionChain.push(tok)
          for (const t of [prev, tok]) {
            // Membership in a slash chain outranks any other reason, except the two that already block comparison.
            if (t.ambiguity !== 'too-long' && t.ambiguity !== 'superscript') {
              t.ambiguous = true
              t.ambiguity = 'fraction'
            }
          }
        }
      }
      out.push(tok)
      floor = rawEnd
      result = Math.max(result, rawEnd)
    }
    return result
  }

  /**
   * Whether two numbers joined by "to", a dash or "between ... and" are one range that shares its modifiers.
   * "Revenue rose 8% to $4.2 billion" and "subscribers rose 8% to 1,200" are a change and its result, not a range:
   * the percent sign stays with the 8, and the magnitude and the count stay with the other figure. Numbers that
   * are different kinds of quantity (a percent, an amount, a measured unit) never share. In the spoken forms
   * ("to", a spaced en dash, "between ... and") a percent is only ever carried backward onto a bare number
   * ("5 to 8%"), never forward and never together with a magnitude; a dash written tight ("5%-10") is a range.
   */
  function rangeCanShare(prev: Tok, tok: Tok, prose: boolean): boolean {
    const typeOf = (m: Tok): 'percent' | 'currency' | 'unit' | '' =>
      m.kind === 'percent' ? 'percent' : m.kind === 'currency' ? 'currency' : m.unit !== undefined ? 'unit' : ''
    const a = typeOf(prev)
    const b = typeOf(tok)
    if (a !== '' && b !== '' && a !== b) return false
    if (!prose) return true
    if (a === 'percent' && b !== 'percent') return false
    if (b === 'percent' && a === '' && (numInfo.get(prev)?.exp ?? 0) !== 0) return false
    return true
  }

  function isPlainKind(t: Tok): boolean {
    return t.kind === 'count' || t.kind === 'decimal' || t.kind === 'year'
  }

  /** Give a member what the rest of its group says: percent, currency, unit and magnitude. */
  function applyGroup(g: Group, m: Tok): void {
    if (g.unread === true && g.kind === 'range' && m.ambiguity !== 'magnitude' && m.ambiguity !== 'too-long' && m.ambiguity !== 'superscript') {
      m.ambiguous = true
      m.ambiguity = 'magnitude'
      m.groupRaw = m.raw
    }
    if (isPlainKind(m) && m.unit === undefined) {
      if (g.kind === 'range' && g.percent !== undefined) {
        m.kind = 'percent'
        m.unit = g.percent
      } else if (g.kind === 'range' && g.currency !== undefined) {
        m.kind = 'currency'
        m.currency = g.currency
        if (g.currencyBare !== undefined) bareCurrency.set(m, g.currencyBare)
      } else if (g.unit !== undefined) {
        m.unit = g.unit
      }
    }
    if (g.kind === 'range' && m.kind === 'currency' && m.ambiguity !== 'currency') {
      if (g.conflict === true) {
        // "$5-10 EUR": the members name currencies that cannot agree. None of them is read as either.
        if (m.ambiguity !== 'too-long' && m.ambiguity !== 'superscript' && m.ambiguity !== 'magnitude') {
          m.ambiguous = true
          m.ambiguity = 'currency'
          m.groupRaw = m.raw
        }
      } else if (g.currency !== undefined && g.currencyBare === undefined && m.currency !== g.currency && bareCurrency.has(m)) {
        // "$5 to $10 CAD": a bare dollar sign takes the code the range gives it.
        m.currency = g.currency
      }
    }
    const inf = numInfo.get(m)
    if (g.kind === 'range' && g.exp !== 0 && inf !== undefined && !inf.sci && inf.exp === 0 && m.ambiguity !== 'too-long' && m.ambiguity !== 'superscript') {
      m.value = decimalString(inf.neg, inf.int, inf.frac, g.exp)
      m.scale = inf.frac.length - g.exp
      m.magnitude = g.exp
      inf.exp = g.exp
      if (m.alternates !== undefined) {
        // Other readings move with the primary: 1.234 or 1234, both in millions.
        m.alternates = m.alternates.map((alt) => {
          const neg = alt.value.startsWith('-')
          const body = neg ? alt.value.slice(1) : alt.value
          const dot = body.indexOf('.')
          const aInt = dot < 0 ? body : body.slice(0, dot)
          const aFrac = dot < 0 ? '' : body.slice(dot + 1)
          return { value: decimalString(neg, aInt, aFrac, g.exp), scale: aFrac.length - g.exp }
        })
      }
      if (g.loose && g.currency === undefined) {
        // The unscaled reading joins whatever other readings the number already has.
        if (!m.ambiguous) {
          m.ambiguous = true
          m.ambiguity = 'suffix'
        }
        m.alternates = [...(m.alternates ?? []), { value: decimalString(inf.neg, inf.int, inf.frac, 0), scale: inf.frac.length }]
      }
    }
    // Anything that now has a unit, a currency, a percent sign or a magnitude is not a year.
    if (m.kind === 'year' && (m.unit !== undefined || (inf !== undefined && inf.exp !== 0))) m.kind = 'count'
    if (g.kind === 'range' && g.currency !== undefined && m.ambiguity === 'suffix') {
      // Money settles what a bare magnitude letter meant.
      m.ambiguous = false
      delete m.ambiguity
      delete m.alternates
    }
  }

  /**
   * Put `tok` in the range ("10-12%") or dimension ("3 x 4 cm") that `prev` is part of.
   * What one member says (a unit, a percent sign, a currency, a magnitude) is shared by
   * all of them. A group is re-applied only when it learns something new, so a long
   * chain costs linear time.
   */
  function joinGroup(kind: 'range' | 'dimension', prev: Tok, tok: Tok): void {
    let g = kind === 'range' ? rangeGroup : dimensionGroup
    if (g === null || g.members[g.members.length - 1] !== prev) {
      g = noProto({ kind, members: [prev], exp: 0, loose: false })
      if (kind === 'range') rangeGroup = g
      else dimensionGroup = g
      learn(g, prev)
    }
    g.members.push(tok)
    if (kind === 'range') {
      prev.range = 'start'
      tok.range = 'end'
    }
    const changed = learn(g, tok)
    if (changed) for (const m of g.members) applyGroup(g, m)
    else applyGroup(g, tok)
  }

  /** Take what a member says into the group; true when the group learned something new. */
  function learn(g: Group, m: Tok): boolean {
    let changed = false
    if (m.kind === 'percent' && g.percent === undefined && m.unit !== undefined) {
      g.percent = m.unit
      changed = true
    } else if (m.kind === 'currency' && g.currency === undefined && m.currency !== undefined && m.ambiguity !== 'currency') {
      g.currency = m.currency
      const bare = bareCurrency.get(m)
      if (bare !== undefined) g.currencyBare = bare
      changed = true
    } else if (m.kind === 'currency' && m.currency !== undefined && g.kind === 'range' && g.currency !== undefined && g.conflict !== true) {
      // A second currency in the range: a code settles a bare symbol, two codes that differ contradict.
      const bare = bareCurrency.get(m)
      if (m.ambiguity === 'currency') {
        g.conflict = true
        changed = true
      } else if (bare !== undefined && g.currencyBare === undefined) {
        if (!(bare === 'dollar' ? DOLLAR_CODES : YEN_CODES).has(g.currency)) {
          g.conflict = true
          changed = true
        }
      } else if (g.currencyBare !== undefined && bare === undefined) {
        if ((g.currencyBare === 'dollar' ? DOLLAR_CODES : YEN_CODES).has(m.currency)) g.currency = m.currency
        else g.conflict = true
        delete g.currencyBare
        changed = true
      } else if (bare === undefined ? m.currency !== g.currency : bare !== g.currencyBare) {
        g.conflict = true
        changed = true
      }
    } else if (m.kind !== 'percent' && m.kind !== 'currency' && m.unit !== undefined && g.unit === undefined) {
      g.unit = m.unit
      changed = true
    }
    if (m.ambiguity === 'magnitude' && g.unread !== true) {
      g.unread = true
      changed = true
    }
    const inf = numInfo.get(m)
    if (inf !== undefined && !inf.sci && inf.exp !== 0 && g.exp === 0) {
      g.exp = inf.exp
      g.loose = inf.loose
      changed = true
    }
    return changed && g.members.length > 1
  }

  for (const cluster of dateClusters) {
    let lo = Infinity
    let hi = -1
    for (const t of cluster) {
      lo = Math.min(lo, t.start)
      hi = Math.max(hi, t.end)
    }
    const whole = slice(lo, hi)
    for (const t of cluster) if (t.groupRaw === undefined) t.groupRaw = whole
  }
  for (const chain of fractionChains) {
    const first = chain[0]
    const last = chain[chain.length - 1]
    if (first === undefined || last === undefined) continue
    const whole = slice(first.start, last.end)
    for (const t of chain) if (t.ambiguity === 'fraction') t.groupRaw = whole
  }
  readClockHours(out)
  if (unreadDates.size > 0) {
    for (const t of out) {
      const raw = unreadDates.get(t.start)
      if (raw !== undefined && !t.ambiguous && (t.kind === 'count' || t.kind === 'year')) {
        t.ambiguous = true
        t.ambiguity = 'date'
        t.groupRaw = raw
      }
    }
  }
  for (const t of out) Object.freeze(t)
  if (idTokens.length === 0) return out
  // Merge the identifier digits back in, in text order.
  const merged: Tok[] = []
  let a = 0
  let b = 0
  while (a < out.length || b < idTokens.length) {
    const x = out[a]
    const y = idTokens[b]
    if (y === undefined || (x !== undefined && x.start <= y.start)) {
      if (x !== undefined) merged.push(x)
      a++
    } else {
      Object.freeze(y)
      merged.push(y)
      b++
    }
  }
  return merged
}
