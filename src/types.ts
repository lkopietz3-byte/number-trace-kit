/** What a number token looks like. */
export type NumberKind =
  | 'percent'
  | 'currency'
  | 'count'
  | 'decimal'
  | 'year'
  | 'date-part'
  | 'ordinal'

/** The role of a number inside a date or a time of day, when it is known. */
export type DatePart = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'

/** Why a token could not be read one way only. */
export type AmbiguityReason =
  | 'separator'
  | 'suffix'
  | 'superscript'
  | 'date-order'
  | 'fraction'
  | 'too-long'

/** How a negative or explicitly signed number was written. */
export type SignStyle = 'minus' | 'plus' | 'parentheses'

/** One exact reading of an ambiguous token. */
export interface Reading {
  /** Exact decimal string, for example `"1234"` or `"1.234"`. */
  readonly value: string
  /** Decimals of precision the reading shows (negative for "1.2 million"-style forms). */
  readonly scale: number
}

/** One number found in a text. Offsets are UTF-16 indexes into the original text. */
export interface NumberToken {
  /** The exact source text of the number, including sign, currency and unit. */
  readonly raw: string
  readonly start: number
  readonly end: number
  /** The primary reading as an exact decimal string. Negative values start with `-`. */
  readonly value: string
  /**
   * Decimals of precision the text shows. `12.50` has scale 2, `1.2 million`
   * has scale -5 (it is precise to the nearest 100,000).
   */
  readonly scale: number
  readonly kind: NumberKind
  /** `%` or `pp` for percents, a canonical measurement unit such as `kg` or `day`, or `x`. */
  readonly unit?: string
  /** Canonical currency code such as `USD` or `EUR`. A bare `$` is read as `USD`. */
  readonly currency?: string
  readonly signStyle?: SignStyle
  /** For `date-part` tokens: which part of the date or time this is, when known. */
  readonly part?: DatePart
  /** For date parts and fraction halves: the whole text this part came from, such as `10/12/2026` or `3/4`. */
  readonly groupRaw?: string
  /** `start` and `end` mark the two numbers of a written range such as `10-12`. */
  readonly range?: 'start' | 'end'
  /** True when the text can be read more than one way. Never guessed silently. */
  readonly ambiguous: boolean
  readonly ambiguity?: AmbiguityReason
  /** The other readings of an ambiguous token. */
  readonly alternates?: readonly Reading[]
}

export interface ExtractOptions {
  /**
   * Decides which of `.` and `,` is the decimal mark and the order of numeric
   * dates. Default `en-US`. See the README for the supported language list.
   */
  readonly locale?: string
  /** Read `(1,234)`-style accounting negatives. Default true. */
  readonly parenthesesAreNegative?: boolean
}

export type Derivation = 'sum' | 'difference' | 'ratio' | 'percent-change' | 'percent-of'
export type RoundingMode = 'half-up' | 'half-even'

/** A piece of evidence text with the id you want cited. */
export interface EvidenceDoc {
  readonly id: string
  readonly text: string
}

/** A pre-extracted token used as evidence, optionally labeled with where it came from. */
export interface EvidenceNumber extends NumberToken {
  readonly evidenceId?: string
}

export type EvidenceInput = string | readonly (EvidenceDoc | EvidenceNumber)[]

export type SignMode = 'explicit' | 'magnitude'

