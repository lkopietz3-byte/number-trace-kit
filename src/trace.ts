import {
  MAX_DIGITS,
  absKey,
  formatDec,
  isDecimalString,
  isNegativeValue,
  mantissaAt,
  parseDecimal,
  pow10,
  ratAdd,
  ratDiv,
  ratMul,
  ratSub,
  roundRat,
  toRat,
} from './decimal.js'
import type { Dec, Rat } from './decimal.js'
import { NumberLimitError, scan, skippedFormsOf } from './extract.js'
import type { SkipRecord } from './extract.js'
import {
  MAX_TEXT_LENGTH,
  describe,
  getOwn,
  isRecord,
  nearMiss,
  noProto,
  readBoolean,
  readInteger,
  readOptions,
  show,
  snapshotArray,
} from './input.js'
import { resolveLocale } from './locale.js'
import type { LocaleInfo } from './locale.js'
import type {
  AmbiguityReason,
  Derivation,
  DerivationDetail,
  EvidenceInput,
  EvidenceRef,
  NearMiss,
  NumberKind,
  NumberToken,
  NumberTrace,
  Reading,
  Preset,
  RoundingMode,
  SignMode,
  SkippedNumber,
  TraceCounts,
  TraceOptions,
  TraceResult,
  TraceStatus,
} from './types.js'

const KINDS: readonly NumberKind[] = ['percent', 'currency', 'count', 'decimal', 'year', 'date-part', 'time', 'ordinal']
const AMBIGUITIES: readonly AmbiguityReason[] = ['separator', 'suffix', 'superscript', 'date-order', 'fraction', 'identifier', 'too-long', 'magnitude', 'currency', 'meridiem', 'date', 'sign']
/** The keys an evidence document may have. */
const DOCUMENT_KEYS: readonly string[] = ['id', 'text', 'scale', 'currency', 'scaleApplies']
const DERIVATIONS: readonly Derivation[] = ['sum', 'difference', 'ratio', 'percent-change', 'percent-of', 'average', 'product']
const DATE_PARTS = ['year', 'month', 'day', 'hour', 'minute', 'second']
const MAX_LIST = 8
const MAX_EVIDENCE_TOTAL = 50_000_000
/** Most numbers the evidence may hold. Each costs on the order of a kilobyte of heap, so this keeps a hostile text from aborting the process. */
const MAX_EVIDENCE_NUMBERS = 500_000
const DEFAULT_MAX_CANDIDATES = 5_000
const WINDOW_BEFORE = 32
const WINDOW_AFTER = 16

/** One number found in the evidence, ready to be matched. */
interface Ent {
  /** Match class: `plain`, `pct`, `pp`, `cur:XXX` or `date`. */
  readonly cls: string
  /** Measurement unit for `plain`, date part for `date`, otherwise empty. */
  readonly unit: string
  readonly neg: boolean
  readonly key: string
  readonly dec: Dec
  readonly scale: number
  readonly ref: EvidenceRef
  readonly token: NumberToken
}

/** Two-level index for whole-group keys, so a long slash chain's text is hashed once, not per member. */
class GroupIndex {
  private readonly map = new Map<string, Map<string, Ent[]>>()
  add(group: string, key: string, ent: Ent): void {
    let inner = this.map.get(group)
    if (inner === undefined) {
      inner = new Map()
      this.map.set(group, inner)
    }
    const list = inner.get(key)
    if (list === undefined) inner.set(key, [ent])
    else if (list.length < MAX_LIST) list.push(ent)
  }
  get(group: string, key: string): Ent[] | undefined {
    return this.map.get(group)?.get(key)
  }
}

class Index {
  private readonly map = new Map<string, Ent[]>()
  add(key: string, ent: Ent): void {
    const list = this.map.get(key)
    if (list === undefined) this.map.set(key, [ent])
    else if (list.length < MAX_LIST) list.push(ent)
  }
  get(key: string): Ent[] | undefined {
    return this.map.get(key)
  }
}

function entKey(cls: string, unit: string, neg: boolean, key: string): string {
  return `${cls}\u0000${unit}\u0000${neg ? '-' : '+'}${key}`
}

interface Shape {
  readonly cls: string
  readonly unit: string
}

function shapeOf(t: NumberToken): Shape {
  // A rate ("$29/month", "25 mg/kg") is a class of its own: the denominator is part of the quantity.
  const rate = t.rate ?? ''
  if (t.kind === 'percent') return { cls: `${t.unit === 'pp' ? 'pp' : 'pct'}${rate}`, unit: '' }
  if (t.kind === 'currency') return { cls: `cur:${t.currency ?? ''}${rate}`, unit: '' }
  if (t.kind === 'date-part') return { cls: 'date', unit: t.part ?? '' }
  // A time of day (minutes since midnight) matches only another time of day, never a count.
  if (t.kind === 'time') return { cls: 'time', unit: '' }
  return { cls: 'plain', unit: `${t.unit ?? ''}${rate}` }
}

/** Keys a number is filed under: its own unit, and `*` so a unit-less output can find it. */
function regKeys(cls: string, unit: string): string[] {
  return cls === 'plain' ? (unit === '' ? ['', '*'] : [unit, '*']) : [unit]
}

/** Keys an output number looks under: evidence with its unit, and evidence with no unit at all. */
function lookupKeys(cls: string, unit: string): string[] {
  return cls === 'plain' ? (unit === '' ? ['*'] : [unit, '']) : [unit]
}

function refOf(id: string, t: NumberToken): EvidenceRef {
  return { id, raw: t.raw, start: t.start, end: t.end }
}

// ---- validating tokens supplied by the caller ---------------------------------------------------

function readString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string, got ${describe(value)}.`)
  return value
}

function readOptionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : readString(value, name)
}

/** Copy a caller-supplied token into a validated snapshot. Every field is read once. */
function readToken(item: Record<string, unknown>, name: string, evidence = false): { token: NumberToken; evidenceId?: string } {
  const rawValue = getOwn(item, 'raw')
  // An evidence item with neither text nor raw is most likely a document that lost its text.
  if (evidence && rawValue === undefined && getOwn(item, 'id') !== undefined) {
    throw new TypeError(`${name} has an id but no text: a document is { id, text }, a number token has raw, start, end, value, scale, kind and ambiguous.`)
  }
  const raw = readString(rawValue, `${name}.raw`)
  const start = getOwn(item, 'start')
  const end = getOwn(item, 'end')
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0) throw new TypeError(`${name}.start must be a non-negative integer.`)
  if (typeof end !== 'number' || !Number.isSafeInteger(end) || end < start) throw new TypeError(`${name}.end must be an integer at or after start.`)
  const value = readString(getOwn(item, 'value'), `${name}.value`)
  const scale = getOwn(item, 'scale')
  if (typeof scale !== 'number' || !Number.isInteger(scale) || scale < -100 || scale > 400) throw new TypeError(`${name}.scale must be an integer.`)
  const kind = getOwn(item, 'kind')
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) throw new TypeError(`${name}.kind is not a known kind.`)
  const ambiguous = getOwn(item, 'ambiguous')
  if (typeof ambiguous !== 'boolean') throw new TypeError(`${name}.ambiguous must be a boolean.`)
  const ambiguity = getOwn(item, 'ambiguity')
  if (ambiguity !== undefined && (typeof ambiguity !== 'string' || !(AMBIGUITIES as readonly string[]).includes(ambiguity))) {
    throw new TypeError(`${name}.ambiguity is not a known reason.`)
  }
  if (!isDecimalString(value, MAX_TEXT_LENGTH)) throw new TypeError(`${name}.value must be an exact decimal string.`)
  // The flags must agree with each other: an ambiguity reason is what makes a token ambiguous.
  if (ambiguous !== (ambiguity !== undefined)) {
    throw new TypeError(`${name}: ambiguous (${String(ambiguous)}) and ambiguity (${String(ambiguity)}) disagree.`)
  }
  // The 60-digit policy holds whatever the caller's flags say.
  const tooLong = ambiguity === 'too-long' || value.length - (value.startsWith('-') || value.startsWith('+') ? 1 : 0) - (value.includes('.') ? 1 : 0) > MAX_DIGITS
  const unit = readOptionalString(getOwn(item, 'unit'), `${name}.unit`)
  const currency = readOptionalString(getOwn(item, 'currency'), `${name}.currency`)
  if (kind === 'currency' && currency === undefined) throw new TypeError(`${name}.currency is required for currency tokens.`)
  if (currency !== undefined && (currency.length === 0 || currency.length > 8 || currency !== currency.toUpperCase())) {
    throw new TypeError(`${name}.currency must be a currency code in capitals such as "USD", or a currency symbol.`)
  }
  const signStyle = getOwn(item, 'signStyle')
  if (signStyle !== undefined && signStyle !== 'minus' && signStyle !== 'plus' && signStyle !== 'parentheses') {
    throw new TypeError(`${name}.signStyle is not valid.`)
  }
  const rate = readOptionalString(getOwn(item, 'rate'), `${name}.rate`)
  if (rate !== undefined && (rate.length < 2 || rate.length > 40 || rate.charCodeAt(0) !== 0x2f || (kind !== 'percent' && kind !== 'currency' && unit === undefined))) {
    throw new TypeError(`${name}.rate must be a denominator such as "/month" or "/kg/day" on a percent, a currency amount or a number with a unit.`)
  }
  const part = getOwn(item, 'part')
  if (part !== undefined && (typeof part !== 'string' || !DATE_PARTS.includes(part))) throw new TypeError(`${name}.part is not valid.`)
  const groupRaw = readOptionalString(getOwn(item, 'groupRaw'), `${name}.groupRaw`)
  const range = getOwn(item, 'range')
  if (range !== undefined && range !== 'start' && range !== 'end') throw new TypeError(`${name}.range is not valid.`)
  const alternatesRaw = getOwn(item, 'alternates')
  const alternates: Reading[] = []
  if (alternatesRaw !== undefined) {
    const list = snapshotArray(alternatesRaw, `${name}.alternates`)
    // A form can be read several ways at once (an en dash that may be a minus, a separator, a magnitude letter): at most 12.
    if (list.length > 12) throw new TypeError(`${name}.alternates has too many readings.`)
    list.forEach((alt, k) => {
      if (!isRecord(alt)) throw new TypeError(`${name}.alternates[${k}] must be an object.`)
      const altValue = readString(getOwn(alt, 'value'), `${name}.alternates[${k}].value`)
      const altScale = getOwn(alt, 'scale')
      if (!isDecimalString(altValue, MAX_DIGITS + 2) || typeof altScale !== 'number' || !Number.isInteger(altScale) || altScale < -100 || altScale > 400) {
        throw new TypeError(`${name}.alternates[${k}] is not a valid reading.`)
      }
      alternates.push({ value: altValue, scale: altScale })
    })
  }
  if (alternates.length > 0 && !ambiguous) throw new TypeError(`${name}: alternates need ambiguous: true.`)
  const localeGuess = getOwn(item, 'localeGuess')
  if (localeGuess !== undefined && localeGuess !== true) throw new TypeError(`${name}.localeGuess must be true when present.`)
  if (localeGuess === true && !ambiguous) throw new TypeError(`${name}: localeGuess needs ambiguous: true.`)
  const parenthesized = getOwn(item, 'parenthesized')
  if (parenthesized !== undefined && parenthesized !== true) throw new TypeError(`${name}.parenthesized must be true when present.`)
  if (parenthesized === true && (signStyle !== undefined || value.startsWith('-'))) {
    throw new TypeError(`${name}: parenthesized is for a bare number read as positive; it cannot also be signed.`)
  }
  const magnitude = getOwn(item, 'magnitude')
  if (magnitude !== undefined && (typeof magnitude !== 'number' || !Number.isInteger(magnitude) || magnitude === 0 || magnitude < -400 || magnitude > 400)) {
    throw new TypeError(`${name}.magnitude must be a non-zero integer.`)
  }
  const evidenceId = readOptionalString(getOwn(item, 'evidenceId'), `${name}.evidenceId`)
  const token: NumberToken = noProto({
    raw, start, end, value, scale, kind: kind as NumberKind, ambiguous: ambiguous || tooLong,
    ...(tooLong ? { ambiguity: 'too-long' as const } : ambiguity !== undefined ? { ambiguity: ambiguity as AmbiguityReason } : {}),
    ...(unit !== undefined ? { unit } : {}),
    ...(rate !== undefined ? { rate } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(signStyle !== undefined ? { signStyle } : {}),
    ...(part !== undefined ? { part: part as NonNullable<NumberToken['part']> } : {}),
    ...(parenthesized === true ? { parenthesized: true as const } : {}),
    ...(magnitude !== undefined ? { magnitude } : {}),
    ...(groupRaw !== undefined ? { groupRaw } : {}),
    ...(range !== undefined ? { range } : {}),
    ...(localeGuess === true ? { localeGuess: true as const } : {}),
    ...(alternates.length > 0 && !tooLong ? { alternates } : {}),
  })
  // No prototype: a missing evidenceId must read as absent, not as something planted on Object.prototype.
  return noProto({ token, ...(evidenceId !== undefined ? { evidenceId } : {}) })
}

// ---- options ----------------------------------------------------------------------------------------

interface Ctx {
  readonly loc: LocaleInfo
  readonly evLoc: LocaleInfo
  readonly parenNeg: boolean
  readonly derivations: ReadonlySet<Derivation>
  readonly modes: readonly RoundingMode[]
  readonly maxCandidates: number
  readonly maxOperands: 2 | 3
  readonly signMode: SignMode
  readonly allowBare: boolean
  readonly allowBareOut: boolean
  readonly maxMatches: number
  readonly maxDensity: number
  readonly roundSums: boolean
  readonly newestFirst: boolean
  readonly evScale: number
  readonly evCurrency: string | undefined
  /** Apply the evidence scale to cells that print a currency, not only to bare cells. */
  readonly evScaleCurrency: boolean
  readonly ignoreRaw: ReadonlySet<string>
  readonly ignoreKeys: ReadonlySet<string>
  readonly ignoreKinds: ReadonlySet<NumberKind>
  readonly ignoreYears: boolean
  readonly ignoreSmall: number
  readonly ignoreStructure: boolean
  readonly maxEvidenceNumbers: number
  readonly maxOutputNumbers: number
  readonly checkIdentifiers: boolean
  readonly pattern: RegExp | null
}

/**
 * Is the number written as negative? Zero keeps the sign it was written with, so
 * "-0.00%" is negative and rounds from "-0.004%" and not from "0.004%".
 */
/** A plain number with no unit: a count. */
function isCount(e: Ent): boolean {
  return e.cls === 'plain' && e.unit === ''
}

function writtenNegative(value: string, signStyle: NumberToken['signStyle']): boolean {
  return isNegativeValue(value) || signStyle === 'minus' || signStyle === 'parentheses'
}

function numberToDecimalString(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError('ignore: numbers must be finite.')
  const text = String(n)
  if (text.includes('e')) throw new RangeError(`ignore: ${text} is too large or too small; pass it as a string.`)
  return text
}

/** Canonical text of a decimal including its sign (zero has none). */
function signedKey(value: string): string {
  return `${isNegativeValue(value) ? '-' : ''}${absKey(value)}`
}

// The built-in getters, captured once. Each throws TypeError for anything that is not a real
// RegExp (a look-alike, a Proxy, an object that only inherits from RegExp.prototype).
type Getter = (this: unknown) => unknown

function captureGetter(name: string): Getter | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, name)
  // eslint-disable-next-line @typescript-eslint/unbound-method -- the getter is only ever called through Reflect.apply
  return descriptor?.get as Getter | undefined
}

const FLAG_GETTERS: ReadonlyArray<readonly [string, Getter | undefined]> = [
  ['d', captureGetter('hasIndices')], ['g', captureGetter('global')], ['i', captureGetter('ignoreCase')],
  ['m', captureGetter('multiline')], ['s', captureGetter('dotAll')], ['u', captureGetter('unicode')],
  ['v', captureGetter('unicodeSets')], ['y', captureGetter('sticky')],
]
const REGEXP_SOURCE = captureGetter('source')

/** Source and flags of a genuine RegExp, read through the built-in getters, not through its own properties. */
function regExpParts(value: unknown): { source: string; flags: string } {
  if (REGEXP_SOURCE === undefined || value === RegExp.prototype) throw new TypeError('ignorePattern must be a RegExp.')
  try {
    const source = Reflect.apply(REGEXP_SOURCE, value, []) as string
    let flags = ''
    for (const [letter, getter] of FLAG_GETTERS) {
      if (getter !== undefined && Reflect.apply(getter, value, []) === true) flags += letter
    }
    return { source, flags }
  } catch {
    throw new TypeError('ignorePattern must be a RegExp.')
  }
}

/** A finite positive number option. */
function readNumberAtLeast(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number, got ${describe(value)}.`)
  if (value <= 0) throw new RangeError(`${name} must be greater than 0.`)
  return value
}

