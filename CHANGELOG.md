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
  original text. Handles thousands separators under a locale (including
  Indian and Swiss grouping), negatives and accounting parentheses, ranges
  (a unit written once covers both numbers), magnitude suffixes and words,
  percents and percentage points, currencies, ordinals, measurement units,
  dates and times of day by part, and scientific notation. Forms that can be
  read more than one way (a lone group of three digits, `4K`, a day/month
  order, an inline exponent, a fraction) come back with `ambiguous: true`, a
  reason and the other readings; nothing is guessed. Identifiers glued to
  Latin letters (`X3`, `v2.1`, `COVID-19`, `5G`) and dotted chains (`1.2.3`)
  are skipped; letters of other scripts never hide a number. Full-width forms
  and the decimal digits of every BMP script are folded to ASCII. Linear time.
- `traceNumbers(output, evidence, options)`: each output number is `traced`,
  `rounded` (half-up and half-even, reported), `derived` (`sum`, `difference`,
  `ratio`, `percent-change`, `percent-of`; pairwise, opt-in, counted against a
  hard cap before anything runs), `untraced`, `ignored` or `unknown`, with a
  `clean` / `untraced` / `unknown` verdict. Units and kinds must match. Evidence
  may be a string, `{ id, text }` documents, or pre-extracted tokens. A number
  that matches only through another reading of an ambiguous number, a
  derivation in the opposite direction from the evidence order, or a search
  larger than the cap is `unknown`.
- Review round (aa77074 and after): scientific notation keeps its percent sign,
  currency and unit and consumes any exponent length; full-width letters and
  symbols are folded for every lookup; spaced unit abbreviations (`5 g`,
  `10 x`) keep their unit; accounting amounts between 1900 and 2100 stay
  negative; derivation lookups no longer rescan colliding candidates; weak
  links check rounding and derivations and honor the candidate cap; exact
  derivations work with `rounding: []`; ordinary-space grouping under comma
  locales; same-class `percent-of`; sparse arrays no longer read inherited
  items; combining marks stay with their letter; slash chains are one group;
  supplied tokens obey the 60-digit policy.
- Second review round (edc9c99): slash chains and Indian grouping are scanned
  once (were quadratic); units survive magnitude words (`1 million kg`); a
  date-shaped tail cannot escape a slash chain; a sign, magnitude, percent,
  currency or unit written on one end of a range, or one side of a dimension
  (`3 x 4 cm`), reaches every member; ranges also join with a spaced en dash
  and "to", and date ranges share their month; `x` before a number is a
  multiplication sign, not a unit; `allowBareEvidence` applies to rounded,
  derived and weak matches; an ambiguous date is `unknown` against the same
  values written as bare month, day or year; tokens whose ambiguity flags
  contradict each other are a `TypeError`.
- Third review round (c9684f4): version identifiers are consumed whole, build
  and prerelease suffixes included; a scientific exponent is never shared across
  a range; derived numbers follow the one-sided unit policy; a shared magnitude
  also scales alternate readings; `ignorePattern` must be a genuine RegExp
  (checked through the built-in getters); the Kelvin and Angstrom signs read as
  K and Å.
- Fourth review round (f6fad53) and a seeded combinatorial sweep
  (`test/sweep.test.ts`): a locale guess stays a guess whatever alternates it
  gains (`localeGuess`); a slash chain outranks other ambiguity; `%` after a
  magnitude is kept; a date part followed by an exponent is flagged; the micro
  sign is a unit prefix or a boundary, not a letter; a measurement no longer
  vouches for a date's year and identifier digits give `unknown`; a shared
  loose magnitude keeps the unscaled reading beside other readings; a version
  with three-digit parts and a prerelease suffix is a version;
  `ignoreSmallIntegersUpTo` accepts only exact whole values.
- `average` derivation and the opt-in `maxOperands: 3` (three-operand `sum`,
  `difference` and `average`), from the labeled benchmark: honest reports use
  averages and three-figure sums. The candidate cap counts triples and still
  makes every non-direct number `unknown` when exceeded. A call without
  `maxOperands` is unchanged.
- Fifth review round (34140c5): leading decimals (`.5%`, `$.99`, `-.25`) are read
  as decimals, with the other locale convention a guess; a year-shaped number
  that inherits a unit or magnitude is not a year; a derived number that drops
  its sign is marked `signDiffers`; zero keeps its written sign through
  rounding. Changed row: `0.50` now traces to `.5` (it was untraced because the
  dot was dropped).
- Sixth review round (8b4e8cf): a range separator (hyphen, en dash, "to") before a
  leading decimal joins the endpoints; `5 $.99` and `.5 x .7 cm` keep their
  currency prefix and dimension operator; an exactly zero derivation matches a
  written `-0` while a tiny value that only rounds to zero does not; `0` and `-0`
  are one operand value; `signDiffers` is suppressed only for an exactly zero
  derivation.
- Field-trial round (b788dfd): whole-date matching (a date traces as day, month and
  year together; its parts elsewhere are only `unknown`); cents, months and points as
  units; hyphenated model names as identifiers; thousands-versus-decimal operands in
  derivations; the coincidence guard (`maxDerivationMatches`, default 3, and `maxDerivationDensity`, default 0.5; reason
  `derivation-too-likely`) and the `strict` and `report` presets; evidence `scale` and
  `currency` hints; `roundSums`; `evidenceOrder`; `allowBareOutput`; the `product`
  derivation; bare `(557)` answers to a minus sign and `$(557)` is negative;
  `reconcile` reads printed amounts (`"38,400"`, `"$600.00"`, `"(557)"`).
  Changed rows: `trace('2026-10-10', 'x 2026')` and similar partial-date rows are now
  `unknown` (they were `traced`); `1.250 + 1.250` now derives; the collision-scan row
  needs `maxDerivationMatches` to keep reading `derived`; reconcile strings with commas,
  a `$` or parentheses are accepted.
- `reconcile({ rows, total, tolerance })` and `reconcileComponents({ parts, total })`:
  exact decimal sums with the signed difference. Floats are a `TypeError`
  unless `allowFloat`.
- Verdict regression table (`test/verdict-table.test.ts`), written before the
  implementation.
