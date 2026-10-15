# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (M1: an unread number is never silently dropped)

- `traceNumbers` returns `skipped`: every stretch of the output that holds digits but was not read as a number, with `raw`, `start`, `end` and a `reason` (`identifier`, `unread-glued-form` or `ignored`), and `counts.skipped` (its length). New exported types: `SkippedNumber`, `SkipReason`, `TraceCounts`. `TraceResult.counts` is now a `TraceCounts`, which adds `skipped` to the six statuses.
- A number glued to letters the kit does not know and cannot call an identifier (`12foo`, `50p`, `9999kr`, `Rs1,500`) is `unread-glued-form`, and the verdict is `unknown`, not `clean`. `ignore` and `ignorePattern` cover it.

### Added (M4: magnitude words and vulgar fractions)

- `AmbiguityReason` gains `magnitude`: a magnitude word the kit cannot value. The number traces to `unknown` with the reason `unread-magnitude` (unless the same phrase is in the evidence).
- Vulgar fractions (`½ ¼ ¾` and `U+2150` to `U+215E`) are read as ambiguous `fraction` tokens with an exact decimal value, the percent sign, currency and magnitude attached, and the number without the fraction as the alternate reading. A fraction with no exact decimal (`⅓`) is listed in `skipped`. The fraction slash `U+2044` and the division slash `U+2215` read as `/`.

### Added (M5: unit truth)

- `AmbiguityReason` gains `currency`: a currency code that cannot go with the symbol or prefix before the amount (`$500 EUR`). The number traces to `unknown` with the reason `conflicting-currency`.
- `°C` and `°F` are units (`30°C`, `30 °F`, `℃`, `30 degrees Celsius`). `Kb`, `Mb`, `Gb`, `Tb`, `Pb`, `PB`, `EB`, `KiB`, `MiB`, `GiB`, `TiB` and `PiB` are distinct units.
- Dollar prefixes `CAD$`, `USD$`, `AUD$`, `NZD$`, `HKD$`, `SGD$`, `MXN$`, `TWD$`, `SG$`, `TW$`, `NT$`, `Mex$`; the code `TWD`.

### Fixed (M5)

- `Mb` no longer equals `MB`, and `Gb` no longer equals `GB`: spaced data units were lower-cased into one unit. An all-lowercase `mb`, `gb`, `tb` or `kb` is read as bytes (documented); `mB` is an unread form.
- `MBps` is no longer read as `Mbps`, and `megabit`, `megabyte`, `kilobit`, `gigabyte`, `terabyte`, `Mbit`, `kbit` and similar words are read as the matching units, so `5 megabits` no longer traces to `5 megabytes`.
- `30°C` no longer traces to `30°F`: the degree sign ended the number and left it with no unit on either side.
- A code after a symbol amount is honored: `$500 CAD` is Canadian dollars and no longer traces to `$500 USD`; `CAD $500`, `CAD$500` and `NT$500` are read as what they say instead of USD.
- The same rule holds in nearby forms: a code glued to the dollar sign in any case (`cad$500`, `EUR$500`), a word before "dollars" (`500 US dollars`, `$500 Canadian dollars`), and ranges (`$5 to $10 CAD` is two Canadian amounts; `$5-10 EUR` is `unknown`).

### Added (M6: flags reach the counts and the verdict)

- `TraceCounts` gains `unitUnverified` and `signDiffers`: how many numbers matched with a unit on one side only (through `allowBareEvidence`, `allowBareOutput` or a derivation) and how many matched evidence of the other sign.
- `signMode: 'strict'`: an unsigned output that matches evidence of the other sign is `unknown` with the reason `sign-differs` (exact, rounded and derived matches alike), so a loss restated as income needs a person. The default `explicit` is unchanged.
- New `unknown` reason `unit-unverified`.
- "between 10 and 12 weeks" is a range, so the unit, percent sign, currency and magnitude written once cover both numbers.

### Changed (M6): a deliberate contract change, not an API change

- A direct or rounded match with a recognized unit on one side only (`5pm` against `5.0`, `30°C` against `30`, `7` against `7 kg`) is now `unknown` (`unit-unverified`) in every mode; before, it traced and was marked `unitUnverified`. The matches that stay marked and counted are the ones the caller asked for: `allowBareEvidence` and `allowBareOutput` (a percent or amount against a unit-less number), and derived numbers. Existing rows that asserted the old behavior (`trace-rules.test.ts`, "measurement units must agree when both sides have one") now assert `unknown`.
- `am` and `pm` are time units in any case and with dots (`5 PM`, `9 a.m.`, `5 P.M.`); before, only lower-case `am` and `pm` were, so `5 PM` traced to a 5.0 star rating. A time of day is never derived from other numbers.
- Field check (RAGTruth, 289 responses, strict with list markers ignored): unsupported numbers that passed fell from 9 of 123 to 4 of 123; honest numbers marked `unknown` rose from 28 to 56 of 809 (3.5% to 6.9%), honest numbers flagged `untraced` stayed at 195; honest responses with a verdict other than `clean` rose from 28.1% to 28.9% (135 responses). Under the `report` preset, 16 times of day that were `unknown` (a derivation of other numbers was too likely) are now `untraced` (8 honest, 8 wrong), because a time is no longer derived; reading 24-hour clocks against `am` and `pm` is not done yet. The labeled benchmark (203 number items) is unchanged for the default, `strict`, `report` and `allowBareEvidence` runs.

### Fixed (M4)

- Magnitude words are read: `hundred`, `lakh`, `crore`, `Tausend`, `Mio`, `Millionen`, `Mrd`, `Milliarden`, `mln`, `MM`, `mil` and `Cr` (after a currency), `万`, `億`, `亿`, `लाख`, `करोड़` and the matching forms in other European languages, so `₹5 lakh` no longer traces to `₹5 crore` and `3,5 Millionen` no longer traces to `3,5 Milliarden`. `350万円` is 3,500,000 JPY.
- `Billion` and `trillion` outside English, `mil` outside English, and the other words in the stop list are `unknown`, not read as the nearest English word.
- `Prozent`, `procent`, `prosent`, `procento`, `pourcent`, `pour cent`, `por ciento`, `por cento` and `per cento` are percent, so `12,5 Prozent` traces to `12,5 %`.

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