const SCALE_WORDS: Readonly<Record<string, number>> = { thousand: 3, million: 6, billion: 9, trillion: 12 }

/** An evidence scale as an exponent of ten, 0 to 12. */
function scaleExponent(value: unknown, name: string): number {
  if (typeof value === 'string') {
    const e = Object.hasOwn(SCALE_WORDS, value) ? SCALE_WORDS[value] : undefined
    if (e === undefined) throw new RangeError(`${name} ${show(value)} is not one of thousand, million, billion, trillion or an exponent of ten.`)
    return e
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 12) return value
  throw new RangeError(`${name} must be thousand, million, billion, trillion or an exponent of ten from 0 to 12.`)
}

/** `scaleApplies`: `'bare'` (the default) scales only bare cells, `'bare-and-currency'` also the cells that print a currency. */
function scaleAppliesFlag(value: unknown, name: string): boolean {
  if (value === 'bare') return false
  if (value === 'bare-and-currency') return true
  throw new RangeError(`${name} must be "bare" or "bare-and-currency".`)
}

function currencyCode(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw new RangeError(`${name} must be a three-letter currency code such as "USD".`)
  return value
}

const PRESETS: Readonly<Record<Preset, Readonly<Record<string, unknown>>>> = {
  strict: {},
  report: {
    derivations: ['sum', 'difference', 'ratio', 'percent-change', 'percent-of', 'average', 'product'],
    roundSums: true,
    allowBareEvidence: true,
    allowBareOutput: true,
    maxCandidates: 50_000,
    maxDerivationMatches: 3,
  },
}

function readContext(options: unknown): Ctx {
  const raw = readOptions(
    options,
    [
      'preset', 'locale', 'evidenceLocale', 'parenthesesAreNegative', 'derivations', 'rounding', 'maxCandidates', 'maxOperands', 'maxEvidenceNumbers',
      'maxDerivationMatches', 'maxDerivationDensity', 'roundSums', 'evidenceOrder', 'evidenceScale', 'evidenceCurrency', 'evidenceScaleApplies', 'allowBareOutput',
      'allowBareEvidence', 'signMode', 'ignore', 'ignoreKinds', 'ignoreYears', 'ignoreSmallIntegersUpTo', 'ignoreStructure', 'ignorePattern',
      'checkIdentifiers', 'maxOutputNumbers',
    ] as const,
    'traceNumbers',
  )
  if (raw.preset !== undefined && raw.preset !== 'strict' && raw.preset !== 'report') {
    throw new RangeError('preset must be "strict" or "report".')
  }
  // The preset supplies defaults; anything passed explicitly wins.
  const base = PRESETS[raw.preset ?? 'strict']
  const o = noProto({ ...base })
  for (const [k, v] of Object.entries(raw)) if (v !== undefined && k !== 'preset') o[k] = v
  const loc = resolveLocale(o['locale'])
  const evLoc = o['evidenceLocale'] === undefined ? loc : resolveLocale(o['evidenceLocale'], 'evidenceLocale')
  const parenNeg = readBoolean(o['parenthesesAreNegative'], 'parenthesesAreNegative', true)

  const derivations = new Set<Derivation>()
  if (o['derivations'] !== undefined) {
    for (const d of snapshotArray(o['derivations'], 'derivations')) {
      if (typeof d !== 'string' || !(DERIVATIONS as readonly string[]).includes(d)) {
        throw new RangeError(`derivations: ${show(d)} is not one of ${DERIVATIONS.join(', ')}.`)
      }
      derivations.add(d as Derivation)
    }
  }
  let modes: RoundingMode[] = ['half-up', 'half-even']
  if (o['rounding'] !== undefined) {
    const picked = new Set<RoundingMode>()
    for (const m of snapshotArray(o['rounding'], 'rounding')) {
      if (m !== 'half-up' && m !== 'half-even') throw new RangeError('rounding: modes are "half-up" and "half-even".')
      picked.add(m)
    }
    modes = [...picked]
  }
  const maxCandidates = readInteger(o['maxCandidates'], 'maxCandidates', 1, 1_000_000, DEFAULT_MAX_CANDIDATES)
  const maxEvidenceNumbers = readInteger(o['maxEvidenceNumbers'], 'maxEvidenceNumbers', 1, MAX_EVIDENCE_NUMBERS, MAX_EVIDENCE_NUMBERS)
  const maxOutputNumbers = readInteger(o['maxOutputNumbers'], 'maxOutputNumbers', 1, MAX_EVIDENCE_NUMBERS, MAX_EVIDENCE_NUMBERS)
  const checkIdentifiers = readBoolean(o['checkIdentifiers'], 'checkIdentifiers', false)
  const maxOperands = readInteger(o['maxOperands'], 'maxOperands', 2, 3, 2) as 2 | 3
  const signMode = o['signMode'] === undefined ? 'explicit' : o['signMode']
  if (signMode !== 'explicit' && signMode !== 'magnitude' && signMode !== 'strict') {
    throw new RangeError('signMode must be "explicit", "magnitude" or "strict".')
  }

  const allowBare = readBoolean(o['allowBareEvidence'], 'allowBareEvidence', false)
  const allowBareOut = readBoolean(o['allowBareOutput'], 'allowBareOutput', false)
  const maxMatches = readInteger(o['maxDerivationMatches'], 'maxDerivationMatches', 1, 1_000_000, 3)
  const maxDensity = readNumberAtLeast(o['maxDerivationDensity'], 'maxDerivationDensity', 0.5)
  const roundSums = readBoolean(o['roundSums'], 'roundSums', false)
  const order = o['evidenceOrder'] === undefined ? 'oldest-first' : o['evidenceOrder']
  if (order !== 'oldest-first' && order !== 'newest-first') throw new RangeError('evidenceOrder must be "oldest-first" or "newest-first".')
  const evScale = o['evidenceScale'] === undefined ? 0 : scaleExponent(o['evidenceScale'], 'evidenceScale')
  const evCurrency = o['evidenceCurrency'] === undefined ? undefined : currencyCode(o['evidenceCurrency'], 'evidenceCurrency')
  const evScaleCurrency = o['evidenceScaleApplies'] === undefined ? false : scaleAppliesFlag(o['evidenceScaleApplies'], 'evidenceScaleApplies')
  const ignoreRaw = new Set<string>()
  const ignoreKeys = new Set<string>()
  if (o['ignore'] !== undefined) {
    for (const entry of snapshotArray(o['ignore'], 'ignore')) {
      if (typeof entry === 'string') ignoreRaw.add(entry.trim())
      else if (typeof entry === 'number') ignoreKeys.add(signedKey(numberToDecimalString(entry)))
      else throw new TypeError('ignore entries must be strings or numbers.')
    }
  }
  const ignoreKinds = new Set<NumberKind>()
  if (o['ignoreKinds'] !== undefined) {
    for (const k of snapshotArray(o['ignoreKinds'], 'ignoreKinds')) {
      if (typeof k !== 'string' || !(KINDS as readonly string[]).includes(k)) throw new RangeError(`ignoreKinds: ${show(k)} is not a kind.`)
      ignoreKinds.add(k as NumberKind)
    }
  }
  const ignoreYears = readBoolean(o['ignoreYears'], 'ignoreYears', false)
  const ignoreSmall = readInteger(o['ignoreSmallIntegersUpTo'], 'ignoreSmallIntegersUpTo', 0, 1_000_000, -1)
  const ignoreStructure = readBoolean(o['ignoreStructure'], 'ignoreStructure', false)

  let pattern: RegExp | null = null
  if (o['ignorePattern'] !== undefined) {
    const p = o['ignorePattern']
    const { source, flags } = regExpParts(p)
    // A private native copy: global (so we can walk matches), never sticky, no shared lastIndex.
    const clean = flags.replace(/[gy]/g, '')
    pattern = new RegExp(source, `${clean}g`)
  }
  return {
    loc, evLoc, parenNeg, derivations, modes, maxCandidates, maxOperands, signMode, allowBare, allowBareOut, maxMatches, maxDensity,
    roundSums, newestFirst: order === 'newest-first', evScale, evCurrency, evScaleCurrency,
    ignoreRaw, ignoreKeys, ignoreKinds, ignoreYears, ignoreSmall, ignoreStructure, maxEvidenceNumbers, maxOutputNumbers, checkIdentifiers, pattern,
  }
}

// ---- evidence ---------------------------------------------------------------------------------------------

interface Evidence {
  readonly strong: Index
  readonly weak: Index
  /** Date parts with a known role, by role and value. Lives in `strong`. */
  readonly groupRaw: GroupIndex
  readonly dateAny: Index
  readonly dateUnknown: Index
  readonly byValue: Index
  readonly all: Ent[]
  readonly weakAll: Ent[]
  /** Every whole date in the evidence, under each subset of its parts (year, month, day, hour, minute, second). */
  readonly dateKeys: Map<string, EvidenceRef[]>
  /** The text of every stretch the scanner passed over in the evidence (identifiers and unread forms), to vouch for the same text in the output. */
  readonly forms: Set<string>
  readonly count: number
}

/**
 * The class a rated percent or amount ("$2.15 per share", "5%/yr") shares with the same figure written without its
 * rate. Two different rates never match each other, but a figure restated without its rate ("EPS was $2.15") or
 * given a rate the evidence leaves unsaid ("$50 per month" for "$50 a month") still traces.
 */
