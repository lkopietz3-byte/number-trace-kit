# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (M1: an unread number is never silently dropped)

- `traceNumbers` returns `skipped`: every stretch of the output that holds digits but was not read as a number, with `raw`, `start`, `end` and a `reason` (`identifier`, `unread-glued-form` or `ignored`), and `counts.skipped` (its length). New exported types: `SkippedNumber`, `SkipReason`, `TraceCounts`. `TraceResult.counts` is now a `TraceCounts`, which adds `skipped` to the six statuses.
- A number glued to letters the kit does not know and cannot call an identifier (`12foo`, `50p`, `9999kr`, `Rs1,500`) is `unread-glued-form`, and the verdict is `unknown`, not `clean`. `ignore` and `ignorePattern` cover it.

### Fixed (M1)

- Glued units are read: `W`, `kW`, `MW`, `Hz`, `kHz`, `MHz`, `GHz`, `dB`, `kcal`, `cal`, `mAh`, `Wh`, `kWh`, `nm`, `Mbps`, `Gbps`, `kbps`, `days`, `d`, `wk`, `y`, `bp`, `X` and more, so `250W` against `200W` is `untraced`. Case-insensitive where capitals change nothing (`9000KG`).
- A comma chain after a letter prefix (`Rs1,500`, `H2,500`) is skipped whole instead of being read as the digits after the comma.
- Underscores around a number (`_12.5%_`, `1766____`) no longer hide it; an underscore inside a word still makes it a name.
- A number followed by a hyphen and a unit, percent or currency word (`first-100-days`, `year-over-year-12-percent`) is read as a quantity instead of a name.
- A dotted chain with a second decimal point (`1,234.5.6`) is listed in `skipped` instead of vanishing.
- Decimal digits above the Basic Multilingual Plane (`𝟓𝟎`) are listed in `skipped` as an unread form instead of vanishing.

## [0.1.0] - unreleased

### Fixed (final release review)

- A derivation found only in the reverse order no longer hides a permitted derivation in the stated order that matches under another unit reading.
- The 60-digit limit counts the expanded value, so a long mantissa with an exponent or magnitude is `unknown` on the text path as it already was on the token path.
- Currency symbols are looked up in a `Map`, so an inherited property on `Object.prototype` cannot read as a symbol.

First version. Private (`"private": true`, `UNLICENSED`) and not published
anywhere.

### Breaking changes

None. There is no earlier release to migrate from. Calls that adopters should
expect to throw, so a typo or a bad input cannot pass quietly:

- An unknown option name is a `RangeError` (`traceNumbers`, `extractNumbers`,
  `reconcile`). Migration: remove or correct the option name.
- A non-integer `number`, `NaN` or `Infinity` amount in `reconcile` is a
  `TypeError`. Migration: pass decimal strings, or integers in minor units, or
  set `allowFloat: true` knowingly.
- An unsupported locale language is a `RangeError`. Migration: pass a language
  from the README list, or omit `locale`.
- Sparse arrays, wrong types, malformed pre-extracted tokens, and a `RegExp`
  that is not a genuine `RegExp` are a `TypeError`. Migration: pass plain
  arrays and tokens exactly as `extractNumbers` returns them.

### Added

- `extractNumbers(text, { locale?, parenthesesAreNegative? })`: tokens with an
  exact decimal `value`, the precision shown (`scale`, negative for
  `1.2 million`), `kind`, `unit` or `currency`, sign style, and offsets into the
  original text. Reads thousands separators under a locale (including Indian
  and Swiss grouping), negatives and accounting parentheses, leading decimals
  (`.5%`, `$.99`), ranges (a unit, sign, currency or magnitude written once
  covers every member), dimensions (`3 x 4 cm`), magnitude suffixes and words,
  percents and percentage points, currencies, cents, ordinals, measurement
  units, dates and times of day by part, and scientific notation. Forms that
  can be read more than one way (a lone group of three digits, `4K`, a
  day-and-month order, an inline exponent, a fraction) come back with
  `ambiguous: true`, a reason and the other readings. Nothing is guessed.
  Identifiers glued to Latin letters (`X3`, `v2.1`, `COVID-19`, `5G`), version
  strings and hyphenated model names are skipped; letters of other scripts
  never hide a number. Full-width forms and the decimal digits of every BMP
  script are folded to ASCII with offsets kept. Linear time.
- `traceNumbers(output, evidence, options)`: each output number is `traced`,
  `rounded` (half-up and half-even, reported), `derived`, `untraced`, `ignored`
  or `unknown`, with a `clean`, `untraced` or `unknown` verdict. Units, kinds
  and signs must agree. Evidence may be a string, `{ id, text, scale?, currency? }`
  documents, or pre-extracted tokens. A number that matches only through
  another reading of an ambiguous number, a derivation in the opposite
  direction from the evidence order, a search larger than the cap, or a date
  whose parts appear only in other dates is `unknown`, never a pass and never a
  failure.
- Whole-date matching: a date traces as day, month and year together, in any
  written format.
- Derivations, opt in and counted against a hard cap before anything runs:
  `sum`, `difference`, `ratio`, `percent-change`, `percent-of`, `average` and
  `product`; `maxOperands: 3` for three-operand `sum`, `difference` and
  `average`; `roundSums` and `evidenceOrder`.
- The coincidence guard (`maxDerivationMatches`, default 3, and
  `maxDerivationDensity`, default 0.5; reason `derivation-too-likely`): on a
  page with many numbers a derived figure that can be built many ways is
  `unknown`, not `derived`.
- Presets `strict` (the default) and `report`, and the options
  `evidenceScale`, `evidenceCurrency` (and per-document `scale` and
  `currency`), `allowBareEvidence`, `allowBareOutput`, `signMode`, `rounding`,
  `ignore`, `ignoreKinds`, `ignoreYears`, `ignoreSmallIntegersUpTo` and
  `ignorePattern`.
- `reconcile({ rows, total, tolerance? }, options?)` and
  `reconcileComponents({ parts, total, tolerance? }, options?)`: exact decimal
  sums with the signed difference. Printed amounts (`"38,400"`, `"$600.00"`,
  `"(557)"`) are accepted as strings. Floats are a `TypeError` unless
  `allowFloat`.
- Tests: a verdict regression table (`test/verdict-table.test.ts`), a seeded
  combinatorial sweep (`test/sweep.test.ts`), a round-trip of 27 locales
  against the platform's own number formatting, a deterministic fuzz, and
  timing checks on hostile input.
