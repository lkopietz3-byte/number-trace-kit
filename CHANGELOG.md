# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial version (0.1.0, private, not published).
- `extractNumbers(text, { locale?, parenthesesAreNegative? })`: tokens with an
  exact decimal `value`, the precision shown (`scale`, negative for
  `1.2 million`), `kind`, `unit`/`currency`, sign style and offsets into the
  original text. Handles thousands separators under a locale, negatives and
  accounting parentheses, ranges (a unit written once covers both numbers),
  magnitude suffixes and words, percents and percentage points, currencies,
  ordinals, measurement units, dates and times of day by part, and scientific
  notation. Forms that can be read more than one way come back with
  `ambiguous: true`, a reason and the other readings; nothing is guessed.
  Identifiers glued to letters (`X3`, `v2.1`, `COVID-19`, `5G`) and dotted
  chains (`1.2.3`) are skipped. Full-width and Arabic-Indic digits are folded
  to ASCII. Linear time.
- `traceNumbers(output, evidence, options)`: each output number is `traced`,
  `rounded` (half-up and half-even, reported), `derived` (`sum`, `difference`,
  `ratio`, `percent-change`, `percent-of`; pairwise, opt-in, capped),
  `untraced`, `ignored` or `unknown`, with a `clean` / `untraced` / `unknown`
  verdict. Units and kinds must match. Evidence may be a string, `{ id, text }`
  documents, or pre-extracted tokens.
- `reconcile({ rows, total, tolerance })` and `reconcileComponents({ parts, total })`:
  exact decimal sums with the signed difference. Floats are a `TypeError`
  unless `allowFloat`.
- Verdict regression table (`test/verdict-table.test.ts`), written before the
  implementation.