function unratedClass(e: Ent): string | undefined {
  const rate = e.token.rate
  if (rate === undefined || e.cls.length <= rate.length || !e.cls.endsWith(rate)) return undefined
  return e.cls.startsWith('cur:') || e.cls.startsWith('pct') || e.cls.startsWith('pp') ? e.cls.slice(0, e.cls.length - rate.length) : undefined
}

function addEnt(ev: Evidence, ent: Ent, weak: boolean): void {
  const target = weak ? ev.weak : ev.strong
  for (const u of regKeys(ent.cls, ent.unit)) target.add(entKey(ent.cls, u, ent.neg, ent.key), ent)
  const unrated = unratedClass(ent)
  if (unrated !== undefined) target.add(entKey(unrated, '', ent.neg, ent.key), ent)
  // For allowBareOutput: a bare output number may match an amount in any currency.
  if (ent.cls.startsWith('cur:')) target.add(entKey('curany', '', ent.neg, ent.key), ent)
  if (weak) {
    ev.weakAll.push(ent)
  } else {
    ev.all.push(ent)
    ev.byValue.add(ent.key, ent)
    // A bare "(557)" is read as positive but may be an accounting negative: it also answers to a minus sign.
    if (ent.token.parenthesized === true && !ent.neg) {
      for (const u of regKeys(ent.cls, ent.unit)) ev.strong.add(entKey(ent.cls, u, true, ent.key), { ...ent, neg: true })
    }
  }
}

/**
 * A number whose separator does not fit the locale ("12,5" read as en-US) has
 * one reading and no alternates, but that reading is a guess about locale.
 * It may only ever produce `unknown`, never a trace.
 */
function weakPrimary(t: NumberToken): boolean {
  if (t.localeGuess === true) return true
  return (
    t.ambiguous && (t.ambiguity === 'fraction' || t.ambiguity === 'identifier' || t.ambiguity === 'magnitude' || t.ambiguity === 'currency' || t.ambiguity === 'date' || t.ambiguity === 'sign' || t.ambiguity === 'separator') &&
    (t.ambiguity !== 'separator' || t.alternates === undefined || t.alternates.length === 0)
  )
}

function ingest(ev: Evidence, token: NumberToken, id: string): void {
  if (token.ambiguity === 'superscript' || token.ambiguity === 'too-long') return
  const shape = shapeOf(token)
  const primary = makeEnt(token, shape, token.value, token.scale, id)
  if (primary === null) return
  if (token.kind === 'date-part') {
    if (token.part === undefined) {
      // Day/month order unknown: only an identical date text can vouch for it.
      ev.dateAny.add(primary.key, primary)
      ev.dateUnknown.add(primary.key, primary)
      if (token.groupRaw !== undefined) ev.groupRaw.add(token.groupRaw, primary.key, primary)
      return
    }
    ev.dateAny.add(primary.key, primary)
    addEnt(ev, primary, false)
    if (token.groupRaw !== undefined) ev.groupRaw.add(token.groupRaw, primary.key, primary)
    if (token.part === 'year') {
      // A year inside a date can vouch for a bare year elsewhere.
      const asPlain = makeEnt(noProto({ ...token, kind: 'year' as const }), { cls: 'plain', unit: '' }, token.value, token.scale, id)
      if (asPlain !== null) addEnt(ev, asPlain, false)
    }
    return
  }
  addEnt(ev, primary, weakPrimary(token))
  if (token.groupRaw !== undefined) ev.groupRaw.add(token.groupRaw, primary.key, primary)
  for (const alt of token.alternates ?? []) {
    const ent = makeEnt(token, shape, alt.value, alt.scale, id)
    if (ent !== null) addEnt(ev, ent, true)
  }
}

function makeEnt(token: NumberToken, shape: Shape, value: string, scale: number, id: string): Ent | null {
  const dec = parseDecimal(value)
  const abs = dec.n < 0n ? { n: -dec.n, s: dec.s } : dec
  return {
    cls: shape.cls, unit: shape.unit, neg: writtenNegative(value, token.signStyle), key: absKey(value), dec: abs, scale,
    ref: refOf(id, token), token,
  }
}

// ---- whole dates -------------------------------------------------------------------------------

const DATE_LETTER: Readonly<Record<string, string>> = { year: 'y', month: 'm', day: 'd', hour: 'H', minute: 'M', second: 'S' }

/** One whole date or time: its parts as strings such as `y2025|m6|d30`, and the tokens they were read from. */
interface DateTuple {
  readonly parts: readonly string[]
  readonly tokens: readonly NumberToken[]
}

/**
 * The whole dates and times in a run of date-part tokens written together (one `groupRaw`):
 * one tuple per day (or one for the month, or for the time).
 */
function dateTuples(cluster: readonly NumberToken[]): DateTuple[] {
  const get = (part: string): NumberToken[] => cluster.filter((t) => t.part === part)
  const letter = (t: NumberToken): string => `${DATE_LETTER[t.part ?? ''] ?? '?'}${absKey(t.value)}`
  const hours = get('hour')
  if (hours.length > 0) {
    const used = [hours[0], ...get('minute').slice(0, 1), ...get('second').slice(0, 1)].filter((t): t is NumberToken => t !== undefined)
    return [{ parts: used.map(letter), tokens: used }]
  }
  const shared = [...get('year').slice(0, 1), ...get('month').slice(0, 1)]
  const days = get('day')
  if (days.length > 0) {
    // The year and month keys are computed once, not once per day: a part's key costs time
    // proportional to its length, and a caller token may carry a very long value.
    const sharedParts = shared.map(letter)
    return days.map((d) => ({ parts: [...sharedParts, letter(d)], tokens: [...shared, d] }))
  }
  if (shared.some((t) => t.part === 'month')) return [{ parts: shared.map(letter), tokens: shared }]
  return []
}

/** Maximal runs of date-part tokens (with a known role) that were written as one date. */
function dateClusters(tokens: readonly NumberToken[]): NumberToken[][] {
  const out: NumberToken[][] = []
  let cur: NumberToken[] = []
  for (const t of tokens) {
    if (t.kind === 'date-part' && t.part !== undefined && t.groupRaw !== undefined) {
      if (cur.length > 0 && cur[0]?.groupRaw === t.groupRaw) cur.push(t)
      else {
        cur = [t]
        out.push(cur)
      }
    } else {
      cur = []
    }
  }
  return out
}

function tupleKey(tuple: readonly string[]): string {
  return tuple.join('|')
}

/** Record a whole date under every non-empty subset of its parts, so a less specific date can find it. */
function addDateKeys(store: Map<string, EvidenceRef[]>, tuple: readonly string[], ref: EvidenceRef): void {
  const n = tuple.length
  for (let mask = 1; mask < 1 << n; mask++) {
    const sub: string[] = []
    for (let i = 0; i < n; i++) if (mask & (1 << i)) sub.push(tuple[i] ?? '')
    const k = tupleKey(sub)
    const list = store.get(k)
    if (list === undefined) store.set(k, [ref])
    else if (list.length < MAX_LIST) list.push(ref)
  }
}

/** An evidence number with the document's declared scale and currency applied to a bare table cell. */
function applyHints(token: NumberToken, exp: number, currency: string | undefined, scaleCurrency: boolean): NumberToken {
  // Nothing is parsed for a token that is excluded, or for one that says its own magnitude (3 million, 4K, 5e-3).
  if (exp === 0 && currency === undefined) return token
  if (token.ambiguity === 'too-long' || token.ambiguity === 'superscript') return token
  const plain = token.unit === undefined && token.scale >= 0 && token.magnitude === undefined && !weakPrimary(token)
  const bare = (token.kind === 'count' || token.kind === 'decimal') && plain
  // A cell that already prints its currency ("$ 1,577" on the first row and the totals of a table in millions)
  // is in the table's scale too, when the caller says so; the currency it prints stays.
  const priced = scaleCurrency && exp !== 0 && token.kind === 'currency' && plain && token.rate === undefined
  if (!bare && !priced) return token
  if (priced) {
    const d = parseDecimal(token.value)
    const alternates = token.alternates?.map((a) => {
      const ad = parseDecimal(a.value)
      return { value: formatDec({ n: ad.n * 10n ** BigInt(exp), s: ad.s }), scale: a.scale - exp }
    })
    const base = noProto({ ...token, value: formatDec({ n: d.n * 10n ** BigInt(exp), s: d.s }), scale: token.scale - exp })
    return alternates === undefined ? base : noProto({ ...base, alternates })
  }
  const shift = (v: string): string => {
    const d = parseDecimal(v)
    return formatDec({ n: d.n * 10n ** BigInt(exp), s: d.s })
  }
  const alternates = token.alternates?.map((a) => ({ value: shift(a.value), scale: a.scale - exp }))
  const base = noProto({ ...token, value: shift(token.value), scale: token.scale - exp })
  const scaled = alternates === undefined ? base : noProto({ ...base, alternates })
  return currency === undefined ? scaled : noProto({ ...scaled, kind: 'currency' as const, currency })
}

function buildEvidence(evidence: unknown, ctx: Ctx): Evidence {
  const ev: Evidence = {
    strong: new Index(), weak: new Index(), groupRaw: new GroupIndex(), dateAny: new Index(),
    dateUnknown: new Index(), byValue: new Index(), all: [], weakAll: [], dateKeys: new Map(), forms: new Set(), count: 0,
  }
  let count = 0
  let textTotal = 0
  const takeText = (text: string): string => {
    textTotal += text.length
    if (textTotal > MAX_EVIDENCE_TOTAL) {
      throw new RangeError(`evidence has more than ${MAX_EVIDENCE_TOTAL} characters in total.`)
    }
    return text
  }
  const tooManyNumbers = (): RangeError =>
    new RangeError(
      `evidence has more than ${ctx.maxEvidenceNumbers} numbers; split it, or keep only the passages the output can cite ` +
        `(the maxEvidenceNumbers option can lower the limit, which is at most ${MAX_EVIDENCE_NUMBERS}).`,
    )
  /** Scan one evidence text, stopping as soon as the evidence as a whole holds too many numbers. */
  const scanEvidence = (body: string): NumberToken[] => {
    try {
      const skips: SkipRecord[] = []
      const tokens = scan(body, ctx.evLoc, ctx.parenNeg, true, skips, ctx.maxEvidenceNumbers - count)
      for (const rec of skips) ev.forms.add(body.slice(rec.start, rec.end))
      return tokens
    } catch (e) {
      if (e instanceof NumberLimitError) throw tooManyNumbers()
      throw e
    }
  }
  const feed = (
    tokens: readonly NumberToken[],
    idOf: (t: NumberToken) => string,
    text: string | null,
    exp = ctx.evScale,
    currency = ctx.evCurrency,
    scaleCurrency = ctx.evScaleCurrency,
  ): void => {
    if (count + tokens.length > ctx.maxEvidenceNumbers) throw tooManyNumbers()
    for (const t of tokens) {
      ingest(ev, applyHints(t, exp, currency, scaleCurrency), idOf(t))
      count++
    }
    for (const cluster of dateClusters(tokens)) {
      // A date with a part that is itself in doubt (an exponent after the day) cannot vouch for a whole date.
      if (cluster.some((t) => t.ambiguous)) continue
      for (const tuple of dateTuples(cluster)) {
        const first = tuple.tokens[0]
        if (first === undefined) continue
        // The reference covers the whole date: from its first part to its last.
        let lo = first
        let hi = first
        for (const t of tuple.tokens) {
          if (t.start < lo.start) lo = t
          if (t.end > hi.end) hi = t
        }
        // Caller tokens carry no text; the group's own text is the date when the span covers it.
        const written = first.groupRaw
        const raw =
          text !== null ? text.slice(lo.start, hi.end)
          : lo === hi ? lo.raw
          : written !== undefined && written.length === hi.end - lo.start ? written
          : tuple.tokens.map((t) => t.raw).join(' ')
        addDateKeys(ev.dateKeys, tuple.parts, { id: idOf(first), raw, start: lo.start, end: hi.end })
        // A time written with seconds ("14:05:30") also stands for the time without them ("14:05").
        const hour = tuple.tokens.find((t) => t.part === 'hour')
        const minute = tuple.tokens.find((t) => t.part === 'minute')
        if (hour !== undefined && minute !== undefined && !hour.ambiguous && !minute.ambiguous) {
          const minutes = Number(absKey(hour.value)) * 60 + Number(absKey(minute.value))
          ingest(ev, noProto({ raw, start: lo.start, end: hi.end, value: String(minutes), scale: 0, kind: 'time' as const, ambiguous: false }), idOf(first))
        }
      }
    }
  }
  if (typeof evidence === 'string') {
    const whole = takeText(evidence)
    feed(scanEvidence(whole), () => 'evidence', whole)
  } else {
    if (!Array.isArray(evidence)) {
      throw new TypeError(`evidence must be a string or an array of { id, text } documents or tokens, got ${describe(evidence)}.`)
    }
    const items = snapshotArray(evidence, 'evidence')
    // Tokens a caller extracted come one by one; the ones that follow each other in one
    // document are fed together so a date written as several tokens is one date.
    let batch: NumberToken[] = []
    let batchIds = new Map<NumberToken, string>()
    let batchDoc: string | undefined
    const flush = (): void => {
      if (batch.length > 0) {
        const ids = batchIds
        feed(batch, (t) => ids.get(t) ?? 'evidence', null)
      }
      batch = []
      batchIds = new Map()
      batchDoc = undefined
    }
    items.forEach((item, index) => {
      if (!isRecord(item)) {
        throw new TypeError(
          `evidence[${index}] must be a { id, text } object or a number token, got ${describe(item)}.` +
            (typeof item === 'string' ? ' Wrap each string as { id, text }, or join the strings into one string.' : ''),
        )
      }
      const text = getOwn(item, 'text')
      if (text !== undefined) {
        const written = Object.keys(item)
        for (const key of written) {
          const meant = nearMiss(key, DOCUMENT_KEYS, written)
          if (meant !== undefined) {
            throw new RangeError(`evidence[${index}]: unknown key ${show(key)}, did you mean "${meant}"? Known keys: ${DOCUMENT_KEYS.join(', ')}.`)
          }
        }
        flush()
        const id = readString(getOwn(item, 'id'), `evidence[${index}].id`)
        const docScale = getOwn(item, 'scale')
        const docCurrency = getOwn(item, 'currency')
        const docApplies = getOwn(item, 'scaleApplies')
        const body = takeText(readString(text, `evidence[${index}].text`))
        feed(
          scanEvidence(body),
          () => id,
          body,
          docScale === undefined ? ctx.evScale : scaleExponent(docScale, `evidence[${index}].scale`),
          docCurrency === undefined ? ctx.evCurrency : currencyCode(docCurrency, `evidence[${index}].currency`),
          docApplies === undefined ? ctx.evScaleCurrency : scaleAppliesFlag(docApplies, `evidence[${index}].scaleApplies`),
        )
      } else {
        const { token, evidenceId } = readToken(item, `evidence[${index}]`, true)
        const prev = batch[batch.length - 1]
        if (prev !== undefined && (batchDoc !== evidenceId || token.start < prev.end)) flush()
        batchDoc = evidenceId
        batch.push(token)
        batchIds.set(token, evidenceId ?? `token:${index}`)
      }
    })
    flush()
  }
  return { ...ev, count }
}

