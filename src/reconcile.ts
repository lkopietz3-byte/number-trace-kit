import { add, cmp, formatDec, fromParts, isDecimalString, parseDecimal, sub } from './decimal.js'
import type { Dec } from './decimal.js'
import { describe, getOwn, isRecord, nearMiss, readBoolean, readInteger, readOptions, show, snapshotArray } from './input.js'
import type {
  ReconcileComponentsInput,
  ReconcileInput,
  ReconcileOptions,
  ReconcileResult,
} from './types.js'

const FLOAT_WITH_EXPONENT = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/

const CURRENCY_SIGNS = new Set(['$', '\u20ac', '\u00a3', '\u00a5', '\u20b9'])

const ROW_KEYS: readonly string[] = ['label', 'amount']

type Mark = '.' | ','

const GROUP_SPACES = new Set([' ', '\u00a0', '\u202f', "'"])

/**
 * An amount as a report prints it: an optional minus or plus, an optional currency sign, digits
 * with thousands groups (exactly three digits per group) and an optional decimal part, all of it
 * optionally inside accounting parentheses. With the mark `.`: "38,400", "$600.00", "(557)",
 * "-$557.50", ".5". With the mark `,` (a comma-decimal table): "38.400", "600,00 ", "1 234,50",
 * "(0,50)", "€ 1.234,50". Anything it cannot read exactly (a group in the wrong place, the other
 * mark twice, an exponent, other digit systems) is null. `sign` is the currency sign, if any.
 */
function parsePrinted(text: string, mark: Mark): { dec: Dec; sign?: string } | null {
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
  let currency: string | undefined
  if (s.length > 0 && CURRENCY_SIGNS.has(s[0] ?? '')) {
    currency = s[0]
    s = s.slice(1)
    // Comma-decimal tables print "\u20ac 1.234,50".
    if (mark === ',' && (s[0] === ' ' || s[0] === '\u00a0')) s = s.slice(1)
    if (!sign()) return null
  }
  // Comma-decimal tables also print the sign after the amount: "1.234,50 €".
  if (mark === ',' && s.length > 1 && CURRENCY_SIGNS.has(s[s.length - 1] ?? '')) {
    if (currency !== undefined) return null
    currency = s[s.length - 1]
    s = s.slice(0, -1)
    if (s.endsWith(' ') || s.endsWith('\u00a0') || s.endsWith('\u202f')) s = s.slice(0, -1)
  }
  const at = s.indexOf(mark)
  if (at >= 0 && s.indexOf(mark, at + 1) >= 0) return null
  const whole = at < 0 ? s : s.slice(0, at)
  const fraction = at < 0 ? '' : s.slice(at + 1)
  if (at >= 0 && fraction.length === 0) return null
  if (!/^[0-9]*$/.test(fraction)) return null
  const groupMark = mark === '.' ? ',' : '.'
  let digits: string
  // The marks that group digits: the other mark, and in a comma-decimal table a space or an apostrophe, one kind per number.
  let groupChar: string | undefined
  for (const c of whole) {
    if (c === groupMark || (mark === ',' && GROUP_SPACES.has(c))) {
      if (groupChar !== undefined && groupChar !== c) return null
      groupChar = c
    }
  }
  if (groupChar !== undefined) {
    const groups = whole.split(groupChar)
    const first = groups[0] ?? ''
    if (first.length < 1 || first.length > 3 || !/^[0-9]+$/.test(first)) return null
    // A thousands group never follows a leading zero: "0,125" is not 125 (it is 0.125 with a decimal comma).
    if (first.startsWith('0')) return null
    for (const g of groups.slice(1)) if (g.length !== 3 || !/^[0-9]{3}$/.test(g)) return null
    digits = groups.join('')
  } else {
    if (!/^[0-9]*$/.test(whole)) return null
    digits = whole
  }
  if (digits === '' && fraction === '') return null
  const dec = parseDecimal(`${negative ? '-' : ''}${digits === '' ? '0' : digits}${fraction === '' ? '' : `.${fraction}`}`)
  return currency === undefined ? { dec } : { dec, sign: currency }
}

/**
 * Turn one caller amount into an exact decimal. Strings are major units
 * ("12.34", or as a report prints them: "38,400", "$600.00", "(557)"); integer numbers and bigints are minor units (1234 is 12.34 at two
 * minor-unit digits). A non-integer number is a TypeError unless `allowFloat`
 * is set, and then every number is read as a major-unit decimal through its
 * shortest round-trip text.
 */
