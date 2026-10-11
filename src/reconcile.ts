import { add, cmp, formatDec, fromParts, isDecimalString, parseDecimal, sub } from './decimal.js'
import type { Dec } from './decimal.js'
import { describe, isRecord, readBoolean, readInteger, readOptions, snapshotArray } from './input.js'
import type {
  ReconcileComponentsInput,
  ReconcileInput,
  ReconcileOptions,
  ReconcileResult,
} from './types.js'

const FLOAT_WITH_EXPONENT = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/

const CURRENCY_SIGNS = new Set(['$', '\u20ac', '\u00a3', '\u00a5', '\u20b9'])

/**
 * An amount as a report prints it: an optional minus or plus, an optional currency sign, digits
 * with comma thousands groups (exactly three digits per group) and an optional decimal part, all
 * of it optionally inside accounting parentheses. "38,400", "$600.00", "(557)", "-$557.50",
 * ".5". Anything it cannot read exactly (a comma in the wrong place, a decimal comma,
 * spaces, an exponent, other digit systems) is null.
 */
function parsePrinted(text: string): Dec | null {
  if (text.length === 0 || text.length > 120) return null
  let s = text
  let negative = false
  let signed = false
  const parentheses = s.startsWith('(') && s.endsWith(')')
  if (parentheses) {
    negative = true
    s = s.slice(1, -1)
  }
  // One sign at most, before or after the currency sign, and none inside parentheses.
  const sign = (): boolean => {
    const c = s[0]
    if (c !== '-' && c !== '\u2212' && c !== '+') return true
    if (signed || parentheses) return false
    signed = true
    if (c !== '+') negative = true
    s = s.slice(1)
    return true
  }
  if (!sign()) return null
  if (s.length > 0 && CURRENCY_SIGNS.has(s[0] ?? '')) {
    s = s.slice(1)
    if (!sign()) return null
  }
  const dot = s.indexOf('.')
  const whole = dot < 0 ? s : s.slice(0, dot)
  const fraction = dot < 0 ? '' : s.slice(dot + 1)
  if (dot >= 0 && fraction.length === 0) return null
  if (!/^[0-9]*$/.test(fraction)) return null
  let digits: string
  if (whole.includes(',')) {
    const groups = whole.split(',')
    const first = groups[0] ?? ''
    if (first.length < 1 || first.length > 3 || !/^[0-9]+$/.test(first)) return null
    for (const g of groups.slice(1)) if (g.length !== 3 || !/^[0-9]{3}$/.test(g)) return null
    digits = groups.join('')
  } else {
    if (!/^[0-9]*$/.test(whole)) return null
    digits = whole
  }
  if (digits === '' && fraction === '') return null
  return parseDecimal(`${negative ? '-' : ''}${digits === '' ? '0' : digits}${fraction === '' ? '' : `.${fraction}`}`)
}

/**
 * Turn one caller amount into an exact decimal. Strings are major units
 * ("12.34", or as a report prints them: "38,400", "$600.00", "(557)"); integer numbers and bigints are minor units (1234 is 12.34 at two
 * minor-unit digits). A non-integer number is a TypeError unless `allowFloat`
 * is set, and then every number is read as a major-unit decimal through its
 * shortest round-trip text.
 */