// ---- matching -----------------------------------------------------------------------------------------------

/**
 * A dropped sign is `unknown` in `strict` mode. In the default mode a written negative in parentheses is held the
 * same way: `($5.2 million)` against `$5.2 million` could be a restated loss or a parenthetical figure, and the kit
 * cannot tell, so it never calls it clean. A minus sign is stricter still (`signAllowed` rejects it outright).
 */
function signHeld(tok: NumberToken, signDiffers: boolean, mode: SignMode, aside: boolean): boolean {
  if (!signDiffers) return false
  // A parenthesized figure right after another figure is an aside, which has no sign to disagree about, in every mode.
  if (tok.signStyle === 'parentheses') return mode !== 'magnitude' && !aside
  return mode === 'strict'
}

/**
 * Is the parenthesized figure written right after another figure ("£200 million ($300 million)", "$5 million (12.5%)")?
 * That is a conversion or an aside about the figure before it, the usual use of a parenthesis in prose, and not an
 * accounting negative standing on its own ("net loss was ($5.2 million)"). Looks back over at most a space, one word
 * and a space: constant work.
 */
function followsFigure(tok: NumberToken, text: string): boolean {
  let p = tok.start - 1
  if (p >= 0 && isSpaceCode(text.charCodeAt(p))) p--
  if (p < 0) return false
  const isDigitAt = (k: number): boolean => k >= 0 && text.charCodeAt(k) >= 0x30 && text.charCodeAt(k) <= 0x39
  if (isDigitAt(p) || text.charCodeAt(p) === 0x25) return true
  let w = p
  while (w >= 0 && p - w < 14 && isLetterCode(text.charCodeAt(w))) w--
  if (w === p || p - w >= 14) return false
  if (w >= 0 && isSpaceCode(text.charCodeAt(w))) w--
  return isDigitAt(w)
}

function signAllowed(tok: NumberToken, outNeg: boolean, entNeg: boolean, mode: SignMode): boolean {
  if (mode === 'magnitude') return true
  if (tok.signStyle === 'minus') return outNeg === entNeg
  if (tok.signStyle === 'plus') return !entNeg
  return true
}

function lookup(index: Index, shape: Shape, outNeg: boolean, key: string, bare = false): Ent[] {
  const found: Ent[] = []
  for (const neg of [outNeg, !outNeg]) {
    // A bare lookup finds only evidence that has no unit at all.
    for (const u of bare ? [''] : lookupKeys(shape.cls, shape.unit)) {
      const list = index.get(entKey(shape.cls, u, neg, key))
      if (list !== undefined) for (const e of list) found.push(e)
    }
  }
  return found
}

function uniqueRefs(ents: readonly Ent[]): EvidenceRef[] {
  const seen = new Set<string>()
  const refs: EvidenceRef[] = []
  for (const e of ents) {
    const k = `${e.ref.id}\u0000${e.ref.start}\u0000${e.ref.end}`
    if (seen.has(k)) continue
    seen.add(k)
    refs.push(e.ref)
    if (refs.length >= MAX_LIST) break
  }
  return refs
}

type RoundLabel = 'half-up' | 'half-even' | 'either'

interface Candidate {
  readonly kind: Derivation
  readonly keys: readonly Shape[]
  readonly abs: Rat
  readonly neg: boolean
  /** The evidence numbers the value is built from, in evidence order. */
  readonly operands: readonly Ent[]
  /** True when the operands are taken against the order the evidence mentions them. */
  readonly reversed: boolean
  /** The value depends on which operand came first (a change, a ratio). Sums, products and averages do not. */
  readonly ordered: boolean
  /** Position in its list, so the index picks the same candidate whatever order the windows are filed in. */
  readonly order: number
  /** The index key prefixes this candidate is filed under (class, unit and sign), built once on first use. */
  prefixes?: string[]
}

/** A candidate list sorted by value, with each value as fixed point (floor of value times 10^FIX_DIGITS). */
interface SortedCandidates {
  readonly fix: readonly bigint[]
  readonly cands: readonly Candidate[]
}

/**
 * The derivation index of one output scale. Only the candidates whose value lies near an output number at that
 * scale are filed (`ranges` are the filed stretches of the sorted list); a scale that asks for more than
 * MAX_RANGES separate stretches is filed completely once.
 */
interface ScaleIndex {
  map: Map<string, DerivedAgg>
  ranges: [number, number][]
  full: boolean
}

const FIX_DIGITS = 40
const MAX_RANGES = 64
/** Distinct output scales whose derived lookups are answered; the rest are `unknown` (`scale-cap`). */
const MAX_DERIVATION_SCALES = 12

const MODES_UP: ReadonlySet<RoundingMode> = new Set<RoundingMode>(['half-up'])
const MODES_EVEN: ReadonlySet<RoundingMode> = new Set<RoundingMode>(['half-even'])
const MODES_BOTH: ReadonlySet<RoundingMode> = new Set<RoundingMode>(['half-up', 'half-even'])

/**
 * The key prefixes a candidate is filed under. A plain-number candidate is also filed under "*" so an output with a
 * unit the evidence lacks (or the reverse) can find it; the lookup marks that as unverified. For allowBareOutput a
 * bare output number may match an amount in any currency.
 */
function filedPrefixes(cand: Candidate): string[] {
  const sign = cand.neg ? '-' : '+'
  const out: string[] = []
  for (const k of cand.keys) {
    out.push(`${k.cls}\u0000${k.unit}\u0000${sign}`)
    if (k.cls === 'plain') out.push(`plain\u0000*\u0000${sign}`)
    if (k.cls.startsWith('cur:')) out.push(`curany\u0000\u0000${sign}`)
  }
  return out
}

interface DerivedHit {
  readonly cand: Candidate
  readonly exact: boolean
  readonly label: RoundLabel | undefined
  /** Only the reversed reading matches, so the direction of the change cannot be confirmed. */
  readonly reversedOnly: boolean
  readonly matches: number
  /** The unit is present on only one side. */
  readonly unitUnverified: boolean
  /** The derivation's value has a sign the output does not show, and no derivation matches the output's sign. */
  readonly signDiffers: boolean
  /** Average candidates per displayed value in the neighborhood of the output. */
  readonly density: number
}

interface DerivedSlot {
  readonly cand: Candidate
  readonly modes: ReadonlySet<RoundingMode>
  readonly exact: boolean
}

interface DerivedAgg {
  count: number
  /** Index: forward exact, forward rounded, reversed exact, reversed rounded. */
  slots: (DerivedSlot | undefined)[]
  /** The first candidate that is exactly zero: zero has no sign to disagree about. */
  zero?: DerivedSlot
}

type HeldReason = 'twin-operands' | 'zero-operand'
const HELD_REASONS: readonly HeldReason[] = ['twin-operands', 'zero-operand']

/** Sorted positions [a, b) of the candidates whose value can round to within 25 units of `mantissa` at `scale`. */
function windowOf(fix: readonly bigint[], scale: number, mantissa: bigint): [number, number] {
  const margin = 26n
  const low = mantissa > margin ? mantissa - margin : 0n
  const high = mantissa + margin
  let lo: bigint
  let hi: bigint
  if (scale <= FIX_DIGITS) {
    const up = pow10(FIX_DIGITS - scale)
    lo = low * up
    hi = high * up
  } else {
    const down = pow10(scale - FIX_DIGITS)
    lo = low / down
    hi = high / down + 1n
  }
  // One unit of slack for the floor in the fixed-point value.
  lo -= 1n
  hi += 1n
  return [firstAtLeast(fix, lo), firstAtLeast(fix, hi + 1n)]
}

