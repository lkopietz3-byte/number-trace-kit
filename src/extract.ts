import { MAX_DIGITS } from './decimal.js'
import { MAX_TEXT_LENGTH, readBoolean, readOptions } from './input.js'
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

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
  june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
}

const CURRENCY_SYMBOLS: Record<number, string> = {
  0x24: 'USD', 0x20ac: 'EUR', 0xa3: 'GBP', 0xa5: '¥', 0x20b9: 'INR', 0x20a9: 'KRW',
  0x20bd: 'RUB', 0x20ba: 'TRY', 0x20ab: 'VND', 0x20aa: 'ILS', 0x20b1: 'PHP', 0xe3f: 'THB',
  0x20b4: 'UAH', 0x20a6: 'NGN',
}
const CURRENCY_CODES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'MXN', 'BRL', 'KRW', 'SEK',
  'NOK', 'DKK', 'NZD', 'SGD', 'HKD', 'PLN', 'ZAR', 'RUB', 'TRY',
])
const DOLLAR_PREFIXES: Record<string, string> = {
  US: 'USD', CA: 'CAD', AU: 'AUD', NZ: 'NZD', HK: 'HKD', MX: 'MXN', C: 'CAD', A: 'AUD', S: 'SGD', R: 'BRL',
}
const CURRENCY_WORDS: Record<string, string> = {
  dollars: 'USD', dollar: 'USD', euros: 'EUR', euro: 'EUR', usd: 'USD', eur: 'EUR', gbp: 'GBP',
  cad: 'CAD', aud: 'AUD', chf: 'CHF', jpy: 'JPY', cny: 'CNY', inr: 'INR',
}

// Units written right against the number ("5kg"). Case matters here.
const GLUED_UNITS: Record<string, string> = {
  kg: 'kg', g: 'g', mg: 'mg', lb: 'lb', lbs: 'lb', oz: 'oz', km: 'km', m: 'm', cm: 'cm', mm: 'mm',
  mi: 'mi', ft: 'ft', ms: 'ms', s: 'second', h: 'hour', hr: 'hour', hrs: 'hour', min: 'minute',
  mins: 'minute', sec: 'second', secs: 'second', yr: 'year', yrs: 'year', KB: 'KB', kB: 'KB',
  MB: 'MB', GB: 'GB', TB: 'TB', ml: 'ml', mL: 'ml', L: 'l', l: 'l', kW: 'kW', kWh: 'kWh', MW: 'MW',
  GHz: 'GHz', MHz: 'MHz', mph: 'mph', kph: 'kph', x: 'x', am: 'am', pm: 'pm', bps: 'bps',
}
// Units written as a following word ("3 days"). Compared in lower case.
const SPACED_UNITS: Record<string, string> = {
  day: 'day', days: 'day', week: 'week', weeks: 'week', month: 'month', months: 'month',
  year: 'year', years: 'year', yr: 'year', yrs: 'year', hour: 'hour', hours: 'hour', hr: 'hour',
  hrs: 'hour', minute: 'minute', minutes: 'minute', min: 'minute', mins: 'minute', second: 'second',
  seconds: 'second', sec: 'second', secs: 'second', kg: 'kg', kilogram: 'kg', kilograms: 'kg',
  gram: 'g', grams: 'g', mg: 'mg', lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb', oz: 'oz',
  ounce: 'oz', ounces: 'oz', mile: 'mi', miles: 'mi', km: 'km', kilometer: 'km', kilometers: 'km',
  kilometre: 'km', kilometres: 'km', meter: 'm', meters: 'm', metre: 'm', metres: 'm', cm: 'cm',
  mm: 'mm', foot: 'ft', feet: 'ft', ft: 'ft', inch: 'in', inches: 'in', gallon: 'gal',
  gallons: 'gal', liter: 'l', liters: 'l', litre: 'l', litres: 'l', ml: 'ml', mb: 'MB', gb: 'GB',
  tb: 'TB', bps: 'bps', mph: 'mph',
}
const MAGNITUDE_WORDS: Record<string, number> = {
  thousand: 3, million: 6, billion: 9, trillion: 12, bn: 9, mn: 6, tn: 12,
}