export interface TraceOptions {
  /** Locale used to read the output text. Default `en-US`. */
  readonly locale?: string
  /** Locale used to read evidence text. Default: the same as `locale`. */
  readonly evidenceLocale?: string
  readonly parenthesesAreNegative?: boolean
  /** Allowed derivations. Default none: only direct matches and rounding trace. */
  readonly derivations?: readonly Derivation[]
  /** Rounding modes accepted when the output shows fewer decimals. Default both. */
  readonly rounding?: readonly RoundingMode[]
  /** Hard cap on derivation candidates for one call. Default 5000, maximum 1000000. */
  readonly maxCandidates?: number
  /**
   * Let a percent or currency number in the output trace to an evidence number
   * that has no unit at all (an invoice table that prints `1,234.50` where the
   * summary says `$1,234.50`). Marked `unitUnverified`. Default false.
   */
  readonly allowBareEvidence?: boolean
  /** `explicit` (default): only an explicit sign in the output must agree. `magnitude`: signs are ignored. */
  readonly signMode?: SignMode
  /** Output numbers to skip: exact raw text (string) or a plain value (number). */
  readonly ignore?: readonly (string | number)[]
  readonly ignoreKinds?: readonly NumberKind[]
  /** Skip numbers read as years (including the year of a date). Default false. */
  readonly ignoreYears?: boolean
  /** Skip unit-less whole numbers from 0 up to this value. Default off. */
  readonly ignoreSmallIntegersUpTo?: number
  /**
   * Skip an output number when this pattern matches a text window that
   * overlaps the number. The window is the number plus at most 32 characters
   * before it and 16 after, so the pattern never sees more than that.
   */
  readonly ignorePattern?: RegExp
}

export interface EvidenceRef {
  readonly id: string
  readonly raw: string
  readonly start: number
  readonly end: number
}

export type TraceStatus = 'traced' | 'rounded' | 'derived' | 'untraced' | 'ignored' | 'unknown'

export interface DerivationDetail {
  readonly kind: Derivation
  readonly operands: readonly EvidenceRef[]
  /** True when the derived value equals the output exactly, false when it only rounds to it. */
  readonly exact: boolean
  readonly rounding?: 'half-up' | 'half-even' | 'either'
  /** How many candidate derivations produced this number. More than one means a loose match. */
  readonly matches: number
}

export interface NearMiss {
  readonly evidence: EvidenceRef
  readonly reason: 'unit-differs' | 'kind-differs' | 'sign-differs'
}

export interface NumberTrace {
  readonly token: NumberToken
  readonly status: TraceStatus
  /** Evidence this number matched (traced and rounded). At most 8 are listed. */
  readonly evidence: readonly EvidenceRef[]
  readonly rounding?: 'half-up' | 'half-even' | 'either'
  readonly derivation?: DerivationDetail
  /** Why the status is `unknown` or `ignored`. */
  readonly reason?: string
  /** The match differs in sign (the output dropped a sign the evidence has). */
  readonly signDiffers?: true
  /** The evidence number has no unit while the output number has one. */
  readonly unitUnverified?: true
  /** For `untraced`: evidence with the same value but a different unit, kind or sign. */
  readonly nearMisses?: readonly NearMiss[]
}

export type TraceVerdict = 'clean' | 'untraced' | 'unknown'

export interface TraceResult {
  readonly verdict: TraceVerdict
  readonly numbers: readonly NumberTrace[]
  readonly counts: Readonly<Record<TraceStatus, number>>
  /** How many numbers were found in the evidence. */
  readonly evidenceNumbers: number
  /** How many derivation candidates were generated. */
  readonly derivationCandidates: number
  /** True when the derivation search was larger than `maxCandidates` and was not run. */
  readonly candidateCapHit: boolean
}

/** A money-like amount: an exact decimal string (major units) or an integer (minor units). */
export type Amount = string | number | bigint

export interface ReconcileOptions {
  /** Decimals in a minor unit; applies to integer `number` and `bigint` amounts. Default 2. */
  readonly minorUnitDigits?: number
  /**
   * Accept non-integer numbers. When true, every JS `number` is read as a
   * major-unit decimal through its shortest round-trip text. Default false.
   */
  readonly allowFloat?: boolean
}

export interface ReconcileRow {
  readonly label: string
  readonly amount: Amount
}

export interface ReconcileInput {
  readonly rows: readonly ReconcileRow[]
  readonly total: Amount
  /** Largest accepted absolute difference. Default `'0'`. */
  readonly tolerance?: Amount
}

export interface ReconcileResult {
  readonly ok: boolean
  /** Sum of the rows as an exact decimal string. */
  readonly sum: string
  readonly total: string
  /** `sum - total`. `'0'` when equal. */
  readonly difference: string
  readonly tolerance: string
  readonly rows: number
}

export interface ReconcileComponentsInput {
  readonly parts: Readonly<Record<string, Amount>>
  readonly total: Amount
  readonly tolerance?: Amount
}