/** The first position whose value is at least `bound` (the length when none is). */
function firstAtLeast(fix: readonly bigint[], bound: bigint): number {
  let lo = 0
  let hi = fix.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const v = fix[mid]
    if (v !== undefined && v < bound) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The parts of [a, b) that no range in the sorted, disjoint `ranges` covers. */
function uncovered(a: number, b: number, ranges: readonly [number, number][]): [number, number][] {
  const out: [number, number][] = []
  let at = a
  for (const [x, y] of ranges) {
    if (y <= at) continue
    if (x >= b) break
    if (x > at) out.push([at, x])
    at = Math.max(at, y)
    if (at >= b) break
  }
  if (at < b) out.push([at, b])
  return out
}

/** Add [a, b) to the sorted, disjoint `ranges`, merging what it touches. */
function addRange(ranges: [number, number][], a: number, b: number): void {
  let first = 0
  while (first < ranges.length && (ranges[first]?.[1] ?? 0) < a) first++
  let last = first
  let lo = a
  let hi = b
  while (last < ranges.length && (ranges[last]?.[0] ?? Infinity) <= b) {
    lo = Math.min(lo, ranges[last]?.[0] ?? lo)
    hi = Math.max(hi, ranges[last]?.[1] ?? hi)
    last++
  }
  ranges.splice(first, last - first, [lo, hi])
}

class Matcher {
  private readonly rounded = new Map<string, Index>()
  private readonly derivedIdx = new Map<number, ScaleIndex>()
  private readonly sortedLists = new Map<readonly Candidate[], SortedCandidates>()
  private readonly scalesSeen = new Set<number>()
  /** Set when a derived lookup was refused for want of a free output scale (see MAX_DERIVATION_SCALES). */
  scaleCapped = false
  readonly candidates: Candidate[] = []
  /**
   * Candidates that must never make a number `derived`, filed by the reason a match is `unknown` instead.
   * `twin-operands`: built from two evidence numbers of the same value (a total and the payment that equals it),
   * whose difference is 0, ratio 1, percent 100 and sum double whatever the claim. `zero-operand`: a product, a
   * ratio or a percent of that is zero only because an operand is zero. Neither counts toward `derivation.matches`
   * or the density, and each says nothing about the claim: it could be one fact written twice or two real rows.
   */
  readonly held: Record<HeldReason, Candidate[]> = { 'twin-operands': [], 'zero-operand': [] }
  private readonly heldIdx: Record<HeldReason, Map<number, ScaleIndex>> = { 'twin-operands': new Map(), 'zero-operand': new Map() }
  capHit = false

  constructor(private readonly ev: Evidence, private readonly ctx: Ctx) {
    if (ctx.derivations.size > 0) this.buildCandidates()
  }

  // ---- rounding ------------------------------------------------------------------------------------------

  private roundedIndex(source: 'strong' | 'weak', scale: number): Index {
    const cacheKey = `${source}${scale}`
    let idx = this.rounded.get(cacheKey)
    if (idx !== undefined) return idx
    idx = new Index()
    for (const ent of source === 'strong' ? this.ev.all : this.ev.weakAll) {
      if (ent.cls === 'date' || ent.scale <= scale) continue
      const rat = toRat(ent.dec)
      for (const mode of this.ctx.modes) {
        const r = roundRat(rat, scale, mode)
        for (const u of regKeys(ent.cls, ent.unit)) idx.add(`${mode}\u0000${entKey(ent.cls, u, ent.neg, r.mantissa.toString())}`, ent)
        if (ent.cls.startsWith('cur:')) idx.add(`${mode}\u0000${entKey('curany', '', ent.neg, r.mantissa.toString())}`, ent)
        const unrated = unratedClass(ent)
        if (unrated !== undefined) idx.add(`${mode}\u0000${entKey(unrated, '', ent.neg, r.mantissa.toString())}`, ent)
      }
    }
    this.rounded.set(cacheKey, idx)
    return idx
  }

  /**
   * Evidence (strong readings, or weak ones) that rounds to `mantissa` at `scale`.
   * `signTok` supplies the explicit sign the output wrote, if any.
   */
  findRounded(
    source: 'strong' | 'weak',
    signTok: NumberToken,
    scale: number,
    shape: Shape,
    outNeg: boolean,
    mantissa: bigint,
    bare = false,
  ): { ents: Ent[]; label: RoundLabel } | null {
    if (this.ctx.modes.length === 0) return null
    const idx = this.roundedIndex(source, scale)
    const hits = new Map<Ent, Set<RoundingMode>>()
    for (const mode of this.ctx.modes) {
      for (const neg of [outNeg, !outNeg]) {
        for (const u of bare ? [''] : lookupKeys(shape.cls, shape.unit)) {
          const list = idx.get(`${mode}\u0000${entKey(shape.cls, u, neg, mantissa.toString())}`)
          if (list === undefined) continue
          for (const e of list) {
            if (!signAllowed(signTok, outNeg, e.neg, this.ctx.signMode)) continue
            const modes = hits.get(e) ?? new Set<RoundingMode>()
            modes.add(mode)
            hits.set(e, modes)
          }
        }
      }
    }
    if (hits.size === 0) return null
    const bothAllowed = this.ctx.modes.length === 2
    const label = (m: Set<RoundingMode>): RoundLabel => (bothAllowed && m.size === 2 ? 'either' : (m.has('half-up') ? 'half-up' : 'half-even'))
    let best: RoundLabel | null = null
    for (const m of hits.values()) {
      const l = label(m)
      if (best === null || l === 'either') best = l
      if (best === 'either') break
    }
    if (best === null) return null
    const ents: Ent[] = []
    for (const [e, m] of hits) if (label(m) === best) ents.push(e)
    return { ents, label: best }
  }

  // ---- derivations ------------------------------------------------------------------------------------------

  private buildCandidates(): void {
    const seen = new Map<string, number>()
    const ops: Ent[] = []
    const opKeys: string[] = []
    for (const e of this.ev.all) {
      const t = e.token
      // A number whose only doubt is thousands-versus-decimal ("1.250") still takes part, with its primary reading.
      if ((t.ambiguous && t.ambiguity !== 'separator') || weakPrimary(t)) continue
      if (t.kind === 'date-part' || t.kind === 'time' || t.kind === 'year' || t.kind === 'ordinal') continue
      // Two occurrences of the same value can still add up (two rows of 7.5%);
      // a third adds nothing new, and repeats must not inflate the search.
      // Zero is zero whatever sign it was written with.
      const k = `${e.cls}\u0000${e.unit}\u0000${e.neg && e.key !== '0' ? '-' : '+'}${e.key}`
      const seenCount = seen.get(k) ?? 0
      if (seenCount >= 2) continue
      seen.set(k, seenCount + 1)
      ops.push(e)
      opKeys.push(k)
    }
    const m = ops.length
    if (m < 2) return
    // Count what the loops below will generate, before they run. Only operands of one class and unit pair up for
    // a sum, a difference, a ratio, a change, a percent or an average; across classes only a count times an amount
    // and a percent of an amount make a candidate. Counting every pair as if it made all of them would give up on
    // a page of 100 mixed numbers that has a few thousand candidates.
    const d = this.ctx.derivations
    const groups = new Map<string, number>()
    let counts = 0
    let percents = 0
    let points = 0
    for (const e of ops) {
      const g = `${e.cls}\u0000${e.unit}`
      groups.set(g, (groups.get(g) ?? 0) + 1)
      if (isCount(e)) counts++
      if (e.cls === 'pct') percents++
      if (e.cls === 'pp') points++
    }
    let perSame = 0
    if (d.has('sum')) perSame += 1
    if (d.has('difference')) perSame += 2
    if (d.has('ratio')) perSame += 2
    if (d.has('percent-change')) perSame += 2
    if (d.has('percent-of')) perSame += 2
    if (d.has('average')) perSame += 1
    // Three-operand candidates: a sum, a difference (each figure less the other two) and a mean.
    let perTriple = 0
    if (this.ctx.maxOperands === 3) {
      if (d.has('sum')) perTriple += 1
      if (d.has('difference')) perTriple += 3
      if (d.has('average')) perTriple += 1
    }
    let total = 0
    for (const [g, size] of groups) {
      const pairs = (size * (size - 1)) / 2
      total += pairs * (perSame + (d.has('product') && g === 'plain\u0000' ? 1 : 0))
      if (size >= 3) total += ((size * (size - 1) * (size - 2)) / 6) * perTriple
    }
    if (d.has('product')) total += counts * (m - points - percents - counts)
    if (d.has('percent-of')) total += percents * (m - percents - points)
    if (total > this.ctx.maxCandidates) {
      this.capHit = true
      return
    }
    const signed = (e: Ent): Rat => {
      const r = toRat(e.dec)
      return e.neg ? { p: -r.p, q: r.q } : r
    }
    // `reversed` is given only for derivations whose value depends on the order of the operands.
    let twin = false
    const push = (kind: Derivation, keys: Shape[], r: Rat, operands: Ent[], reversed?: boolean): void => {
      const neg = r.p < 0n
      // A product, a ratio or a percent of is zero only through a zero operand, which tells nothing about the claim.
      const zero = r.p === 0n && (kind === 'product' || kind === 'ratio' || kind === 'percent-of')
      const target = twin ? this.held['twin-operands'] : zero ? this.held['zero-operand'] : this.candidates
      target.push({ kind, keys, abs: { p: neg ? -r.p : r.p, q: r.q }, neg, operands, reversed: reversed === true, ordered: reversed !== undefined, order: target.length })
    }
    const HUNDRED: Rat = { p: 100n, q: 1n }
    for (let i = 0; i < m; i++) {
      const A = ops[i]
      if (A === undefined) continue
      for (let j = i + 1; j < m; j++) {
        const B = ops[j]
        if (B === undefined) continue
        const same = A.cls === B.cls && A.unit === B.unit
        twin = opKeys[i] === opKeys[j]
        const a = signed(A)
        const b = signed(B)
        const own: Shape[] = [{ cls: A.cls, unit: A.unit }]
        if (same) {
          if (d.has('sum')) push('sum', own, ratAdd(a, b), [A, B])
          if (d.has('average')) push('average', own, ratDiv(ratAdd(a, b), { p: 2n, q: 1n }) ?? a, [A, B])
          if (d.has('product') && A.cls === 'plain' && A.unit === '') push('product', own, ratMul(a, b), [A, B])
          if (d.has('difference')) {
            const keys = A.cls === 'pct' ? [{ cls: 'pct', unit: '' }, { cls: 'pp', unit: '' }] : own
            push('difference', keys, ratSub(b, a), [A, B], false)
            push('difference', keys, ratSub(a, b), [B, A], true)
          }
          if (d.has('ratio')) {
            const keys: Shape[] = [{ cls: 'ratio', unit: '' }, { cls: 'ratio', unit: 'x' }]
            const q1 = ratDiv(a, b)
            const q2 = ratDiv(b, a)
            if (q1 !== null) push('ratio', keys, q1, [A, B], false)
            if (q2 !== null) push('ratio', keys, q2, [B, A], true)
          }
          if (d.has('percent-change')) {
            const pct: Shape[] = [{ cls: 'pct', unit: '' }]
            const c1 = ratDiv(ratSub(b, a), a)
            const c2 = ratDiv(ratSub(a, b), b)
            if (c1 !== null) push('percent-change', pct, ratMul(c1, HUNDRED), [A, B], false)
            if (c2 !== null) push('percent-change', pct, ratMul(c2, HUNDRED), [B, A], true)
          }
          if (d.has('percent-of')) {
            const pct: Shape[] = [{ cls: 'pct', unit: '' }]
            const q1 = ratDiv(a, b)
            const q2 = ratDiv(b, a)
            if (q1 !== null) push('percent-of', pct, ratMul(q1, HUNDRED), [A, B], false)
            if (q2 !== null) push('percent-of', pct, ratMul(q2, HUNDRED), [B, A], true)
          }
        } else if (d.has('product') && (isCount(A) || isCount(B)) && A.cls !== 'pct' && A.cls !== 'pp' && B.cls !== 'pct' && B.cls !== 'pp') {
          // A count times a unit price (or a quantity): the other operand's class.
          const other = isCount(A) ? B : A
          push('product', [{ cls: other.cls, unit: other.unit }], ratMul(a, b), [A, B])
        }
        if (!same && d.has('percent-of')) {
          // "7.5% of $200": a percent applied to an amount.
          const pctSide = A.cls === 'pct' ? A : B.cls === 'pct' ? B : null
          const other = pctSide === A ? B : A
          if (pctSide !== null && other.cls !== 'pct' && other.cls !== 'pp') {
            push(
              'percent-of',
              [{ cls: other.cls, unit: other.unit }],
              ratMul(ratDiv(signed(pctSide), HUNDRED) ?? { p: 0n, q: 1n }, signed(other)),
              [pctSide, other],
            )
          }
        }
      }
    }
    if (perTriple > 0) {
      for (let i = 0; i < m; i++) {
        const A = ops[i]
        if (A === undefined) continue
        for (let j = i + 1; j < m; j++) {
          const B = ops[j]
          if (B === undefined || B.cls !== A.cls || B.unit !== A.unit) continue
          for (let k = j + 1; k < m; k++) {
            const C = ops[k]
            if (C === undefined || C.cls !== A.cls || C.unit !== A.unit) continue
            twin = opKeys[i] === opKeys[j] || opKeys[i] === opKeys[k] || opKeys[j] === opKeys[k]
            const a = signed(A)
            const b = signed(B)
            const c = signed(C)
            const own: Shape[] = [{ cls: A.cls, unit: A.unit }]
            if (d.has('sum')) push('sum', own, ratAdd(ratAdd(a, b), c), [A, B, C])
            if (d.has('average')) push('average', own, ratDiv(ratAdd(ratAdd(a, b), c), { p: 3n, q: 1n }) ?? a, [A, B, C])
            if (d.has('difference')) {
              // Each figure less the other two. No figure is "earlier", so none is reversed.
              const keys = A.cls === 'pct' ? [{ cls: 'pct', unit: '' }, { cls: 'pp', unit: '' }] : own
              push('difference', keys, ratSub(ratSub(a, b), c), [A, B, C])
              push('difference', keys, ratSub(ratSub(b, a), c), [B, A, C])
              push('difference', keys, ratSub(ratSub(c, a), b), [C, A, B])
            }
          }
        }
      }
    }
  }
  /**
   * Candidates indexed by (class, unit, sign, rounded value). Each key keeps a
   * count and the first candidate of each kind (in evidence order or
   * reversed, exact or rounded), never a list, so many candidates landing on
   * one value cost nothing extra to look up.
   */
  private derivedIndex(scale: number, mantissa: bigint, held?: HeldReason): Map<string, DerivedAgg> {
    const cache = held === undefined ? this.derivedIdx : this.heldIdx[held]
    let si = cache.get(scale)
    if (si === undefined) {
      if (!this.scalesSeen.has(scale)) {
        // Every distinct output scale costs a pass over the candidates near its numbers; past the cap the lookup
        // finds nothing and the caller says `unknown`, never `untraced`.
        if (this.scalesSeen.size >= MAX_DERIVATION_SCALES) {
          this.scaleCapped = true
          return new Map()
        }
        this.scalesSeen.add(scale)
      }
      si = { map: new Map(), ranges: [], full: false }
      cache.set(scale, si)
    }
    if (si.full) return si.map
    const sorted = this.sortedFor(held === undefined ? this.candidates : this.held[held])
    // The window of values that can round to within 25 units of the output (the density looks that far).
    const [a, b] = windowOf(sorted.fix, scale, mantissa)
    if (a >= b) return si.map
    for (const [x, y] of uncovered(a, b, si.ranges)) this.fileRange(si.map, sorted, x, y, scale)
    addRange(si.ranges, a, b)
    if (si.ranges.length > MAX_RANGES) {
      // Many separate windows: file everything once and stop tracking.
      si.map = new Map()
      this.fileRange(si.map, sorted, 0, sorted.cands.length, scale)
      si.full = true
    }
    return si.map
  }

  private sortedFor(list: readonly Candidate[]): SortedCandidates {
    let sorted = this.sortedLists.get(list)
    if (sorted !== undefined) return sorted
    const unit = pow10(FIX_DIGITS)
    const keyed = list.map((cand) => ({ cand, fix: (cand.abs.p * unit) / cand.abs.q }))
    keyed.sort((x, y) => (x.fix < y.fix ? -1 : x.fix > y.fix ? 1 : x.cand.order - y.cand.order))
    sorted = { fix: keyed.map((k) => k.fix), cands: keyed.map((k) => k.cand) }
    this.sortedLists.set(list, sorted)
    return sorted
  }

  /** File the candidates at sorted positions [from, to) in the index of one output scale. */
  private fileRange(index: Map<string, DerivedAgg>, sorted: SortedCandidates, from: number, to: number, scale: number): void {
    // With rounding turned off only exact values count, but they are still found.
    const exactOnly = this.ctx.modes.length === 0
    const useUp = exactOnly || this.ctx.modes.includes('half-up')
    const useEven = !exactOnly && this.ctx.modes.includes('half-even')
    const factor = scale >= 0 ? pow10(scale) : 1n
    const divisor = scale < 0 ? pow10(-scale) : 1n
    for (let n = from; n < to; n++) {
      const cand = sorted.cands[n]
      if (cand === undefined) continue
      // One division gives both rounding modes.
      const den = cand.abs.q * divisor
      const num = cand.abs.p * factor
      const quo = num / den
      const rem = num - quo * den
      const exact = rem === 0n
      // Sums and differences are exact arithmetic, so only an exact match counts.
      if (!exact && (exactOnly || ((cand.kind === 'sum' || cand.kind === 'difference') && !this.ctx.roundSums))) continue
      let up = quo
      let even = quo
      if (!exact) {
        const twice = rem * 2n
        if (twice > den) {
          up = quo + 1n
          even = up
        } else if (twice === den) {
          up = quo + 1n
          even = quo % 2n === 0n ? quo : quo + 1n
        }
      }
      const at = (this.against(cand) ? 2 : 0) + (exact ? 0 : 1)
      const prefixes = (cand.prefixes ??= filedPrefixes(cand))
      const file = (mantissa: bigint, modes: ReadonlySet<RoundingMode>): void => {
        const m = mantissa.toString()
        for (const prefix of prefixes) {
          const key = prefix + m
          let agg = index.get(key)
          if (agg === undefined) {
            agg = { count: 0, slots: [undefined, undefined, undefined, undefined] }
            index.set(key, agg)
          }
          agg.count++
          // The first candidate in candidate order, whatever order the windows are filed in.
          const held = agg.slots[at]
          if (held === undefined || cand.order < held.cand.order) agg.slots[at] = { cand, modes, exact }
          if (cand.abs.p === 0n && (agg.zero === undefined || cand.order < agg.zero.cand.order)) agg.zero = { cand, modes, exact }
        }
      }
      if (useUp && useEven && up === even) file(up, MODES_BOTH)
      else {
        if (useUp) file(up, MODES_UP)
        if (useEven) file(even, MODES_EVEN)
      }
    }
  }

  /**
   * A derivation that gives this value. A unit on only one side is allowed and
   * reported as unverified (like a direct match), unless `strict` (bare-evidence
   * lookups). Operand units must always agree with each other.
   */
  /**
   * How crowded the candidates are around a displayed value: the average number of candidates
   * per distinct displayed value within 25 units of the last digit on either side. A random
   * wrong number lands on a candidate with about this probability.
   */
  /** The candidate takes its operands against the order the caller says the evidence is in. */
  private against(cand: Candidate): boolean {
    return cand.ordered && cand.reversed !== this.ctx.newestFirst
  }

  private density(idx: Map<string, DerivedAgg>, cls: string, unit: string, mantissa: bigint): number {
    const K = 25n
    let total = 0
    for (let d = -K; d <= K; d++) {
      const m = mantissa + d
      if (m < 0n) continue
      for (const sign of ['+', '-']) total += idx.get(`${cls}\u0000${unit}\u0000${sign}${m.toString()}`)?.count ?? 0
    }
    return total / Number(2n * K + 1n)
  }

  findDerived(
    tok: NumberToken,
    scale: number,
    shape: Shape,
    outNeg: boolean,
    mantissa: bigint,
    strict = false,
    held?: HeldReason,
  ): DerivedHit | null {
    if ((held === undefined ? this.candidates : this.held[held]).length === 0) return null
    const idx = this.derivedIndex(scale, mantissa, held)
    const tries: { cls: string; unit: string; unverified: boolean }[] = [{ cls: shape.cls, unit: shape.unit, unverified: false }]
    if (shape.cls === 'plain') {
      if (!strict) tries.push({ cls: 'plain', unit: shape.unit === '' ? '*' : '', unverified: true })
      // A ratio has no dimension: it matches a bare number or an x multiple only.
      if (!strict && (shape.unit === '' || shape.unit === 'x')) tries.push({ cls: 'ratio', unit: shape.unit, unverified: false })
    }
    // A match that only works in the reverse order is kept as a fallback, so a later unit
    // reading that matches in the stated order is not hidden by it.
    let fallback: DerivedHit | null = null
    for (const attempt of tries) {
      let count = 0
      let best: DerivedSlot | undefined
      let bestAt = 4
      for (const neg of [outNeg, !outNeg]) {
        const agg = idx.get(`${attempt.cls}\u0000${attempt.unit}\u0000${neg ? '-' : '+'}${mantissa.toString()}`)
        if (agg === undefined) continue
        if (!signAllowed(tok, outNeg, neg, this.ctx.signMode)) {
          // An exactly zero derivation matches whatever sign was written; a tiny value that only
          // rounds to zero does not.
          if (mantissa === 0n && agg.zero !== undefined && bestAt > 0) {
            count += 1
            best = agg.zero
            bestAt = Math.min(bestAt, this.against(agg.zero.cand) ? 2 : 0)
          }
          continue
        }
        count += agg.count
        for (let k = 0; k < bestAt; k++) {
          const slot = agg.slots[k]
          if (slot !== undefined) {
            best = slot
            bestAt = k
            break
          }
        }
      }
      if (best === undefined) continue
      const bothAllowed = this.ctx.modes.length === 2
      const label: RoundLabel | undefined = best.exact
        ? undefined
        : bothAllowed && best.modes.size === 2
          ? 'either'
          : best.modes.has('half-up')
            ? 'half-up'
            : 'half-even'
      const sameSignExists = idx.has(`${attempt.cls}\u0000${attempt.unit}\u0000${outNeg ? '-' : '+'}${mantissa.toString()}`)
      const found: DerivedHit = {
        cand: best.cand, exact: best.exact, label, reversedOnly: this.against(best.cand), matches: count,
        unitUnverified: attempt.unverified,
        signDiffers: best.cand.neg !== outNeg && !sameSignExists && best.cand.abs.p !== 0n,
        density: this.density(idx, attempt.cls, attempt.unit, mantissa),
      }
      if (!found.reversedOnly) return found
      fallback ??= found
    }
    return fallback
  }
}

// ---- ignoring ---------------------------------------------------------------------------------------------------

function overlapsPattern(re: RegExp, text: string, start: number, end: number): boolean {
  // However long the number is, the pattern sees at most its first 64 characters.
  const clippedEnd = Math.min(end, start + 64)
  const from = Math.max(0, start - WINDOW_BEFORE)
  const to = Math.min(text.length, clippedEnd + WINDOW_AFTER)
  const window = text.slice(from, to)
  const a = start - from
  const b = clippedEnd - from
  re.lastIndex = 0
  const unicode = re.flags.includes('u') || re.flags.includes('v')
  for (let guard = 0; guard <= window.length + 1; guard++) {
    const m = re.exec(window)
    if (m === null) return false
    const s = m.index
    const e = s + m[0].length
    if (e > s && s < b && e > a) return true
    if (e === s) {
      // Advance an empty match by a whole code point under u/v.
      const hi = window.charCodeAt(re.lastIndex)
      const lo = window.charCodeAt(re.lastIndex + 1)
      re.lastIndex += unicode && hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff ? 2 : 1
    }
    if (re.lastIndex > window.length) return false
  }
  return false
}

/** An exact non-negative whole number written with digits only, no larger than `limit`. */
function isWholeNumberAtMost(value: string, limit: number): boolean {
  if (value.length === 0 || value.length > 8) return false
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 0x30 || c > 0x39) return false
  }
  return Number(value) <= limit
}