/** A table lookup that never reaches Object.prototype ("constructor", "toString", ...). */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
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
  if (c < 0xc0) return c === 0xaa || c === 0xb5 || c === 0xba
  return (c <= 0x24f && c !== 0xd7 && c !== 0xf7) || (c >= 0x1e00 && c <= 0x1eff)
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
      else if (c === 0x066b) c = 0x2e
      else if (c === 0x066c) c = 0x2c
      else if (c === 0x066a) c = 0x25
      else if (c === 0x2212 || c === 0x2010 || c === 0x2011) c = 0x2d
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
  return { raw, start, end, value, scale, kind, ambiguous: false }
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
  /** The text glued to the number is an identifier; resume scanning here. */
  skipTo: number
  /** An exponent too large to expand ("1e999"). */
  tooLong: boolean
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
 * make an output number `unknown`, never `traced`.
 */
export function scan(text: string, info: LocaleInfo, parenNeg: boolean, identifiers = false): NumberToken[] {
  const n = text.length
  if (n > MAX_TEXT_LENGTH) {
    throw new RangeError(`Text has ${n} characters; the limit is ${MAX_TEXT_LENGTH}.`)
  }
  const f = fold(text)
  const out: Tok[] = []
  const idTokens: Tok[] = []
  let floor = 0
  let lastMonth: { start: number; end: number } | null = null
  let lastDayEnd = -1

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
    isGroupSpace(c) || (info.apostrophe && (c === 0x27 || c === 0x2019))
  const lastToken = (): Tok | undefined => out[out.length - 1]
  const lastPlain = (): Tok | undefined => {
    const t = lastToken()
    return t !== undefined && t.kind !== 'date-part' ? t : undefined
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

  const monthWordAt = (s: number): { end: number; month: number } | null => {
    // A capitalized month name or abbreviation starting at s, ending at a non-letter.
    if (!isUpper(at(s))) return null
    let q = s
    while (q < n && q - s < 10 && isLetter(at(q))) q++
    if (isLetter(at(q))) return null
    const month = own(MONTHS, text.slice(s, q).toLowerCase())
    return month === undefined ? null : { end: q, month }
  }

  const monthWordBefore = (i: number): { start: number; end: number; month: number; fresh: boolean } | null => {
    let p = i - 1
    if (at(p) === 0x20 || at(p) === NBSP) p--
    if (at(p) === 0x2e) p--
    let q = p
    while (q >= 0 && p - q < 10 && isLetter(at(q))) q--
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

  const pushMonth = (s: number, e: number, month: number): void => {
    const t = pushDate(s, e, month, 'month', undefined)
    t.value = String(month)
    lastMonth = { start: s, end: e }
  }

  /** ISO dates, times of day and numeric D/M/Y dates. Returns the end index or -1. */
  const tryDate = (i: number): number => {
    const a = runEnd(i) - i
    if (a === 0 || a > 4) return -1
    const sep = at(i + a)
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
            const raw = text.slice(i, after)
            pushDate(i, i + 4, num(i, i + 4), 'year', raw)
            pushDate(r2, r2 + b1, m, 'month', raw)
            pushDate(r3, after, d, 'day', raw)
            return after
          }
        }
      }
      return -1
    }
    if ((a === 1 || a === 2) && sep === 0x3a) {
      const r2 = i + a + 1
      if (runEnd(r2) - r2 === 2) {
        const h = num(i, i + a)
        const mi = num(r2, r2 + 2)
        let after = r2 + 2
        let sec: number | null = null
        if (at(after) === 0x3a && runEnd(after + 1) - (after + 1) === 2) {
          sec = num(after + 1, after + 3)
          after += 3
        }
        if (!isDigit(at(after)) && h <= 24 && mi <= 59 && (sec === null || sec <= 60)) {
          const raw = text.slice(i, after)
          pushDate(i, i + a, h, 'hour', raw)
          pushDate(r2, r2 + 2, mi, 'minute', raw)
          if (sec !== null) pushDate(r2 + 3, r2 + 5, sec, 'second', raw)
          return after
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
          const raw = text.slice(i, after)
          const reason = decisive ? undefined : 'date-order'
          pushDate(i, i + a, p, decisive ? (firstIsDay ? 'day' : 'month') : undefined, raw, reason)
          pushDate(r2, r2 + b1, q, decisive ? (firstIsDay ? 'month' : 'day') : undefined, raw, reason)
          pushDate(r3, after, y, 'year', raw)
          return after
        }
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
    const before = monthWordBefore(i)
    if (before !== null) {
      if (a <= 2 && v >= 1 && v <= 31) {
        if (before.fresh) pushMonth(before.start, before.end, before.month)
        let e = e0
        const suf = ordinalSuffixAt(e)
        if (suf > 0) e += suf
        pushDate(i, e, v, 'day', undefined)
        lastDayEnd = e
        return e
      }
      if (a === 4) {
        if (before.fresh) pushMonth(before.start, before.end, before.month)
        pushDate(i, e0, v, 'year', undefined)
        return e0
      }
      return -1
    }
    if (a === 4 && lastDayEnd >= 0 && floor === lastDayEnd) {
      const gap = i - lastDayEnd
      if ((gap === 1 && (at(lastDayEnd) === 0x20 || at(lastDayEnd) === 0x2c)) ||
        (gap === 2 && at(lastDayEnd) === 0x2c && at(lastDayEnd + 1) === 0x20)) {
        pushDate(i, e0, v, 'year', undefined)
        return e0
      }
    }
    if (a <= 2 && v >= 1 && v <= 31) {
      let e = e0
      const suf = ordinalSuffixAt(e)
      if (suf > 0) e += suf
      let p = e
      if (at(p) === 0x20) {
        p++
        if ((at(p) === 0x6f || at(p) === 0x4f) && (at(p + 1) === 0x66 || at(p + 1) === 0x46) && at(p + 2) === 0x20) p += 3
        const w = monthWordAt(p)
        if (w !== null) {
          pushDate(i, e, v, 'day', undefined)
          pushMonth(p, w.end, w.month)
          lastDayEnd = -1
          return w.end
        }
      }
    }
    return -1
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
    return isDigit(at(q))
  }

  const readWord = (p: number, max: number): string => {
    let q = p
    while (q < n && q - p <= max && isLetter(at(q))) q++
    return text.slice(p, q)
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

  const skipIdentifier = (from: number): number => {
    let j = from
    while (j < n) {
      const ch = at(j)
      if (isAlnum(ch) || ch === 0x5f) j++
      else if (ch === 0x2e && isAlnum(at(j + 1))) j++
      else break
    }
    return j
  }

  const matchCurrencyEnding = (pos: number): { start: number; code: string } | null => {
    let p = pos - 1
    if (p >= floor && (at(p) === 0x20 || at(p) === NBSP)) p--
    if (p < floor) return null
    const c = at(p)
    const symbol = CURRENCY_SYMBOLS[c]
    if (symbol !== undefined) {
      if (c === 0x24) {
        // US$, CA$, C$ ... : up to two capital letters glued before the dollar sign.
        if (p - 2 >= floor && isUpper(at(p - 1)) && isUpper(at(p - 2)) && !isLetter(at(p - 3))) {
          const code = own(DOLLAR_PREFIXES, text.slice(p - 2, p))
          if (code !== undefined) return { start: p - 2, code }
        }
        if (p - 1 >= floor && isUpper(at(p - 1)) && !isLetter(at(p - 2))) {
          const code = own(DOLLAR_PREFIXES, text.slice(p - 1, p))
          if (code !== undefined) return { start: p - 1, code }
        }
      }
      return { start: p, code: symbol }
    }
    if (p - 2 >= floor && isUpper(c) && isUpper(at(p - 1)) && isUpper(at(p - 2)) && !isLetter(at(p - 3))) {
      const code = text.slice(p - 2, p + 1)
      if (CURRENCY_CODES.has(code)) return { start: p - 2, code }
    }
    return null
  }

  const isSignCode = (c: number): boolean => c === 0x2d || c === 0x2b

  const readSuffix = (e: number, hasCurrency: boolean, isInteger: boolean): Suffix => {
    const sfx: Suffix = {
      end: e, exp10: 0, ordinal: false, superscript: false, looseMagnitude: false, skipTo: -1, tooLong: false,
    }
    let p = e
    if (at(p) === 0x5f) {
      sfx.skipTo = skipIdentifier(p)
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
    if ((at(p) | 0x20) === 0x65) {
      // Scientific notation: 1.5e3, 2E-4.
      let q = p + 1
      const negative = at(q) === 0x2d
      if (negative || at(q) === 0x2b) q++
      const digitsStart = q
      while (isDigit(at(q)) && q - digitsStart < 6) q++
      if (q > digitsStart && !isAlnum(at(q)) && at(q) !== 0x5f) {
        const e = Number(slice(digitsStart, q))
        if (e <= 30) sfx.exp10 = negative ? -e : e
        else sfx.tooLong = true
        sfx.end = q
        return sfx
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
    let magnitudeRead = false
    if (isLetter(at(p))) {
      const w = readWord(p, 16)
      const we = p + w.length
      if (w.length > 16 || isDigit(at(we)) || isLetter(at(we))) {
        sfx.skipTo = skipIdentifier(we)
        return sfx
      }
      const lower = w.toLowerCase()
      const single = w === 'K' || w === 'k' || w === 'M' || w === 'B' || w === 'T'
      const singleLower = hasCurrency && (w === 'm' || w === 'b' || w === 't')
      if (single || singleLower) {
        sfx.exp10 = w === 'K' || w === 'k' ? 3 : w === 'M' || w === 'm' ? 6 : w === 'B' || w === 'b' ? 9 : 12
        sfx.looseMagnitude = !hasCurrency
        p = we
        magnitudeRead = true
      } else if (lower === 'bn' || lower === 'mn' || lower === 'tn') {
        sfx.exp10 = own(MAGNITUDE_WORDS, lower) ?? 0
        p = we
        magnitudeRead = true
      } else if (isInteger && (lower === 'st' || lower === 'nd' || lower === 'rd' || lower === 'th')) {
        sfx.ordinal = true
        sfx.end = we
        return sfx
      } else if (lower === 'pp' || lower === 'ppt' || lower === 'ppts') {
        sfx.percent = 'pp'
        sfx.end = we
        return sfx
      } else if (lower === 'pct') {
        sfx.percent = '%'
        sfx.end = we
        return sfx
      } else if (w.length === 3 && CURRENCY_CODES.has(w)) {
        sfx.currency = w
        sfx.end = we
        return sfx
      } else {
        const unit = own(GLUED_UNITS, w)
        if (unit === undefined) {
          sfx.skipTo = skipIdentifier(we)
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
      if (at(from) !== 0x20 && at(from) !== NBSP) return -1
      const s = from + 1
      if (!isLetter(at(s))) {
        const sym = CURRENCY_SYMBOLS[at(s)]
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
      if (isDigit(at(we))) return -1
      const lower = w.toLowerCase()
      if (!magnitudeRead && own(MAGNITUDE_WORDS, lower) !== undefined && lower !== 'bn' && lower !== 'mn' && lower !== 'tn') {
        sfx.exp10 = own(MAGNITUDE_WORDS, lower) ?? 0
        magnitudeRead = true
        const next = readSpaced(we)
        return next < 0 ? we : next
      }
      if (!magnitudeRead && (lower === 'bn' || lower === 'mn' || lower === 'tn')) {
        sfx.exp10 = own(MAGNITUDE_WORDS, lower) ?? 0
        magnitudeRead = true
        const next = readSpaced(we)
        return next < 0 ? we : next
      }
      if (lower === 'percent' || lower === 'pct') {
        sfx.percent = '%'
        return we
      }
      if (lower === 'per' && at(we) === 0x20 && readWord(we + 1, 6).toLowerCase() === 'cent') {
        sfx.percent = '%'
        return we + 1 + 4
      }
      if (lower === 'percentage') {
        const w2 = readWord(we + 1, 8).toLowerCase()
        if (at(we) === 0x20 && (w2 === 'point' || w2 === 'points')) {
          sfx.percent = 'pp'
          return we + 1 + w2.length
        }
        return -1
      }
      if (lower === 'pp' || lower === 'ppt') {
        sfx.percent = 'pp'
        return we
      }
      if (w.length === 3 && CURRENCY_CODES.has(w)) {
        sfx.currency = w
        return we
      }
      const currency = own(CURRENCY_WORDS, lower)
      if (currency !== undefined && (lower.length > 3 || w === w.toUpperCase() || lower === w)) {
        sfx.currency = currency
        return we
      }
      const unit = own(SPACED_UNITS, lower)
      if (unit !== undefined && !magnitudeRead) {
        sfx.unit = unit
        return we
      }
      return -1
    }
    if (magnitudeRead) {
      const next = readSpaced(p)
      if (next >= 0) p = next
      sfx.end = p
      if (sfx.currency !== undefined || sfx.percent !== undefined) sfx.looseMagnitude = false
      return sfx
    }
    if (at(p) === 0x2d && isLetter(at(p + 1))) {
      const w = readWord(p + 1, 12)
      const unit = own(SPACED_UNITS, w.toLowerCase())
      if (unit !== undefined && !isLetter(at(p + 1 + w.length)) && !isDigit(at(p + 1 + w.length))) {
        sfx.unit = unit
        sfx.end = p + 1 + w.length
      }
      return sfx
    }
    const sym = CURRENCY_SYMBOLS[at(p)]
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
  ): { tokens: SubToken[]; skippedRest: boolean } => {
    const tokens: SubToken[] = []
    const count = parts.length / 2
    const partStart = (k: number): number => parts[2 * k] ?? 0
    const partEnd = (k: number): number => parts[2 * k + 1] ?? 0
    const partLen = (k: number): number => partEnd(k) - partStart(k)
    const D = info.decimal
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
          let q = k + 1
          while (q < count && seps[q - 1] === X && partLen(q) === 2) q++
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
          return { tokens, skippedRest: true }
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
      tokens.push({
        first, last, int, frac,
        ...(ambiguity !== undefined ? { ambiguity } : {}),
        ...(alt !== undefined ? { alt } : {}),
      })
      k = last + 1
    }
    return { tokens, skippedRest: false }
  }

  let i = 0
  while (i < n) {
    const c = f[i] ?? 0
    if (c < 0x30 || c > 0x39) {
      i++
      continue
    }
    i = handle(i)
  }

  function handle(i0: number): number {
    // ---- prefix: sign, currency, opening parenthesis --------------------------
    let signPos = -1
    let cur: { start: number; code: string } | null
    if (i0 - 1 >= floor && isSignCode(at(i0 - 1))) {
      signPos = i0 - 1
      cur = matchCurrencyEnding(signPos)
    } else {
      cur = matchCurrencyEnding(i0)
      if (cur !== null && cur.start - 1 >= floor && isSignCode(at(cur.start - 1))) signPos = cur.start - 1
    }
    let signValid = false
    if (signPos >= 0) {
      const pc = at(signPos - 1)
      const prevTok = lastPlain()
      signValid =
        (pc === -1 || (!isAlnum(pc) && pc !== 0x29 && pc !== 0x5d)) &&
        !(prevTok !== undefined && prevTok.end === signPos)
    }
    let start = i0
    if (cur !== null) start = cur.start
    if (signValid && signPos < start) start = signPos
    // The dash that is not a sign: a range separator between two numbers.
    let rangeDash = -1
    if (!signValid) {
      const dc = at(start - 1)
      const prev = lastPlain()
      if ((dc === 0x2d || dc === 0x2013) && start - 1 >= floor && prev !== undefined && prev.end === start - 1) {
        rangeDash = start - 1
      }
    }

    // ---- identifiers glued to the number ("X3", "v2.1", "COVID-19") ------------
    if (cur === null) {
      const before = at(i0 - 1)
      if (
        (i0 - 1 >= floor && (isLetter(before) || before === 0x5f)) ||
        (i0 - 2 >= floor && before === 0x2d && isUpper(at(i0 - 2)))
      ) {
        const j = skipIdentifier(i0)
        noteIdentifier(i0, j)
        return j
      }
    }

    // ---- dates, times, month names -----------------------------------------------
    if (cur === null && !signValid && rangeDash < 0) {
      const d = tryDate(i0)
      if (d >= 0) return d
      const m = tryMonthName(i0)
      if (m >= 0) return m
    }

    // ---- the digit chain ----------------------------------------------------------
    const parts: number[] = []
    const seps: number[] = []
    let p = i0
    for (;;) {
      const e = runEnd(p)
      parts.push(p, e)
      const s = at(e)
      if ((s === 0x2c || s === 0x2e || isGroupSep(s)) && isDigit(at(e + 1))) {
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
      if (!grouped) {
        const j = skipIdentifier(p)
        noteIdentifier(i0, j)
        return j
      }
    }
    const chain = interpretChain(parts, seps)
    const tokenCount = chain.tokens.length
    const chainEnd = p
    let result = chainEnd
    for (let ti = 0; ti < tokenCount; ti++) {
      const sub = chain.tokens[ti]
      if (sub === undefined) continue
      const isFirst = ti === 0
      const isLast = ti === tokenCount - 1 && !chain.skippedRest
      const digitsStart = parts[2 * sub.first] ?? i0
      const digitsEnd = parts[2 * sub.last + 1] ?? chainEnd
      let tokStart = digitsStart
      let tokEnd = digitsEnd
      const tok = makeToken('', tokStart, tokEnd, '0', 0, 'count')
      let neg = false
      let signStyle: SignStyle | undefined
      let currency: string | undefined
      let hasPrefixCurrency = false
      if (isFirst) {
        tokStart = start
        if (cur !== null) {
          currency = cur.code
          hasPrefixCurrency = true
        }
        if (signValid && at(signPos) !== -1) {
          neg = at(signPos) === 0x2d
          signStyle = neg ? 'minus' : 'plus'
        }
      }
      let sfx: Suffix | undefined
      if (isLast) {
        const intDigits = sub.frac === ''
        sfx = readSuffix(digitsEnd, hasPrefixCurrency, intDigits && sub.alt === undefined)
        if (sfx.skipTo >= 0) {
          // The number is glued to an identifier ("3D", "5G"): not a number at all.
          result = Math.max(sfx.skipTo, chainEnd)
          noteIdentifier(digitsStart, result)
          continue
        }
        tokEnd = sfx.end
        if (sfx.currency !== undefined && currency === undefined) currency = sfx.currency
      }

      // ---- parentheses as a negative ----------------------------------------------------
      const exp10 = sfx?.tooLong === true ? 0 : (sfx?.exp10 ?? 0)
      let rawStart = tokStart
      let rawEnd = tokEnd
      let ambiguity = sub.ambiguity
      if (sfx?.superscript === true) ambiguity = 'superscript'
      if (sfx?.tooLong === true || sub.int.length + sub.frac.length > MAX_DIGITS) ambiguity = 'too-long'
      if (isFirst && isLast && parenNeg && !neg && signStyle === undefined && ambiguity !== 'too-long') {
        const open = rawStart - 1 >= floor && at(rawStart - 1) === 0x28
        const close = at(rawEnd) === 0x29
        if (open && close) {
          const yearShaped = sub.int.length === 4 && sub.frac === '' && Number(sub.int) >= 1900 && Number(sub.int) <= 2100
          // A bare "(500)" or "(2)" is usually a note or a list marker, so only numbers
          // that carry a separator, decimals, a currency or a percent sign read as negatives.
          const hasMark =
            sub.first !== sub.last || sub.frac !== '' || currency !== undefined ||
            sfx?.percent !== undefined || sfx?.looseMagnitude === true
          if (hasMark && !yearShaped) {
            neg = true
            signStyle = 'parentheses'
            rawStart -= 1
            rawEnd += 1
          }
        }
      }

      // ---- value ----------------------------------------------------------------------
      tok.value = decimalString(neg, sub.int, sub.frac, exp10)
      tok.scale = sub.frac.length - exp10
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
      if (signStyle !== undefined) tok.signStyle = signStyle
      if (ambiguity !== undefined) {
        tok.ambiguous = true
        tok.ambiguity = ambiguity
        if (alternates.length > 0) tok.alternates = alternates
      }
      if (isFirst && rangeDash >= 0) {
        const prev = lastPlain()
        if (prev !== undefined) linkRange(prev, tok, cur !== null)
      }
      if (isFirst && at(i0 - 1) === 0x2f && start === i0) {
        // 3/4: a fraction or a ratio, which this kit does not evaluate. Both parts are flagged.
        const prev = lastPlain()
        if (prev !== undefined && prev.end === i0 - 1) {
          const whole = text.slice(prev.start, tok.end)
          for (const t of [prev, tok]) {
            if (!t.ambiguous) {
              t.ambiguous = true
              t.ambiguity = 'fraction'
              t.groupRaw = whole
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

  function linkRange(prev: Tok, tok: Tok, secondHasCurrencySymbol: boolean): void {
    prev.range = 'start'
    tok.range = 'end'
    const plain = (t: Tok): boolean => t.kind === 'count' || t.kind === 'decimal' || t.kind === 'year'
    if (tok.kind === 'percent' && plain(prev) && prev.unit === undefined) {
      prev.kind = 'percent'
      if (tok.unit !== undefined) prev.unit = tok.unit
    } else if (tok.kind === 'currency' && plain(prev) && prev.unit === undefined) {
      prev.kind = 'currency'
      if (tok.currency !== undefined) prev.currency = tok.currency
    } else if (prev.kind === 'currency' && plain(tok) && tok.unit === undefined && !secondHasCurrencySymbol) {
      tok.kind = 'currency'
      if (prev.currency !== undefined) tok.currency = prev.currency
    } else if (tok.unit !== undefined && plain(prev) && prev.unit === undefined && tok.kind !== 'percent') {
      prev.unit = tok.unit
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