function readAmount(value: unknown, name: string, minorDigits: number, allowFloat: boolean): Dec {
  if (typeof value === 'string') {
    if (isDecimalString(value, 120)) return parseDecimal(value)
    const printed = parsePrinted(value)
    if (printed === null) {
      throw new TypeError(
        `${name} must be an exact amount such as "12.34", "38,400", "$600.00" or "(557)", got ${JSON.stringify(value.slice(0, 40))}.`,
      )
    }
    return printed
  }
  if (typeof value === 'bigint') return { n: value, s: minorDigits }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite number.`)
    if (allowFloat) {
      const text = String(value)
      const m = FLOAT_WITH_EXPONENT.exec(text)
      if (m === null) return parseDecimal(text)
      return fromParts(m[1] === '-', m[2] ?? '0', m[3] ?? '', Number(m[4]))
    }
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `${name} is ${String(value)}: floats are rejected because they are not exact. Pass a decimal string, or an integer in minor units (or set allowFloat).`,
      )
    }
    return { n: BigInt(value), s: minorDigits }
  }
  throw new TypeError(`${name} must be a decimal string, an integer or a bigint, got ${describe(value)}.`)
}

function readReconcileOptions(options: unknown): { minorDigits: number; allowFloat: boolean } {
  const o = readOptions(options, ['minorUnitDigits', 'allowFloat'] as const, 'reconcile')
  return {
    minorDigits: readInteger(o.minorUnitDigits, 'minorUnitDigits', 0, 8, 2),
    allowFloat: readBoolean(o.allowFloat, 'allowFloat', false),
  }
}

function finish(
  amounts: readonly Dec[],
  total: Dec,
  tolerance: Dec,
): ReconcileResult {
  if (tolerance.n < 0n) throw new RangeError('tolerance must not be negative.')
  let sum: Dec = { n: 0n, s: 0 }
  for (const a of amounts) sum = add(sum, a)
  const places = Math.max(sum.s, total.s)
  const diff = sub(sum, total)
  const absDiff = diff.n < 0n ? { n: -diff.n, s: diff.s } : diff
  return {
    ok: cmp(absDiff, tolerance) <= 0,
    sum: formatDec(sum, places),
    total: formatDec(total, places),
    difference: formatDec(diff, places),
    tolerance: formatDec(tolerance),
    rows: amounts.length,
  }
}

/**
 * Do these rows add up to this total? Exact decimal arithmetic, never floats.
 * Returns `ok: false` with the exact difference on a mismatch; throws on
 * malformed input rather than guessing.
 */
export function reconcile(input: ReconcileInput, options?: ReconcileOptions): ReconcileResult {
  const { minorDigits, allowFloat } = readReconcileOptions(options)
  const bag = readOptions(input, ['rows', 'total', 'tolerance'] as const, 'reconcile input')
  if (bag.rows === undefined) throw new TypeError('reconcile: rows is required.')
  if (bag.total === undefined) throw new TypeError('reconcile: total is required.')
  const rows = snapshotArray(bag.rows, 'rows')
  if (rows.length === 0) throw new RangeError('reconcile: rows is empty, so there is nothing to add up.')
  const amounts: Dec[] = []
  rows.forEach((row, i) => {
    if (!isRecord(row)) throw new TypeError(`rows[${i}] must be an object with label and amount.`)
    const label = row['label']
    const amount = row['amount']
    if (label !== undefined && typeof label !== 'string') throw new TypeError(`rows[${i}].label must be a string.`)
    amounts.push(readAmount(amount, `rows[${i}].amount`, minorDigits, allowFloat))
  })
  const total = readAmount(bag.total, 'total', minorDigits, allowFloat)
  const tolerance =
    bag.tolerance === undefined ? { n: 0n, s: 0 } : readAmount(bag.tolerance, 'tolerance', minorDigits, allowFloat)
  return finish(amounts, total, tolerance)
}

/**
 * A named identity such as `paid + reserve = incurred`: the parts must add up
 * to the total. Parts are the own enumerable string keys of `parts`.
 */
export function reconcileComponents(input: ReconcileComponentsInput, options?: ReconcileOptions): ReconcileResult {
  const { minorDigits, allowFloat } = readReconcileOptions(options)
  const bag = readOptions(input, ['parts', 'total', 'tolerance'] as const, 'reconcileComponents input')
  if (bag.parts === undefined) throw new TypeError('reconcileComponents: parts is required.')
  if (bag.total === undefined) throw new TypeError('reconcileComponents: total is required.')
  if (!isRecord(bag.parts) || Array.isArray(bag.parts)) throw new TypeError('parts must be an object of named amounts.')
  const parts = bag.parts
  const names = Object.keys(parts)
  if (names.length === 0) throw new RangeError('reconcileComponents: parts is empty, so there is nothing to add up.')
  const amounts: Dec[] = []
  for (const name of names) amounts.push(readAmount(parts[name], `parts.${name}`, minorDigits, allowFloat))
  const total = readAmount(bag.total, 'total', minorDigits, allowFloat)
  const tolerance =
    bag.tolerance === undefined ? { n: 0n, s: 0 } : readAmount(bag.tolerance, 'tolerance', minorDigits, allowFloat)
  return finish(amounts, total, tolerance)
}