// Singular labels only: "figures 240", "options 400" and "questions 15" are counts, and "Section 230" is a legal citation.
const STRUCTURE_WORDS: ReadonlySet<string> = new Set(['step', 'passage', 'figure', 'fig', 'option', 'question'])

function isSpaceCode(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0xa0
}

/**
 * A number that labels the answer's own structure and makes no claim: a list marker ("1." or "2)" at the start of
 * a line, after an optional bullet), a bracket citation ("[3]", "[1, 2]", "[1-3]") or the number of a step, passage,
 * figure, option or question ("Step 4"; "Section 230" and "Section 50(1)" are legal citations and are checked). Only a plain whole number of at most
 * three digits can be one, and a list marker or a label has at most two.
 * Every scan is bounded, so this costs a constant amount per number.
 */
function isStructureNumber(tok: NumberToken, text: string): boolean {
  if (tok.kind !== 'count' || tok.unit !== undefined || tok.ambiguous || tok.signStyle !== undefined) return false
  const len = tok.end - tok.start
  if (len < 1 || len > 3 || tok.end > text.length) return false
  // A list marker and a label are one or two digits; only a bracket citation may have three ("[150]").
  const short = len <= 2
  for (let i = tok.start; i < tok.end; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x30 || c > 0x39) return false
  }
  const after = tok.end < text.length ? text.charCodeAt(tok.end) : -1
  // "1. text", "2) text": a marker at the start of a line.
  if (short && (after === 0x2e || after === 0x29) && tok.end + 1 < text.length) {
    const next = text.charCodeAt(tok.end + 1)
    if (next === 0x20 || next === 0x09 || next === 0x0a || next === 0x0d || next === 0xa0) {
      let p = tok.start - 1
      let guard = 0
      while (p >= 0 && isSpaceCode(text.charCodeAt(p)) && guard++ < 32) p--
      if (p >= 0 && (text.charCodeAt(p) === 0x2d || text.charCodeAt(p) === 0x2a || text.charCodeAt(p) === 0x2022)) {
        p--
        while (p >= 0 && isSpaceCode(text.charCodeAt(p)) && guard++ < 64) p--
      }
      if (guard < 64 && (p < 0 || text.charCodeAt(p) === 0x0a || text.charCodeAt(p) === 0x0d)) return true
    }
  }
  // "[3]", "[1, 2]", "[1-3]": a bracket that holds only numbers.
  const isListChar = (c: number): boolean => (c >= 0x30 && c <= 0x39) || c === 0x2c || c === 0x20 || c === 0x2d || c === 0x2013
  let b = tok.start - 1
  let steps = 0
  while (b >= 0 && isListChar(text.charCodeAt(b)) && steps++ < 24) b--
  if (b >= 0 && text.charCodeAt(b) === 0x5b) {
    let e = tok.end
    steps = 0
    while (e < text.length && isListChar(text.charCodeAt(e)) && steps++ < 24) e++
    if (e < text.length && text.charCodeAt(e) === 0x5d) return true
  }
  // "Step 4", "Figure 2", "Fig. 2", "Passage 12".
  let q = tok.start - 1
  if (short && q >= 0 && isSpaceCode(text.charCodeAt(q))) {
    while (q >= 0 && isSpaceCode(text.charCodeAt(q)) && q > tok.start - 4) q--
    if (q >= 0 && text.charCodeAt(q) === 0x2e) q--
    let w = q
    while (w >= 0 && q - w < 10 && isLetterCode(text.charCodeAt(w))) w--
    if (w < q && !(w >= 0 && isLetterCode(text.charCodeAt(w)))) {
      const word = text.slice(w + 1, q + 1).toLowerCase()
      if (STRUCTURE_WORDS.has(word)) return true
    }
  }
  return false
}

function isLetterCode(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
}

function ignoreReason(tok: NumberToken, text: string | null, ctx: Ctx): string | undefined {
  if (ctx.ignoreKinds.has(tok.kind)) return 'kind'
  if (ctx.ignoreYears && (tok.kind === 'year' || (tok.kind === 'date-part' && tok.part === 'year'))) return 'year'
  if (
    ctx.ignoreSmall >= 0 && tok.kind === 'count' && tok.unit === undefined && !tok.ambiguous &&
    tok.signStyle === undefined && tok.scale >= 0 && isWholeNumberAtMost(tok.value, ctx.ignoreSmall)
  ) {
    return 'small-integer'
  }
  if (ctx.ignoreStructure && text !== null && isStructureNumber(tok, text)) return 'structure'
  if (ctx.ignoreRaw.has(tok.raw.trim())) return 'ignore-list'
  if (ctx.ignoreKeys.size > 0 && (tok.kind === 'count' || tok.kind === 'decimal' || tok.kind === 'year') && tok.unit === undefined) {
    if (ctx.ignoreKeys.has(signedKey(tok.value))) return 'ignore-list'
  }
  if (ctx.pattern !== null) {
    const source = text ?? tok.raw
    const start = text === null ? 0 : tok.start
    const end = text === null ? tok.raw.length : tok.end
    if (overlapsPattern(ctx.pattern, source, start, end)) return 'pattern'
  }
  return undefined
}