function readAmount(value: unknown, name: string, o: Read, signs?: Set<string>): Dec {
  const { minorDigits, allowFloat } = o
  if (typeof value === 'string') {
    // A plain "12.34" is the machine form; a table printed with a decimal comma is only ever read as printed.
    if (o.mark === '.' && isDecimalString(value, 120)) return parseDecimal(value)
    const printed = parsePrinted(value, o.mark)
    if (printed === null) {
      const hint =
        o.mark === '.' && value.includes(',')
          ? ' A table printed with a decimal comma needs decimalMark: ",".'
          : o.mark === ',' && isDecimalString(value, 120) && value.includes('.')
            ? ` With decimalMark ",", write the decimal mark as a comma (${JSON.stringify(value.replace('.', ','))}); a point groups digits.`
            : ''
      throw new TypeError(
        `${name} must be an exact amount such as "12.34", "38,400", "$600.00" or "(557)", got ${JSON.stringify(value.slice(0, 40))}.${hint}`,
      )
    }
    if (printed.sign !== undefined) signs?.add(printed.sign)
    return printed.dec
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

interface Read {
  readonly minorDigits: number
  readonly allowFloat: boolean
  readonly mark: Mark
}

function readReconcileOptions(options: unknown): Read {
  const o = readOptions(options, ['minorUnitDigits', 'allowFloat', 'decimalMark'] as const, 'reconcile')
  if (o.decimalMark !== undefined && o.decimalMark !== '.' && o.decimalMark !== ',') {
    throw new RangeError('decimalMark must be "." or ",".')
  }
  return {
    minorDigits: readInteger(o.minorUnitDigits, 'minorUnitDigits', 0, 8, 2),
    allowFloat: readBoolean(o.allowFloat, 'allowFloat', false),
    mark: o.decimalMark === ',' ? ',' : '.',
  }
}

/** Amounts in two currencies are not one sum. */
function checkSigns(signs: ReadonlySet<string>): void {
  if (signs.size > 1) {
    throw new TypeError(`reconcile: the amounts mix currency signs (${[...signs].join(' and ')}); add up one currency at a time.`)
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
  const read = readReconcileOptions(options)
  const bag = readOptions(input, ['rows', 'total', 'tolerance'] as const, 'reconcile input')
  if (bag.rows === undefined) throw new TypeError('reconcile: rows is required.')
  if (bag.total === undefined) throw new TypeError('reconcile: total is required.')
  const rows = snapshotArray(bag.rows, 'rows')
  if (rows.length === 0) throw new RangeError('reconcile: rows is empty, so there is nothing to add up.')
  const amounts: Dec[] = []
  const signs = new Set<string>()
  rows.forEach((row, i) => {
    if (!isRecord(row) || describe(row) !== 'object') throw new TypeError(`rows[${i}] must be an object with label and amount, got ${describe(row)}.`)
    const written = Object.keys(row)
    for (const key of written) {
      const meant = nearMiss(key, ROW_KEYS, written)
      if (meant !== undefined) throw new RangeError(`rows[${i}]: unknown key ${show(key)}, did you mean "${meant}"? Known keys: label, amount.`)
    }
    const label = getOwn(row, 'label')
    const amount = getOwn(row, 'amount')
    if (typeof label !== 'string') throw new TypeError(`rows[${i}].label must be a string, got ${describe(label)}.`)
    amounts.push(readAmount(amount, `rows[${i}].amount`, read, signs))
  })
  const total = readAmount(bag.total, 'total', read, signs)
  checkSigns(signs)
  const tolerance = bag.tolerance === undefined ? { n: 0n, s: 0 } : readAmount(bag.tolerance, 'tolerance', read)
  return finish(amounts, total, tolerance)
}

/**
 * A named identity such as `paid + reserve = incurred`: the parts must add up
 * to the total. Parts are the own enumerable string keys of `parts`.
 */
export function reconcileComponents(input: ReconcileComponentsInput, options?: ReconcileOptions): ReconcileResult {
  const read = readReconcileOptions(options)
  const bag = readOptions(input, ['parts', 'total', 'tolerance'] as const, 'reconcileComponents input')
  if (bag.parts === undefined) throw new TypeError('reconcileComponents: parts is required.')
  if (bag.total === undefined) throw new TypeError('reconcileComponents: total is required.')
  if (!isRecord(bag.parts) || Array.isArray(bag.parts)) throw new TypeError('parts must be an object of named amounts.')
  const parts = bag.parts
  const names = Object.keys(parts)
  if (names.length === 0) throw new RangeError('reconcileComponents: parts is empty, so there is nothing to add up.')
  const amounts: Dec[] = []
  const signs = new Set<string>()
  for (const name of names) amounts.push(readAmount(parts[name], `parts[${show(name)}]`, read, signs))
  const total = readAmount(bag.total, 'total', read, signs)
  checkSigns(signs)
  const tolerance = bag.tolerance === undefined ? { n: 0n, s: 0 } : readAmount(bag.tolerance, 'tolerance', read)
  return finish(amounts, total, tolerance)
}
