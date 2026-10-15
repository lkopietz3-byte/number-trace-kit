# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-14

First release. MIT license.

### Added

- `extractNumbers(text, { locale?, parenthesesAreNegative? })`: every number in a text as a token with an exact decimal `value`, the precision shown (`scale`, negative for `1.2 million`), `kind`, `unit` or `currency`, sign style, and offsets into your original text. It reads thousands separators under a locale (including Indian and Swiss grouping), negatives and accounting parentheses, leading decimals (`.5%`, `$.99`), ranges (a unit, sign, currency or magnitude written once covers every member), dimensions (`3 x 4 cm`), magnitude suffixes and words (`1.2M`, `lakh`, `Millionen`, `万`), percents and percentage points, currencies and cents, ordinals, measurement units (including bits and bytes, temperatures and data rates), clock times, dates, vulgar fractions and scientific notation. Full-width and non-Latin decimal digits are folded to ASCII with offsets kept. Linear time.
- Forms that can be read more than one way (a lone group of three digits, `4K`, a day-and-month order, an inline exponent, a fraction, an en dash that may be a minus) come back with `ambiguous: true`, a reason and the other readings. Nothing is guessed.
- Identifiers (`X3`, `v2.1`, `COVID-19`, `5G`, hyphenated model names), versions and addresses are skipped and listed. A number glued to letters the kit cannot read (`12foo`, `Rs1,500`) is listed in `skipped` and makes the verdict `unknown`. `traceNumbers` returns `skipped` and `counts.skipped`, so no stretch of digits is dropped silently.
- `traceNumbers(output, evidence, options)`: each output number is `traced`, `rounded` (half-up and half-even, reported), `derived`, `untraced`, `ignored` or `unknown`, with a verdict of `clean`, `untraced` or `unknown`. Units, kinds, currencies and signs must agree. Evidence may be a string, `{ id, text, scale?, currency?, scaleApplies? }` documents, or pre-extracted tokens. A match that only works through another reading of an ambiguous number, a derivation in the opposite direction from the evidence order, a search larger than the cap, a locale guess, or a unit on one side only is `unknown`, never a pass and never a failure.
- Whole-date matching: a date traces as day, month and year together, in any written format. Month names are read in English, German, French, Spanish, Italian, Portuguese, Dutch and Swedish, and in East Asian date forms. A worded date in a locale without month names is `unknown`.
- Derivations, opt in and counted against a hard cap before anything runs: `sum`, `difference`, `ratio`, `percent-change`, `percent-of`, `average` and `product`; `maxOperands: 3`, `roundSums`, `evidenceOrder`. A coincidence guard (`maxDerivationMatches`, `maxDerivationDensity`) turns a figure that can be built many ways into `unknown`. Identical values never pair, a derived year or ordinal, a zero built only from a zero operand and a one-digit inexact ratio are `unknown`, not `derived`.
- Presets `strict` (the default) and `report`, and the options `locale`, `evidenceLocale`, `evidenceScale`, `evidenceCurrency`, `evidenceScaleApplies`, `allowBareEvidence`, `allowBareOutput`, `signMode`, `rounding`, `maxCandidates`, `maxEvidenceNumbers`, `ignore`, `ignoreKinds`, `ignoreYears`, `ignoreSmallIntegersUpTo`, `ignoreStructure` and `ignorePattern`.
- `reconcile({ rows, total, tolerance? }, options?)` and `reconcileComponents({ parts, total, tolerance? }, options?)`: exact decimal sums with the signed difference. Printed amounts (`"38,400"`, `"$600.00"`, `"(557)"`) are accepted as strings, and `decimalMark: ','` reads tables printed with a decimal comma.
- Locales: 41 languages with their regional exceptions, checked against Node's ICU in every locale it has (338 locales, 83,824 printed decimals, amounts and percents, 0 mismatches) and rounding and derivations against Python's `decimal` (50,000 cases, 0 mismatches).
- `METHOD.md`: every verdict and default with its reason and how to change it, each heuristic with its measured false-flag or false-pass rate, and the limits.
- `bench/` (in the repository, not in the package) and `npm run bench`: false-fail, catch and false-pass with denominators and 95% intervals on a 203-item labeled benchmark, 289 real RAGTruth answers, FinanceBench and a 150-answer holdout labeled before the kit ran, with four plain checkers beside the kit.

### Behavior to know

- Bad input throws instead of passing: an unknown option name, a non-integer `number`, `NaN` or `Infinity` amount in `reconcile`, an unsupported locale language, sparse arrays, wrong types, malformed tokens, evidence with more than 500,000 numbers, and texts over 5,000,000 UTF-16 units.
- Returned tokens have no prototype. `token.hasOwnProperty` is not there; spread, `JSON.stringify`, `Object.keys` and property reads work as usual.
- Options, evidence documents and rows are read as own properties only.
- Limits are stated plainly in the README: it checks numbers, not sentences, so a right number in the wrong place or a flipped direction passes.