// ---- tracing ---------------------------------------------------------------------------------------------------

export function traceNumbers(
  output: string | readonly NumberToken[],
  evidence: EvidenceInput,
  options?: TraceOptions,
): TraceResult {
  const ctx = readContext(options)
  let tokens: readonly NumberToken[]
  let outText: string | null = null
  let formTexts: readonly { readonly raw: string }[] | null = null
  const skips: SkipRecord[] = []
  if (typeof output === 'string') {
    if (output.length > MAX_TEXT_LENGTH) throw new RangeError(`output has ${output.length} characters; the limit is ${MAX_TEXT_LENGTH}.`)
    outText = output
    try {
      tokens = scan(output, ctx.loc, ctx.parenNeg, false, skips, ctx.maxOutputNumbers)
    } catch (e) {
      if (e instanceof NumberLimitError) {
        throw new RangeError(`output has more than ${ctx.maxOutputNumbers} numbers; split it (the maxOutputNumbers option can raise the limit to ${MAX_EVIDENCE_NUMBERS} or lower it).`, { cause: e })
      }
      throw e
    }
  } else {
    if (!Array.isArray(output)) throw new TypeError(`output must be a string or an array of tokens, got ${describe(output)}.`)
    const items = snapshotArray(output, 'output')
    if (items.length > ctx.maxOutputNumbers) {
      throw new RangeError(`output has ${items.length} numbers; the limit is ${ctx.maxOutputNumbers} (the maxOutputNumbers option).`)
    }
    // The array extractNumbers returned, unchanged, carries the forms it passed over.
    const forms = skippedFormsOf(output, items)
    if (forms !== null) {
      for (const f of forms) skips.push({ start: f.start, end: f.end, reason: f.reason })
      formTexts = forms
    }
    tokens = items.map((item, i) => {
      if (!isRecord(item)) throw new TypeError(`output[${i}] must be a number token, got ${describe(item)}.`)
      const { token } = readToken(item, `output[${i}]`)
      if (token.ambiguity !== 'too-long' && token.kind !== 'date-part' && mantissaAt(parseDecimal(token.value), token.scale) === null) {
        throw new TypeError(`output[${i}]: value ${token.value} does not fit scale ${token.scale}.`)
      }
      return token
    })
  }
  const ev = buildEvidence(evidence, ctx)
  const matcher = new Matcher(ev, ctx)
  const dates = new Map<NumberToken, DateInfo>()
  for (const cluster of dateClusters(tokens)) {
    const tuples = dateTuples(cluster)
    const owner = new Map<NumberToken, DateTuple>()
    for (const tuple of tuples) for (const t of tuple.tokens) if (!owner.has(t)) owner.set(t, tuple)
    const info: DateInfo = { tuples, owner, ok: undefined }
    for (const t of cluster) dates.set(t, info)
  }
  const numbers: NumberTrace[] = []
  const statuses: Record<TraceStatus, number> = { traced: 0, rounded: 0, derived: 0, untraced: 0, ignored: 0, unknown: 0 }
  for (const tok of tokens) {
    const trace = traceOne(tok, outText, ev, matcher, ctx, dates)
    statuses[trace.status]++
    numbers.push(trace)
  }
  // Digits the scanner passed over. A glued form it cannot read is never a pass: it makes the verdict unknown.
  let unreadForms = 0
  const skipped: SkippedNumber[] = skips.map((rec, k) => {
    const raw = formTexts !== null ? (formTexts[k]?.raw ?? '') : (outText ?? '').slice(rec.start, rec.end)
    const covered = rec.reason === 'unread-glued-form' && skipIgnored(raw, rec.start, rec.end, outText, ctx)
    // The same text in the evidence vouches for an unread form, as it does for an unreadable magnitude word.
    let reason: SkippedNumber['reason'] = covered ? 'ignored' : rec.reason
    if (reason === 'unread-glued-form' && ev.forms.has(raw)) reason = 'in-evidence'
    else if (reason === 'identifier' && ctx.checkIdentifiers) reason = ev.forms.has(raw) ? 'in-evidence' : 'not-in-evidence'
    if (reason === 'unread-glued-form' || reason === 'not-in-evidence') unreadForms++
    return { raw, start: rec.start, end: rec.end, reason }
  })
  let unitUnverified = 0
  let signDiffers = 0
  for (const t of numbers) {
    if (t.unitUnverified === true) unitUnverified++
    if (t.signDiffers === true) signDiffers++
  }
  const counts: TraceCounts = { ...statuses, skipped: skipped.length, unitUnverified, signDiffers }
  const verdict = statuses.untraced > 0 ? 'untraced' : statuses.unknown > 0 || unreadForms > 0 ? 'unknown' : 'clean'
  return {
    verdict,
    numbers,
    skipped,
    counts,
    evidenceNumbers: ev.count,
    derivationCandidates: matcher.candidates.length + matcher.held['twin-operands'].length + matcher.held['zero-operand'].length,
    candidateCapHit: matcher.capHit,
  }
}

/** Is an unread glued form covered by the caller's ignore list or pattern? */
function skipIgnored(raw: string, start: number, end: number, text: string | null, ctx: Ctx): boolean {
  if (ctx.ignoreRaw.has(raw.trim())) return true
  return ctx.pattern !== null && text !== null && overlapsPattern(ctx.pattern, text, start, end)
}

function unknownTrace(tok: NumberToken, reason: string): NumberTrace {
  return { token: tok, status: 'unknown', evidence: [], reason }
}

/** The whole dates written in one run of date parts in the output, and whether the evidence has them all. */
interface DateInfo {
  readonly tuples: readonly DateTuple[]
  /** The date each token belongs to (the first, for a month or year shared by several days). */
  readonly owner: ReadonlyMap<NumberToken, DateTuple>
  ok: boolean | undefined
}

function traceOne(
  tok: NumberToken,
  text: string | null,
  ev: Evidence,
  matcher: Matcher,
  ctx: Ctx,
  dates: ReadonlyMap<NumberToken, DateInfo>,
): NumberTrace {
  const ignored = ignoreReason(tok, text, ctx)
  if (ignored !== undefined) return { token: tok, status: 'ignored', evidence: [], reason: ignored }
  if (tok.ambiguity === 'superscript') return unknownTrace(tok, 'ambiguous-superscript')
  if (tok.ambiguity === 'too-long') return unknownTrace(tok, 'too-long')
  if (tok.kind === 'date-part') return traceDate(tok, ev, dates.get(tok))

  const shape = shapeOf(tok)
  const dec = parseDecimal(tok.value)
  const outNeg = writtenNegative(tok.value, tok.signStyle)
  const key = absKey(tok.value)
  const mantissa = mantissaAt(dec.n < 0n ? { n: -dec.n, s: dec.s } : dec, tok.scale)
  if (mantissa === null) return unknownTrace(tok, 'unrepresentable')

  if ((tok.ambiguity === 'fraction' || tok.ambiguity === 'magnitude' || tok.ambiguity === 'currency' || tok.ambiguity === 'date' || tok.ambiguity === 'sign') && tok.groupRaw !== undefined) {
    // The same fraction (or the same unread phrase) written the same way vouches for it.
    const same = ev.groupRaw.get(tok.groupRaw, key)
    if (same !== undefined && same.length > 0) return { token: tok, status: 'traced', evidence: uniqueRefs(same) }
  }
  // A magnitude word the kit cannot value, or a currency that contradicts itself, is never a pass or a fail.
  if (tok.ambiguity === 'magnitude') return unknownTrace(tok, 'unread-magnitude')
  if (tok.ambiguity === 'currency') return unknownTrace(tok, 'conflicting-currency')
  // A worded date in a language the kit has no month names for: its day and year are not independent numbers.
  if (tok.ambiguity === 'date') return unknownTrace(tok, 'unread-date')
  // The number as written, and (with allowBareEvidence) as a unit-less number.
  const variants: Variant[] = [{ shape, bare: false, unverified: false }]
  if (ctx.allowBare && shape.cls !== 'plain' && shape.cls !== 'time') variants.push({ shape: BARE_SHAPE, bare: true, unverified: true })
  // A bare output number against an amount with a currency.
  if (ctx.allowBareOut && shape.cls === 'plain' && shape.unit === '') {
    variants.push({ shape: { cls: 'curany', unit: '' }, bare: false, unverified: true })
  }
  // An exact zero has no sign to disagree about.
  const allow = (e: Ent): boolean => key === '0' || signAllowed(tok, outNeg, e.neg, ctx.signMode)
  matcher.scaleCapped = false
  // A parenthesis right after a figure is an aside (a conversion), so it is not held as a possible negative.
  const aside = tok.signStyle === 'parentheses' && text !== null && followsFigure(tok, text)

  if (weakPrimary(tok)) {
    if (
      linksVia(tok, tok.scale, outNeg, mantissa, key, ['strong', 'weak'], true, variants, ev, matcher, ctx) ||
      alternateLinks(tok, variants, ev, matcher, ctx)
    ) {
      return unknownTrace(tok, tok.ambiguity === 'sign' ? 'ambiguous-sign' : 'ambiguous-reading')
    }
    // An incomplete derivation search stays unknown.
    if (ctx.derivations.size > 0 && matcher.capHit) return unknownTrace(tok, 'candidate-cap')
    if (matcher.scaleCapped) return unknownTrace(tok, 'scale-cap')
    const near = nearMisses(tok, shape, outNeg, key, ev, ctx)
    return { token: tok, status: 'untraced', evidence: [], ...(near.length > 0 ? { nearMisses: near } : {}) }
  }

  // 1. Exact match after normalization.
  for (const v of variants) {
    const exact = lookup(ev.strong, v.shape, outNeg, key, v.bare).filter(allow)
    if (exact.length > 0) return matched(tok, 'traced', exact, outNeg, undefined, v.unverified, ctx, aside)
  }

  // A rated percent or amount ("$50 per month") against the same figure with no rate in the evidence.
  if (tok.rate !== undefined && (shape.cls.startsWith('cur:') || shape.cls.startsWith('pct') || shape.cls.startsWith('pp'))) {
    const baseCls = shape.cls.slice(0, shape.cls.length - tok.rate.length)
    const unrated = lookup(ev.strong, { cls: baseCls, unit: '' }, outNeg, key).filter((e) => e.cls === baseCls).filter(allow)
    if (unrated.length > 0) return matched(tok, 'traced', unrated, outNeg, undefined, false, ctx, aside)
  }

  // 2. The evidence is more precise and rounds to what the output shows.
  for (const v of variants) {
    const rounded = matcher.findRounded('strong', tok, tok.scale, v.shape, outNeg, mantissa, v.bare)
    if (rounded !== null) return matched(tok, 'rounded', rounded.ents, outNeg, rounded.label, v.unverified, ctx, aside)
  }

  // 3. A declared derivation of evidence numbers.
  // A time of day (5pm) is read, not computed: it is never a sum, a difference or a ratio of other numbers.
  if (ctx.derivations.size > 0 && !matcher.capHit && !isClockUnit(tok)) {
    let reversed = false
    for (const v of variants) {
      const hit = matcher.findDerived(tok, tok.scale, v.shape, outNeg, mantissa, v.bare)
      if (hit === null) continue
      if (hit.reversedOnly) {
        // Keep looking: another unit reading may match in the stated order.
        reversed = true
        continue
      }
      // So many ways to build the number that matching one says little.
      if (hit.matches > ctx.maxMatches || hit.density >= ctx.maxDensity) return unknownTrace(tok, 'derivation-too-likely')
      // A ratio rounded to a single digit ("5") lands on a candidate by chance: ratios of unrelated numbers cluster
      // among small integers, and one digit says too little to tell a derivation from luck.
      if (!hit.exact && hit.cand.kind === 'ratio' && mantissa > 0n && mantissa < 10n) return unknownTrace(tok, 'coarse-derivation')
      // A whole number 0 or 1 that only a rounding builds (a ratio of 0.5, 5% of $10, a 0.4% change) is the same: a claim
      // of zero or one is the one most worth checking, and some derivation of a page of numbers rounds to it by chance.
      if (!hit.exact && mantissa < 2n && tok.scale <= 0 && hit.cand.kind !== 'average' && hit.cand.kind !== 'sum' && hit.cand.kind !== 'difference') {
        return unknownTrace(tok, 'coarse-derivation')
      }
      const detail: DerivationDetail = {
        kind: hit.cand.kind,
        operands: hit.cand.operands.map((o) => o.ref),
        exact: hit.exact,
        matches: hit.matches,
        ...(hit.label !== undefined ? { rounding: hit.label } : {}),
      }
      // A derivation is already guarded and counted (`matches`, density), so a unit on one side only stays a marked
      // match here; a sign the output dropped is unknown in strict sign mode.
      if (signHeld(tok, hit.signDiffers, ctx.signMode, aside)) return unknownTrace(tok, 'sign-differs')
      // A year or an ordinal (2031, 3rd) is a label. A derivation can build one by coincidence, and a count between
      // 1900 and 2100 written without a separator reads as a year, so the kit cannot tell: never a pass.
      if (isLabel(tok)) return unknownTrace(tok, 'label-derivation')
      return { token: tok, status: 'derived', evidence: [], derivation: detail, ...(v.unverified || hit.unitUnverified ? { unitUnverified: true as const } : {}), ...(hit.signDiffers ? { signDiffers: true as const } : {}) }
    }
    if (reversed) return unknownTrace(tok, 'derivation-direction')
    // Only a pair of identical evidence values, or a zero operand, builds it: that says nothing about the claim.
    for (const why of HELD_REASONS) {
      if (matcher.held[why].length === 0) continue
      for (const v of variants) {
        if (matcher.findDerived(tok, tok.scale, v.shape, outNeg, mantissa, v.bare, why) !== null) return unknownTrace(tok, why)
      }
    }
  }

  // 4. Matches only under another reading of an ambiguous number: cannot tell.
  if (weakHit(tok, outNeg, key, mantissa, variants, ev, matcher, ctx)) return unknownTrace(tok, 'ambiguous-reading')

  // 5. The search was too large to run.
  if (ctx.derivations.size > 0 && matcher.capHit) return unknownTrace(tok, 'candidate-cap')
  if (matcher.scaleCapped) return unknownTrace(tok, 'scale-cap')

  // "About 1,200" from 1,234 and "nearly 80%" from 78.4%: trailing zeros are a rounding the writer did not spell out.
  if (coarselyRounded(tok, outNeg, mantissa, variants, matcher)) return unknownTrace(tok, 'coarse-rounding')

  // "the 30th" next to a date whose day is 30: a day of the month or a rank, the kit cannot tell.
  if (tok.kind === 'ordinal' && lookup(ev.strong, { cls: 'date', unit: 'day' }, false, key).length > 0) return unknownTrace(tok, 'ordinal-date')

  // A bare hour with am or pm ("5pm") is not cleared by a unit-less number of the same size (a 5.0 rating): cannot tell.
  if (tok.kind === 'time' && bareHourMatches(tok, ev)) return unknownTrace(tok, 'unit-unverified')

  // 6. Positive finding: not in the evidence.
  const near = nearMisses(tok, shape, outNeg, key, ev, ctx)
  return { token: tok, status: 'untraced', evidence: [], ...(near.length > 0 ? { nearMisses: near } : {}) }
}

