// Exact decimal arithmetic on BigInt. No floats anywhere in this file.

/** value = n / 10^s, with s >= 0. */
export interface Dec {
  readonly n: bigint
  readonly s: number
}

/** A non-negative-denominator fraction p / q, q > 0. */
export interface Rat {
  readonly p: bigint
  readonly q: bigint
}

/** Largest number of digits a value may have before the kit refuses to do arithmetic on it. */
export const MAX_DIGITS = 60

const POW_CACHE: bigint[] = []

export function pow10(k: number): bigint {
  let v = POW_CACHE[k]
  if (v === undefined) {
    v = 10n ** BigInt(k)
    if (k < 400) POW_CACHE[k] = v
  }
  return v
}

/** Strict decimal syntax: optional sign, digits, optional `.digits`. No exponent, no spaces. */
export function isDecimalString(text: string, maxLength = 400): boolean {
  const n = text.length
  if (n === 0 || n > maxLength) return false
  let i = 0
  const c0 = text.charCodeAt(0)
  if (c0 === 0x2d || c0 === 0x2b) i = 1
  const intStart = i
  while (i < n && isDigitCode(text.charCodeAt(i))) i++
  if (i === intStart) return false
  if (i === n) return true
  if (text.charCodeAt(i) !== 0x2e) return false
  i++
  const fracStart = i
  while (i < n && isDigitCode(text.charCodeAt(i))) i++
  return i === n && i > fracStart
}

function isDigitCode(c: number): boolean {
  return c >= 0x30 && c <= 0x39
}

/** Parse a string already known to satisfy `isDecimalString`. Returns the signed value. */
export function parseDecimal(text: string): Dec {
  let neg = false
  let body = text
  const c0 = text.charCodeAt(0)
  if (c0 === 0x2d) {
    neg = true
    body = text.slice(1)
  } else if (c0 === 0x2b) {
    body = text.slice(1)
  }
  const dot = body.indexOf('.')
  const int = dot < 0 ? body : body.slice(0, dot)
  const frac = dot < 0 ? '' : body.slice(dot + 1)
  const n = BigInt(int + frac)
  return { n: neg ? -n : n, s: frac.length }
}

/** value = (+-)digits * 10^exp10 where `frac` digits follow the point. */
export function fromParts(neg: boolean, int: string, frac: string, exp10: number): Dec {
  let n = BigInt(int + frac)
  let s = frac.length - exp10
  if (s < 0) {
    n *= pow10(-s)
    s = 0
  }
  return { n: neg ? -n : n, s }
}

/** Compare two decimals exactly. */
export function cmp(a: Dec, b: Dec): -1 | 0 | 1 {
  let x = a.n
  let y = b.n
  if (a.s < b.s) x *= pow10(b.s - a.s)
  else if (b.s < a.s) y *= pow10(a.s - b.s)
  return x < y ? -1 : x > y ? 1 : 0
}

export function add(a: Dec, b: Dec): Dec {
  const s = Math.max(a.s, b.s)
  return { n: a.n * pow10(s - a.s) + b.n * pow10(s - b.s), s }
}

export function sub(a: Dec, b: Dec): Dec {
  const s = Math.max(a.s, b.s)
  return { n: a.n * pow10(s - a.s) - b.n * pow10(s - b.s), s }
}

export function abs(a: Dec): Dec {
  return a.n < 0n ? { n: -a.n, s: a.s } : a
}

/** The fraction a.n / 10^a.s as a Rat. */
export function toRat(a: Dec): Rat {
  return { p: a.n, q: pow10(a.s) }
}

export function ratDiv(a: Rat, b: Rat): Rat | null {
  if (b.p === 0n) return null
  let p = a.p * b.q
  let q = a.q * b.p
  if (q < 0n) {
    p = -p
    q = -q
  }
  return { p, q }
}

export function ratMul(a: Rat, b: Rat): Rat {
  return { p: a.p * b.p, q: a.q * b.q }
}

export function ratSub(a: Rat, b: Rat): Rat {
  return { p: a.p * b.q - b.p * a.q, q: a.q * b.q }
}

export function ratAdd(a: Rat, b: Rat): Rat {
  return { p: a.p * b.q + b.p * a.q, q: a.q * b.q }
}

export interface Rounded {
  /** The rounded value as an integer count of units of 10^-scale. */
  readonly mantissa: bigint
  /** True when the input was already exactly that value (no rounding happened). */
  readonly exact: boolean
}

/**
 * Round a non-negative fraction p/q to `scale` decimals (scale may be negative:
 * -5 rounds to the nearest 100,000).
 *
 * half-up: a tie goes to the larger magnitude (away from zero for the sign
 * the caller restores). half-even: a tie goes to the even neighbor.
 */
export function roundRat(r: Rat, scale: number, mode: 'half-up' | 'half-even'): Rounded {
  let num = r.p
  let den = r.q
  if (scale >= 0) num *= pow10(scale)
  else den *= pow10(-scale)
  const quo = num / den
  const rem = num % den
  if (rem === 0n) return { mantissa: quo, exact: true }
  const twice = rem * 2n
  if (twice > den) return { mantissa: quo + 1n, exact: false }
  if (twice < den) return { mantissa: quo, exact: false }
  if (mode === 'half-up') return { mantissa: quo + 1n, exact: false }
  return { mantissa: quo % 2n === 0n ? quo : quo + 1n, exact: false }
}

/**
 * The integer count of units of 10^-scale in a decimal value. Returns null
 * when the value is not an exact multiple of that unit.
 */
export function mantissaAt(a: Dec, scale: number): bigint | null {
  if (scale >= a.s) return a.n * pow10(scale - a.s)
  const div = pow10(a.s - scale)
  return a.n % div === 0n ? a.n / div : null
}

/** Format an exact decimal with exactly `places` fraction digits (at least a.s). Zero prints as `0`. */
export function formatDec(a: Dec, places: number = a.s): string {
  const s = Math.max(places, a.s)
  const n = a.n * pow10(s - a.s)
  if (n === 0n) return '0'
  const neg = n < 0n
  let digits = (neg ? -n : n).toString()
  if (s > 0) {
    if (digits.length <= s) digits = '0'.repeat(s - digits.length + 1) + digits
    digits = `${digits.slice(0, digits.length - s)}.${digits.slice(digits.length - s)}`
  }
  return neg ? `-${digits}` : digits
}

/**
 * Canonical key for the absolute value of a decimal string: no sign, no
 * leading zeros, no trailing fraction zeros. String work only, so it is safe
 * for very long digit strings.
 */
export function absKey(value: string): string {
  let i = value.charCodeAt(0) === 0x2d || value.charCodeAt(0) === 0x2b ? 1 : 0
  const dot = value.indexOf('.')
  const intEnd = dot < 0 ? value.length : dot
  while (i < intEnd - 1 && value.charCodeAt(i) === 0x30) i++
  const int = value.slice(i, intEnd)
  if (dot < 0) return int
  let end = value.length
  while (end > dot + 1 && value.charCodeAt(end - 1) === 0x30) end--
  return end === dot + 1 ? int : `${int}.${value.slice(dot + 1, end)}`
}

export function isNegativeValue(value: string): boolean {
  if (value.charCodeAt(0) !== 0x2d) return false
  // "-0" and "-0.00" are zero, not negative.
  for (let i = 1; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c !== 0x30 && c !== 0x2e) return true
  }
  return false
}
