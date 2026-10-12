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
  | 'identifier'
  | 'too-long'
  | 'magnitude'

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
  /**
   * The power of ten the text itself applies: 6 for `3 million` and `3.000000 million`, 3 for `4K`, -3 for `5e-3`.
   * Absent when the number is written out. An evidence `scale` hint is never applied to a number that has one.
   */
  readonly magnitude?: number
  /** Written in parentheses ("(557)") but read as positive because it is a bare number; it may be an accounting negative. */
  readonly parenthesized?: true
  /** For date parts and fraction halves: the whole text this part came from, such as `10/12/2026` or `3/4`. */
  readonly groupRaw?: string
  /** `start` and `end` mark the two numbers of a written range such as `10-12`. */
  readonly range?: 'start' | 'end'
  /** The separator does not fit the locale, so the primary reading is a guess about the locale. */
  readonly localeGuess?: true
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

export type Derivation = 'sum' | 'difference' | 'ratio' | 'percent-change' | 'percent-of' | 'average' | 'product'
export type RoundingMode = 'half-up' | 'half-even'

/** A piece of evidence text with the id you want cited. */
export interface EvidenceDoc {
  readonly id: string
  readonly text: string
  /**
   * The scale the bare numbers in this document are printed in: `'thousand'`, `'million'`,
   * `'billion'`, `'trillion'`, or an exponent of ten from 0 to 12. The kit never guesses it
   * from a header such as "(in thousands)"; you say it. Percents, years, dates and numbers
   * that carry their own magnitude or unit are left alone.
   */
  readonly scale?: EvidenceScale
  /** The currency code of the bare numbers in this document (a table that prints `$` on its first row only). */
  readonly currency?: string
}

export type EvidenceScale = 'thousand' | 'million' | 'billion' | 'trillion' | number

/** A pre-extracted token used as evidence, optionally labeled with where it came from. */
export interface EvidenceNumber extends NumberToken {
  readonly evidenceId?: string
}

export type EvidenceInput = string | readonly (EvidenceDoc | EvidenceNumber)[]

export type SignMode = 'explicit' | 'magnitude'

/** `strict`: no derivations. `report`: the derivations a financial report needs, the unit and sum-rounding allowances, and the coincidence guard. */
export type Preset = 'strict' | 'report'

export interface TraceOptions {
  /**
   * A named starting point; any other option you pass overrides it. `strict` allows no
   * derivations and no unit leniency (also the default). `report` turns on every derivation,
   * rounded sums and differences, bare-unit leniency in both directions, a candidate cap of
   * 50,000 and the coincidence guard.
   */
  readonly preset?: Preset
  /** Locale used to read the output text. Default `en-US`. */
  readonly locale?: string
  /** Locale used to read evidence text. Default: the same as `locale`. */
  readonly evidenceLocale?: string
  readonly parenthesesAreNegative?: boolean
  /** Allowed derivations. Default none: only direct matches and rounding trace. */
  readonly derivations?: readonly Derivation[]
  /** Rounding modes accepted when the output shows fewer decimals. Default both. */
  readonly rounding?: readonly RoundingMode[]
  /**
   * Most evidence numbers one derivation may combine: 2 (the default, pairs) or 3. At 3,
   * `sum`, `difference` (one figure less the other two) and `average` also try every
   * triple. The candidate cap counts the triples too.
   */
  readonly maxOperands?: 2 | 3
  /**
   * A derived number is `unknown` (`derivation-too-likely`) when more than this many candidates
   * produce the same displayed value: with that many ways to build it, a match says little.
   * Default 3. `derivation.matches` always reports the count.
   */
  readonly maxDerivationMatches?: number
  /**
   * A derived number is also `unknown` (`derivation-too-likely`) when candidates are this crowded around it:
   * the average number of candidates per displayed value within 25 units of the last digit on either side.
   * A random wrong number lands on a candidate with about this probability. Default 0.5; the `report`
   * preset sets the same value. Raise it to accept looser matches.
   */
  readonly maxDerivationDensity?: number
  /** Let a sum or difference match after display rounding ($17.6 million from two figures with three decimals). Default false. */
  readonly roundSums?: boolean
  /** `newest-first`: evidence lists the later period first, so a percent change reads against the order of mention. Default `oldest-first`. */
  readonly evidenceOrder?: 'oldest-first' | 'newest-first'
  /** The scale of the bare numbers in string evidence (and in documents that do not set their own). */
  readonly evidenceScale?: EvidenceScale
  /** The currency of the bare numbers in string evidence (and in documents that do not set their own). */
  readonly evidenceCurrency?: string
  /**
   * Let a bare output number trace to an evidence amount that has a currency
   * (`5,829 million` against `$5,829 million`). Marked `unitUnverified`. Default false.
   */
  readonly allowBareOutput?: boolean
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

/**
 * Why a stretch of the output was left unread: `identifier` (a name, version or code such as
 * `X3`, `v2.1`, `5G`), `unread-glued-form` (a number glued to letters the kit does not know,
 * such as `12foo` or `Rs1,500`; the verdict cannot be `clean`) or `ignored` (an unread form
 * that your `ignore` or `ignorePattern` option covers).
 */
export type SkipReason = 'identifier' | 'unread-glued-form' | 'ignored'

/** A stretch of the output text that holds digits the kit did not read as a number. */
export interface SkippedNumber {
  /** The exact source text, for example `250Wp` or `X3`. */
  readonly raw: string
  readonly start: number
  readonly end: number
  readonly reason: SkipReason
}

/** How many numbers ended in each status, and how many stretches were skipped. */
export interface TraceCounts extends Readonly<Record<TraceStatus, number>> {
  /** The length of `skipped`. */
  readonly skipped: number
}

export interface TraceResult {
  readonly verdict: TraceVerdict
  readonly numbers: readonly NumberTrace[]
  /**
   * Digits in the output text that were not read as numbers: identifiers, and glued forms the
   * kit cannot read. Empty when the output was given as tokens. An `unread-glued-form` entry
   * makes the verdict `unknown` unless a number is `untraced`.
   */
  readonly skipped: readonly SkippedNumber[]
  readonly counts: TraceCounts
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