/** Is the hour of a bare "5pm" (no minutes written) the same size as a unit-less number in the evidence? */
function bareHourMatches(tok: NumberToken, ev: Evidence): boolean {
  if (tok.unit !== 'am' && tok.unit !== 'pm') return false
  if (tok.raw.includes(':') || tok.value.length > 4) return false
  let hour = Number(tok.value) / 60
  if (!Number.isInteger(hour)) return false
  hour = hour % 12 === 0 ? 12 : hour % 12
  return lookup(ev.strong, { cls: 'plain', unit: '' }, false, String(hour), true).length > 0
}

/**
 * Does evidence round to this number at a coarser precision than the one it shows? "1,200" has no decimals, but the
 * two zeros may be rounding ("About 1,200" from 1,234): at hundreds 1,234 gives 1,200. Only a number written with
 * no decimals and no magnitude, in a kind that is a quantity, is looked at, only to turn a failure into `unknown`, and
 * only when the rounding place is below the evidence number's leading digit (90 is not "about 100").
 */
function coarselyRounded(
  tok: NumberToken,
  outNeg: boolean,
  mantissa: bigint,
  variants: readonly Variant[],
  matcher: Matcher,
): boolean {
  if (tok.kind !== 'count' && tok.kind !== 'decimal' && tok.kind !== 'percent' && tok.kind !== 'currency') return false
  if (tok.scale !== 0 || tok.magnitude !== undefined || tok.ambiguous) return false
  let m = mantissa
  for (let k = 1; k <= 6 && m !== 0n && m % 10n === 0n; k++) {
    m /= 10n
    for (const v of variants) {
      const hit = matcher.findRounded('strong', tok, -k, v.shape, outNeg, m, v.bare)
      // The rounding place must be below the evidence number's leading digit: 90 is not "about 100".
      if (hit !== null && hit.ents.some((e) => e.dec.n.toString().length - e.dec.s > k)) return true
    }
  }
  return false
}

function isLabel(tok: NumberToken): boolean {
  return tok.kind === 'year' || tok.kind === 'ordinal'
}

function isClockUnit(tok: NumberToken): boolean {
  return tok.kind === 'time' || tok.unit === 'am' || tok.unit === 'pm'
}

interface Variant {
  readonly shape: Shape
  readonly bare: boolean
  /** A match through this variant has its unit present on only one side. */
  readonly unverified: boolean
}

const BARE_SHAPE: Shape = { cls: 'plain', unit: '' }

/**
 * Is there a link to the evidence for this reading of the number: an exact match, a
 * rounded match, or (when asked) a derivation, in any of the given sources and unit variants?
 */
function linksVia(
  tok: NumberToken,
  scale: number,
  outNeg: boolean,
  mantissa: bigint,
  key: string,
  sources: readonly ('strong' | 'weak')[],
  withDerived: boolean,
  variants: readonly Variant[],
  ev: Evidence,
  matcher: Matcher,
  ctx: Ctx,
): boolean {
  const allow = (e: Ent): boolean => key === '0' || signAllowed(tok, outNeg, e.neg, ctx.signMode)
  for (const v of variants) {
    for (const src of sources) {
      if (lookup(src === 'strong' ? ev.strong : ev.weak, v.shape, outNeg, key, v.bare).some(allow)) return true
      if (matcher.findRounded(src, tok, scale, v.shape, outNeg, mantissa, v.bare) !== null) return true
    }
    // Another reading that is a derivation of the evidence is no more certain than the other links.
    if (withDerived && !matcher.capHit && matcher.findDerived(tok, scale, v.shape, outNeg, mantissa, v.bare) !== null) return true
  }
  return false
}

/** Does the number match only through another reading, exactly, after rounding, or by derivation? */
function weakHit(
  tok: NumberToken,
  outNeg: boolean,
  key: string,
  mantissa: bigint,
  variants: readonly Variant[],
  ev: Evidence,
  matcher: Matcher,
  ctx: Ctx,
): boolean {
  if (linksVia(tok, tok.scale, outNeg, mantissa, key, ['weak'], false, variants, ev, matcher, ctx)) return true
  return alternateLinks(tok, variants, ev, matcher, ctx)
}

/** Does any other reading of the number link to the evidence? */
function alternateLinks(
  tok: NumberToken,
  variants: readonly Variant[],
  ev: Evidence,
  matcher: Matcher,
  ctx: Ctx,
): boolean {
  for (const alt of tok.alternates ?? []) {
    const d = parseDecimal(alt.value)
    const altMantissa = mantissaAt(d.n < 0n ? { n: -d.n, s: d.s } : d, alt.scale)
    if (altMantissa === null) continue
    const altNeg = writtenNegative(alt.value, tok.signStyle)
    if (linksVia(tok, alt.scale, altNeg, altMantissa, absKey(alt.value), ['strong', 'weak'], true, variants, ev, matcher, ctx)) return true
  }
  return false
}

/**
 * A match whose unit is only on one side (`5pm` against `5.0`, `30 days` against `30`) is `unknown`,
 * unless the caller opted into bare-unit matching: then `optIn` is set and the match is kept and marked.
 */
function matched(
  tok: NumberToken,
  status: 'traced' | 'rounded',
  ents: readonly Ent[],
  outNeg: boolean,
  rounding: RoundLabel | undefined,
  optIn: boolean,
  ctx: Ctx,
  aside = false,
): NumberTrace {
  const ordered = [...ents.filter((e) => e.neg === outNeg), ...ents.filter((e) => e.neg !== outNeg)]
  const first = ordered[0]
  const best = first === undefined ? [] : ordered.filter((e) => e.neg === first.neg)
  const signDiffers = first !== undefined && first.neg !== outNeg && first.key !== '0'
  const shape = shapeOf(tok)
  const oneSided = best.length > 0 && shape.cls === 'plain' && best.every((e) => e.unit !== shape.unit)
  if (oneSided && !optIn) return unknownTrace(tok, 'unit-unverified')
  if (signHeld(tok, signDiffers, ctx.signMode, aside)) return unknownTrace(tok, 'sign-differs')
  const unitUnverified = optIn || oneSided
  return {
    token: tok,
    status,
    evidence: uniqueRefs(best),
    ...(rounding !== undefined ? { rounding } : {}),
    ...(signDiffers ? { signDiffers: true as const } : {}),
    ...(unitUnverified ? { unitUnverified: true as const } : {}),
  }
}

function traceDate(tok: NumberToken, ev: Evidence, info: DateInfo | undefined): NumberTrace {
  if (tok.part !== undefined && info !== undefined && info.tuples.length > 0) {
    // A date traces as a whole date: day, month and year together. Its parts appearing in
    // other dates only weakly support it.
    info.ok ??= info.tuples.every((t) => ev.dateKeys.has(tupleKey(t.parts)))
    if (info.ok) {
      // The evidence dates that contain this token's own date, not the first date of the cluster.
      const mine = info.owner.get(tok) ?? info.tuples[0]
      return { token: tok, status: 'traced', evidence: (mine === undefined ? [] : ev.dateKeys.get(tupleKey(mine.parts)) ?? []).slice(0, MAX_LIST) }
    }
    const byParts = traceDateParts(tok, ev)
    return byParts.status === 'untraced' ? byParts : unknownTrace(tok, tok.part === 'hour' || tok.part === 'minute' || tok.part === 'second' ? 'time-not-in-evidence' : 'date-not-in-evidence')
  }
  return traceDateParts(tok, ev)
}

function traceDateParts(tok: NumberToken, ev: Evidence): NumberTrace {
  const key = absKey(tok.value)
  if (tok.part === undefined) {
    // Day/month order unknown. An identical date text vouches for it; anything else cannot.
    if (tok.groupRaw !== undefined) {
      const same = ev.groupRaw.get(tok.groupRaw, key)
      if (same !== undefined && same.length > 0) return { token: tok, status: 'traced', evidence: uniqueRefs(same) }
    }
    // The same values written another way (a date elsewhere, a bare month or year) leave it unknown.
    if (ev.dateAny.get(key) !== undefined || ev.byValue.get(key) !== undefined) return unknownTrace(tok, 'ambiguous-date-order')
    return untracedDate(tok, key, ev)
  }
  const shape: Shape = { cls: 'date', unit: tok.part }
  const exact = lookup(ev.strong, shape, false, key)
  if (exact.length > 0) return { token: tok, status: 'traced', evidence: uniqueRefs(exact) }
  if (tok.part === 'year') {
    // A bare year elsewhere vouches for it; a year with a unit (2026 kg) does not.
    const plain = lookup(ev.strong, { cls: 'plain', unit: '' }, false, key, true)
    if (plain.length > 0) return { token: tok, status: 'traced', evidence: uniqueRefs(plain) }
    // Digits inside an identifier (FY2026) are only a weak link.
    if (lookup(ev.weak, { cls: 'plain', unit: '' }, false, key, true).length > 0) return unknownTrace(tok, 'ambiguous-reading')
  }
  // Evidence dates whose order was unclear cannot vouch for a known role.
  if (ev.dateUnknown.get(key) !== undefined) return unknownTrace(tok, 'ambiguous-date-order')
  return untracedDate(tok, key, ev)
}

function untracedDate(tok: NumberToken, key: string, ev: Evidence): NumberTrace {
  const near: NearMiss[] = []
  for (const e of ev.byValue.get(key) ?? []) {
    near.push({ evidence: e.ref, reason: e.token.kind === 'date-part' ? 'unit-differs' : 'kind-differs' })
    if (near.length >= 3) break
  }
  return { token: tok, status: 'untraced', evidence: [], ...(near.length > 0 ? { nearMisses: near } : {}) }
}

function nearMisses(tok: NumberToken, shape: Shape, outNeg: boolean, key: string, ev: Evidence, ctx: Ctx): NearMiss[] {
  const near: NearMiss[] = []
  for (const e of ev.byValue.get(key) ?? []) {
    let reason: NearMiss['reason']
    if (e.cls === shape.cls) {
      if (shape.cls === 'plain' && e.unit !== shape.unit && e.unit !== '' && shape.unit !== '') reason = 'unit-differs'
      else if (!signAllowed(tok, outNeg, e.neg, ctx.signMode)) reason = 'sign-differs'
      else continue
    } else if (e.cls === 'date' || shape.cls === 'date') {
      reason = 'kind-differs'
    } else {
      reason = 'unit-differs'
    }
    near.push({ evidence: e.ref, reason })
    if (near.length >= 3) break
  }
  return near
}

