# number-trace-kit

Does every number in this AI output trace to the evidence it was given, and do the rows add up to the printed totals?

A small TypeScript library that pulls the numbers out of a text, normalizes them into exact decimals, and checks each one against the numbers in the evidence you supply. It also adds up rows and compares the sum to a printed total, to the cent. All comparisons use exact decimal arithmetic (BigInt), never floats.

**Who it is for.** Developers who ship AI-written summaries, reports or answers and hold the source text the numbers should come from: finance and pricing pages, extracted tables, invoices, metrics write-ups. It is a deterministic check you can run in tests, CI or a review queue.

**What it does not do.** It checks numbers, not sentences. It does not know whether the evidence is true, does not read number words or context, and cannot tell "up 30%" from "down 30%". `traced` means the number, in that unit, appears in the evidence; it does not mean the claim is right. See Known limits and What it does not do below.

Status: version 0.1.0, private and unreleased. The package is marked `"private": true` and `UNLICENSED`; it is not published anywhere and no license has been chosen.

## What it does

- **`extractNumbers(text, options?)`** finds every number and returns tokens with the exact decimal value, the precision shown, the kind (percent, currency, count, decimal, year, date part, time, ordinal), the unit or currency, and the offsets in your text. A form that can be read two ways is returned with `ambiguous: true` and its other readings. It never picks one quietly.
- **`traceNumbers(output, evidence, options?)`** (`output` is a string, or tokens you already extracted) gives every number in the output one of six statuses: `traced`, `rounded`, `derived`, `untraced`, `ignored` or `unknown`, and an overall verdict of `clean`, `untraced` or `unknown`.
- **`reconcile({ rows, total, tolerance? })`** and **`reconcileComponents({ parts, total, tolerance? })`** add up amounts in exact decimals and report `ok`, the sum, the total and the signed difference.

It does not call a model, read a network, or use the clock or randomness. Same input, same options, same result.

## Start with a preset

Real reports and pricing pages need more than the defaults. Pick a preset, then override what your evidence needs.

```ts
traceNumbers(output, evidence, { preset: 'strict' }) // the default: direct matches and rounding only, no derivations
traceNumbers(output, evidence, { preset: 'report' }) // for financial tables and pricing pages (below)
traceNumbers(output, evidence, { preset: 'report', maxCandidates: 200_000, evidenceOrder: 'newest-first' })
```

- **`strict`**: no derivations, no unit leniency. A number is traced, rounded, untraced or unknown. Use it when the evidence states every figure the output may use.
- **`report`**: every derivation (`sum`, `difference`, `ratio`, `percent-change`, `percent-of`, `average`, `product`), rounded sums and differences (`roundSums`), a bare number matching a currency figure in either direction and a percent or amount matching an evidence number with no unit at all (`allowBareEvidence`, `allowBareOutput`: `Churn was 120%` traces to `We have 120 employees`, marked `unitUnverified` and counted in `counts.unitUnverified`), a candidate cap of 50,000, and the coincidence guard (`maxDerivationMatches: 3`, `maxDerivationDensity: 0.5`): a derived number that can be built in more than three ways, or that sits in a crowded neighborhood of buildable values, is `unknown` (`derivation-too-likely`), not `derived`. On a page with a hundred numbers almost any percent can be built from two of them; the guard keeps that from reading as support.

The pattern for tables: set `scale` and `currency` on the evidence document that holds the table (`{ id, text, scale: 'thousand', currency: 'USD' }`), or `evidenceScale` and `evidenceCurrency` for string evidence. A table in millions that also prints `$` on its first row and its totals (`$ 1,577`) needs `scaleApplies: 'bare-and-currency'` (`evidenceScaleApplies` for string evidence); the default scales only bare cells. The kit never guesses a scale from a header such as "(in thousands)"; you say it. See Options.

## Worked example

```ts
import { traceNumbers, reconcile } from 'number-trace-kit'

const evidence = [
  { id: 'last-quarter', text: 'Last quarter the total was $1,000.00.' },
  { id: 'invoice-17', text: 'Subtotal $1,200.00. Tax (8.25%) $99.00. Total due $1,299.00.' },
]
const output =
  'The invoice total is $1,299.00, which includes 8.3% tax and is up 30% from last quarter. Payment is due in 45 days.'

const result = traceNumbers(output, evidence, { derivations: ['percent-change'] })
result.verdict // 'untraced'
```

| number | status | why |
| --- | --- | --- |
| `$1,299.00` | `traced` | the same amount is in `invoice-17` |
| `8.3%` | `rounded` | `8.25%` in `invoice-17` rounds to 8.3 at one decimal (half-up; a tie, so half-even would say 8.2) |
| `30%` | `derived` | percent change from `$1,000.00` to `$1,299.00` is 29.9%, which rounds to 30 |
| `45 days` | `untraced` | no 45 anywhere in the evidence |

Each entry in `result.numbers` carries the token, the status, the evidence it matched (`id`, `raw`, offsets), and for `derived` the operands and whether the match was exact.

`result.skipped` lists every stretch of the output that holds digits but was not read as a number, each with its `raw` text, offsets and a reason (see Verdict), and `result.counts.skipped` is its length. Nothing the kit passes over is silent. `result.counts` also has `unitUnverified` (numbers matched with a unit on one side only, which only `allowBareEvidence`, `allowBareOutput` or a derivation allow) and `signDiffers` (numbers that matched evidence of the other sign).

```ts
reconcile({
  rows: [{ label: 'Subtotal', amount: '1200.00' }, { label: 'Tax', amount: '99.00' }],
  total: '1299.01',
})
// { ok: false, sum: '1299.00', total: '1299.01', difference: '-0.01', tolerance: '0', rows: 2 }
```

## The matching rules, exactly

A number in the output is compared to the numbers extracted from the evidence, in this order. The first rule that applies decides.

1. **Ignored.** If the number is covered by one of your ignore options (see Options), its status is `ignored` and nothing else is checked. Nothing is ignored by default.
2. **Cannot be compared.** A number glued to a superscript or an inline exponent (`10²`, `10^6`), longer than 60 digits, or followed by a magnitude word the kit cannot value (`2 Billionen`, `5 Cr`, `5 млн`, `5千`) is `unknown`. The last has the reason `unread-magnitude`; the same phrase written the same way in the evidence still traces.
3. **Dates and times** trace as whole dates: the day, month and year written together must appear together in one evidence date (in any format: `June 30, 2026`, `2026-06-30`, `30 June 2026`, `06/30/2026`, `30-Jun-2026`, `Jun-30-2026`, `2026年6月30日` and, in the languages below, `30 juin 2026` are the same date). A date with fewer parts than the evidence date matches it (`June 30` against `June 30, 2026`); one with more parts does not. A date whose parts only appear in other dates (`June 30, 2025` against `June 30, 2026` and `Sept 2025`) is `unknown`, because its parts weakly support it, and `untraced` if some part is nowhere. A range (`Oct 5-7, 2026`) is checked day by day. A numeric date whose day and month cannot be told apart (`10/12/2026` when both are 12 or below and different) has no roles; it traces only to evidence that writes the same date text, and is `unknown` if the same values appear any other way (another date, or a bare month, day or year).
4. **Traced.** Same class and the same exact value after normalization (see Normalization). Classes are: percent (`%`), percentage points (`pp`), currency (one class per currency code), and plain numbers (counts, decimals, years, ordinals). A percent never matches a plain number or an amount; `$45` never matches `45 EUR`. A plain number with a recognized unit never matches a plain number with none: `5pm` against `5.0 stars`, or `7 kg` against `7`, is `unknown` with the reason `unit-unverified` (see Units).
5. **Rounded.** The evidence is more precise than the output, and rounding the evidence value to the number of decimals the output shows gives the output value. The result says which rule produced the match: `half-up` (a tie goes away from zero), `half-even` (a tie goes to the even neighbor) or `either` (not a tie, both agree). `12.34%` rounds to `12.3%` and `12%`, never to `13%`. A magnitude counts as precision: `1.2 million` is precise to the nearest 100,000, so it matches `1,234,567` but not `1,350,000`.
6. **Derived.** Only for the derivations you list in `options.derivations` (none by default), and by default only pairwise: two evidence numbers of the same class and unit, one operation (three with `maxOperands: 3`). See Derivations.
7. **Unknown, another reading.** Nothing above matched, but the number would match if an ambiguous number on either side were read the other way (see Ambiguity). Status `unknown`, reason `ambiguous-reading`.
8. **Unknown, search too large.** Derivations are on and the candidate cap was hit (see Derivations). Status `unknown`, reason `candidate-cap`.
9. **Untraced.** Nothing above matched. This is a positive finding: the number, in that unit, is not in the evidence you gave. `nearMisses` lists evidence with the same value but a different unit, kind or sign.

### Normalization

- Thousands separators and the decimal mark follow the locale (`en-US` by default). `1,234.50`, `1234.5` and `1 234,50` (French) are the same number when read in the right locale. Under a comma-decimal locale an ordinary space also groups digits, but only as a short first group followed by groups of exactly three (`1 234`, `12 345 678`); `5 12` and `2024 123` stay two numbers. Under `en-US` an ordinary space never groups. Trailing fraction zeros do not matter for equality (`12.50` equals `12.5`) but do count as precision for rounding.
- `1.2 million`, `1.2M` after a currency symbol, `$3.4M`, `5 bn` and `7 thousand` are scaled exactly (`1200000`). So are the magnitude words that mean one thing wherever they are used: `hundred`, `lakh` and `crore` (also `lac`, `lakhs`, `crores`), `Tausend` and `Tsd`, `Mio` and `Millionen`, `Mrd` and `Milliarden` (and their forms in French, Spanish, Italian, Portuguese, Dutch and Swedish), `mln`, `MM` and `mm` after a currency (`$1.2 MM`), `mil` after a currency in English (`$5 mil`), `Cr` after a currency (`₹5 Cr`), and `万` `萬` (10,000), `億` `亿` (100,000,000), `लाख` and `करोड़` (`350万円` is 3,500,000 yen). A trailing dot on an abbreviation (`3,5 Mio. €`) belongs to the number when a currency or unit follows. A lone `K`, `M`, `B` or `T` after a currency amount is a magnitude (`$5 M`). Two magnitude words in a row (`1 hundred thousand`, `3 lakh crore`) multiply, which the kit does not do: `unknown`.
- Magnitude words the kit cannot value are never guessed, because their value depends on the language or the reader: `Billion` and `trillion` outside English (long scale in German, French and Spanish), `Bio`, `Billionen`, `mille`, `tusen`, `duizend`, `mil` without a currency or outside English (1,000 in Spanish and Portuguese), `Cr` without a currency (also an accounting credit), `bln`, and the Russian, Chinese, Japanese, Korean and Arabic words in the same family (`млн`, `тыс`, `千`, `百`, `兆`, `억`, `مليون`). The number is `ambiguous` with the reason `magnitude` and traces to `unknown`.
- Currency: a bare `$` is read as USD (the symbol is also used for other dollars; use `US$`, `CA$`, `A$`, a code, or a word to be explicit). `USD 5`, `5 USD`, `$5`, `US$5` and `5 dollars` are the same amount. `¥` stays `¥`; it is not guessed to be JPY or CNY. A letter prefix names the dollar (`US$`, `CA$`, `C$`, `CAD$`, `A$`, `AU$`, `NZ$`, `HK$`, `S$`, `SG$`, `MX$`, `Mex$`, `NT$`, `TW$`, `R$`), and a code next to a bare `$` or `¥` makes it specific: `$500 CAD` and `CAD $500` are Canadian dollars, `¥500 JPY` is yen. A code that cannot go with the symbol (`$500 EUR`, `€500 USD`, `CA$500 USD`, `EUR $500`) makes the number `ambiguous` with the reason `currency`: it traces to `unknown` (`conflicting-currency`) unless the same text is in the evidence. The word "dollars" is a generic dollar: it agrees with any dollar prefix. A code glued to the sign is read in any case (`cad$500`, `EUR$500` is a conflict), and `US`, `American`, `Canadian`, `Australian` or `Singapore` before "dollars" names the dollar (`500 US dollars` is USD). In a range, a code on one member settles a bare `$` or `¥` on the others (`$5 to $10 CAD` is two Canadian amounts); members that name currencies that cannot agree (`$5-10 EUR`) are all `ambiguous` with the reason `currency`.
- Percent: `45%`, `45 %`, `45 percent` and `45 per cent` are the same, and so are the common forms in other languages: `Prozent`, `procent`, `prosent`, `procento`, `pourcent`, `pour cent`, `por ciento`, `por cento`, `per cento`. `Prozentpunkte` is percentage points. `0.5 pp` and `0.5 percentage points` are percentage points, a different class from percent.
- Month names: English names and abbreviations with a capital (`June`, `Jun`, `JUN`, `Sept`) and, in German, French, Spanish, Italian, Portuguese, Dutch and Swedish, the full names in any case (`mars`, `März`, `marzo`, `março`, `maart`, `febbraio`; `1er mars`, `5. März`, `5 de marzo de 2026`, `5 de marzo del 2026`) and their abbreviations with a dot (`janv.`, `févr.`, `sept.`, `okt.`), from a table in the code (no `Intl`). Words that are a month in one language and a word or name in English (`Mars`, `Mayo`, `Mai`, `Maj`, `Mei`, `Juli`, `Juni`) count with a capital only when `locale` is one of those languages, so `Mars 2020` stays a year under `en-US`. `2026年3月4日`, `3月4日` and `2026년 3월 4일` are read in any locale. In a locale with no month table (`ru`, `pl`, `tr`, `da`, `fi` and the rest), a worded date shaped like `5 марта 2026` (a day, one word, a four-digit year) cannot be read: its day and year are `ambiguous` with the reason `date` and trace to `unknown` (`unread-date`), unless the same phrase is in the evidence. Without that, a wrong day could trace to an unrelated `5`.
- A range such as `10-12` is two numbers (written `10-12`, `10–12`, `10 – 12` or `10 to 12`), and what is written once covers all of them: a unit, a percent sign, a currency, a magnitude and its precision (`10-12%`, `$10-12`, `5-10 days`, `$1-2M`, `1.5-2.5 million`, `-5–-3%`). A scientific exponent belongs to its own number only: in `1e3–2000 kg` the second endpoint stays 2,000. A date range shares its month (`Oct 5-7`, `5-7 October`). A hyphen with spaces around it is arithmetic, not a range. Two numbers that are different kinds of quantity are never one range: a percent next to an amount (`rose 8% to $4.2 billion`), or an amount next to a measured unit. When the pair is written the spoken way (`to`, a spaced en dash, `between ... and`) a percent is carried only backward onto a bare number (`5 to 8%` is two percents), never forward: in `rose 8% to 1,200` the 1,200 is a count, and in `rose 8% to $4.2 billion` the 8 stays 8%. A bare number with a magnitude (`5 million to 8%`) and a percent do not share either. A tight dash (`5%-10`) is still a range.
- A dimension such as `3 x 4 cm`, `3x4 cm` or `2 × 4` is two numbers with an operator between, and a unit written once covers both. A standalone multiple (`10 x faster`, `3x`) is a number with the unit `x`.
- A leading decimal is a decimal: `.5%` is 0.5%, `$.99` is 99 cents, `-.25` is -0.25. A decimal mark right before the digits belongs to the number after a space, an opening bracket or quote, or a symbol (`~.5%`, `≈.5`, `|.99`, `#.5`, `“.5”`); after a letter or digit (`item.5`), right after a number that ends there (`5%.5`), or after another point or an ellipsis it does not. Under a locale where that mark is the grouping mark (`.5` under `de-DE`, a spaced `,5` under `en-US`) the reading is a locale guess, so the number can only be `unknown` or `untraced`; the mark is never dropped.
- Signs: a leading `-`, `−` (U+2212) or `+` is an explicit sign. `(1,234)`, `($5)` and `(12.5%)` are negative when the number has a separator, a decimal, a currency or a percent sign; a bare `(2)` or `(2024)` is left alone. Turn parentheses off with `parenthesesAreNegative: false`.
- Sign matching (`signMode: 'explicit'`, the default): an explicit sign in the output must agree with the evidence, so `-5%` does not trace to `5%`. An unsigned output may drop a sign the evidence has, and the result is marked `signDiffers` and counted in `counts.signDiffers`; so is a derived number whose only matching derivation is negative (`35%` from the average of `-30%` and `-40%`). Zero keeps the sign it was written with: `-0.00%` rounds from `-0.004%` but not from `0.004%`, while an exact zero (`-0%` against `0%`) has no sign to disagree about. `signMode: 'strict'` is the same, except that a dropped sign is `unknown` with the reason `sign-differs` instead of a marked pass, so a net loss restated as income needs a person. `signMode: 'magnitude'` ignores signs entirely.
- Bits and bytes are different units and case decides: `Mb` (megabit) is not `MB` (megabyte), `Gb` is not `GB`, `Tb` is not `TB`, and `GiB` is not `GB`. An all-lowercase `mb`, `gb`, `tb` or `kb` is the everyday shorthand for bytes and is read as `MB`, `GB`, `TB` and `KB` (write `Mb` or `Mbit` for bits); a mixed form the kit cannot place (`mB`) is unread (`unknown`). `MBps` (megabytes per second) is not `Mbps`, and the words `megabit`, `megabyte`, `kilobit`, `gigabyte` and the like (also `Mbit`, `kbit`) are the matching units.
- Temperature: `°C`, `°F`, `℃`, `℉`, `° C`, `degrees Celsius`, `deg F` and `Celsius` are the units `°C` and `°F`, which differ from each other. A degree sign with no C or F after it (`45°`, `30°N`) is an angle and is left alone; Kelvin is not read.
- Units: a recognized measurement unit (`kg`, `km`, `days`, `hours`, `MB`, `x` and a short list of others, glued or as the next word, after any numeric form including `1.2e3 kg`) must agree when both sides have one. If only one side has a recognized unit (`5pm` against `5.0`, `30°C` against `30`, `7` against `7 kg`), the number is `unknown` with the reason `unit-unverified`, because the match could be a coincidence between different quantities. A time of day is covered under Times below. A derived number with a unit on one side only (`7 kg` from `3` and `4`) is still a derived match, marked `unitUnverified` and counted, but never for operands in different units, and a ratio takes no unit. On a labeled field corpus of 289 RAGTruth responses (not shipped), this rule cut the unsupported numbers that passed under the default options (list markers ignored) from 9 of 123 to 4 of 123 and made 28 more of the 809 honest numbers `unknown` (3.5 points; honest responses with any verdict other than `clean` went from 28.1% to 28.9%), mostly times of day and temperatures against bare numbers. Words that are not in the list (`users`, `orders`) are not units.
- `allowBareEvidence: true` lets a percent or amount in the output match an evidence number with no unit at all (a table cell that prints `1,234.50`), marked `unitUnverified` and counted in `counts.unitUnverified`. It applies on every path: exact, rounded, derived, and the weaker links that give `unknown`. Default off.
- A number that inherits a unit, a percent sign, a currency or a magnitude from a range or a dimension (`1950-2200 kg`) is not a year, so `ignoreYears` does not skip it.
- A bare year elsewhere is only a weak link for the year of a date (the date as a whole must appear), while a date's year vouches for a bare year in the output.
- Accounting negatives: `(557)`, `-557`, `$(557)` and `-$557` are one figure. A bare `(557)` is read as positive (it could be a list marker), but it also answers to a minus sign, so `-557` traces to it; an unsigned `557` traces to either.
- Times: a clock time is one token of kind `time` whose value is the minutes since midnight, whatever the spelling: `6pm`, `6:00 PM`, `6 p.m.`, `18:00` and `18:0` (the on-the-hour form some data sources print) are all 1080, and `12 AM` is 0. They match each other and nothing else; a time never matches a plain number except as the hour-only `unknown` below. A range takes its meridiem from its end and the start moves to the other half of the day when it would come after the end (`9-5pm` is 9 am to 5 pm, `11-1pm` is 11 am to 1 pm). A time with no am or pm and a 12-hour-looking hour with no leading zero (`10:30`, `9:00`) may be either half of the day: it is `ambiguous` (reason `meridiem`) with the other half as its alternate, so it traces to the same text and is `unknown` against `10:30 PM`; `18:30`, `09:00` and `0:30` are firm. A bare hour with am or pm (`5pm`) that finds no time in the evidence is `unknown` (`unit-unverified`) when the evidence has a unit-less number of that size (a `5.0` rating), and `untraced` otherwise. A time is read, never computed: it is never derived from other numbers and never an operand. A time with seconds (`14:05:30`) stays three date parts, checked as a whole time (`time-not-in-evidence` when only some parts are there) and its minute-precision form (`14:05`) traces to it; `8:30:15 PM` is read as 20:30:15. A time with seconds has no alternate reading: `8:30:15` is read as the 24-hour clock.
- Cents (`1.9c`, `1.9¢`, `12 cents`), months (`10mo`) and points (`2.4pts`) are units. A lone `c` after a space is a label, not cents.
- Hyphenated model and product names with letters on both sides of their numbers (`Llama-3.3-70B-Instruct`, `gpt-5.4-nano-2026-03-17`, `claude-3-5-sonnet`, `Qwen3-8B`) are identifiers: their digits are weak evidence. `gpt-4` and `pre-2020` are not names and keep their numbers.

### Ambiguity: never guessed

A token is `ambiguous` when the text can be read more than one way. The primary reading is what `value` holds; other readings are in `alternates`.

| Form | Why it is ambiguous | Primary reading |
| --- | --- | --- |
| `1.234` under `en-US` | one separator then exactly three digits, and the separator is the decimal mark: could be 1,234 written the German way | `1.234` (alternate `1234`) |
| `1,234` under `de-DE` | the same, mirrored | `1.234` (alternate `1234`) |
| `12,5` under `en-US`, `3.14` under `de-DE` | the separator does not fit the locale; one reading, but it is a guess about the locale | read as a decimal |
| `4K`, `2M` | a magnitude letter with no currency: 4,000, or the label "4K" | `4000` (alternate `4`) |
| `10²`, `10^6` | an exponent that is not expanded | `10` |
| `3/4`, `1/2/3`, `3⁄4` | a fraction or ratio, which is not evaluated; the same fraction written the same way in the evidence still traces | each half |
| `3½`, `¼%`, `$1¾ million` | a vulgar fraction character: the mixed number as an exact decimal (`3.5`, `0.25%`, `1750000`), or the number without the fraction (alternate `3`); the percent sign, currency and magnitude stay attached | the exact decimal |
| `2 Billionen`, `5 Cr`, `5 млн` | a magnitude word the kit cannot value | the digits as written |
| `10/12/2026` | day and month order | no roles |
| `9:00`, `10:30` | a 12-hour-looking time with no am or pm | the morning reading (alternate: the evening one) |
| digit runs over 60 digits | too long to compare | the digits |

A vulgar fraction with no exact decimal (`⅓`, `⅔`, `⅙`, `2⅔`) is not read at all: it is listed in `skipped` as an `unread-glued-form`, so the verdict is `unknown`.

How an ambiguous number is matched: if its primary reading matches the other side's primary reading, it traces (and the token says `ambiguous: true`). If the only link is through another reading (an exact match, a rounded match, or a derivation using the other reading), the status is `unknown` with reason `ambiguous-reading`. A number whose only reading is a locale guess (`12,5` under `en-US`, or `12,5K`) can never trace, only be `unknown` or `untraced`; that holds whatever other readings it also has, and the token says so with `localeGuess: true`. A number in a slash chain (`1.000/2.000`) is judged as the whole chain, whatever else is ambiguous about its parts. Pass the right `locale` for the output and `evidenceLocale` for the evidence (they are read separately; the evidence locale defaults to the output locale).

### Derivations

`options.derivations` is a list of any of:

- `sum`: `a + b`. Exact match required.
- `difference`: later minus earlier in the order the evidence mentions the numbers; an unsigned output matches either way round. Exact match required. A difference of two percents is a percentage-point number and also matches a `%` output.
- `ratio`: `a / b`, a plain number or an `x` multiple (`0.8`, `0.8x`).
- `percent-change`: `(b - a) / a * 100`, a percent.
- `average`: the mean of two evidence numbers (three with `maxOperands: 3`), in the same class and unit. Matched after display rounding, like a ratio, so the result says `exact: false` and which rounding rule matched when the mean has more digits than the output shows.
- `product`: `a * b`, for a count times a price or quantity (`3,000,000 events at $0.0000343` gives `$102.90`), or two counts. One operand is a unit-less number; the result takes the other's class and unit. Matched after display rounding.
- `percent-of`: `a / b * 100` for two numbers of the same class (what percent is a of b), and `p% * x` when one operand is a percent and the other an amount or count (7.5% of $200.50).

Rules:

- Pairs by default; `maxOperands: 3` (opt-in) also tries every triple for `sum`, `difference` and `average`. A three-operand `difference` is one figure less the other two (`100 - 30 - 25`); no figure is "earlier", so it has no direction rule, and the sign follows the arithmetic. Direction rules for pairs are unchanged, and nothing changes for a call that does not set `maxOperands`. Operands must be in the same class and unit (percents with percents, amounts of one currency with each other). Two percents give a percent through `percent-of` (`10%` and `20%` give `50%`). Years, dates, ordinals and ambiguous numbers are never operands. A value that appears more than twice counts twice, and two copies of a value never combine with each other (see `twin-operands` below).
- Sums and differences are exact arithmetic, so only an exact match counts, unless `roundSums: true` (or the `report` preset) lets them match after display rounding (`$17.6 million` from `$83.692 million` less `$66.128 million`). Ratios, percents, averages and products are inexact, so they match after rounding to the output's precision, and the result says `exact: false` and which rounding rule matched. A loose match is visible: `derivation.matches` counts how many different candidates produced the number.
- Direction follows the order the evidence mentions the numbers: the first mentioned is the "from", the second the "to". If a number matches only when the operands are taken the other way round (an unsigned `30%` where the evidence lists the new value first), the status is `unknown` with reason `derivation-direction`, because the direction of a change is in the words, which this library does not read.
- The search is capped. The number of candidates is counted first, from what will be generated: operands of one class and unit pair up for every derivation, across classes only a count times an amount and a percent of an amount make a candidate, and triples (at `maxOperands: 3`) form within one class. A page of 120 mixed numbers (counts, percents, amounts) has a few thousand candidates; 120 amounts alone have about 78,000 under `report`, which is over its cap of 50,000. If it is larger than `maxCandidates` (default 5,000, at most 1,000,000), nothing is generated, `candidateCapHit` is true, and every number that is not a direct match is `unknown` with reason `candidate-cap`: never traced, and never called untraced, because the search was not complete. Narrow the evidence or the derivation list, or raise the cap. A raised cap costs about 8 microseconds per candidate.
- Derived lookups are answered for at most 12 distinct output scales (the number of decimals an output number shows, so `8%`, `8.25%` and `$4.2 billion` are three). A number at a thirteenth scale that is not a direct match is `unknown` with reason `scale-cap`: never traced and never untraced, because the search was not run for it. Each scale costs a pass over the candidates near the numbers at that scale, so the total stays bounded for an output with dozens of precisions. A form such as `77.333`, which can also be a grouped integer, uses a scale for each reading.
- Many candidates make coincidences likely, so there is a guard. `derivation.matches` counts how many candidates produce the displayed value (its rounding window). When that is more than `maxDerivationMatches` (default 3), the status is `unknown` with reason `derivation-too-likely`: with that many ways to build the number, a match says little. On evidence with a hundred numbers, random wrong percents are often buildable; the guard turns most of those from `derived` into `unknown`. A second test looks at crowding: `maxDerivationDensity` (default 0.5) is the average number of candidates per displayed value within 25 units of the last digit, which is roughly the chance that a random wrong number lands on a candidate. At or above it the status is also `unknown`. On dense pages this is the test that does the work. Raise either limit only if you accept looser matches.
- Identical values never form a derivation pair. Two evidence numbers of the same class, unit and value (an invoice total and the payment that equals it, two rows of `7.5%`) can only give a difference of 0, a ratio of 1, a percent of 100% or 0%, or double the value, and that says nothing about the claim: it could be one fact written twice or two real rows. A number that only such a pair builds is `unknown` with the reason `twin-operands`, never `derived`; the pair does not count toward `derivation.matches` or the density. The same holds for a triple that contains such a pair. Two different values and a third still combine normally, and a number that appears in the evidence is still `traced`. To accept a doubled total, put it in the evidence or add it to `ignore`.
- A ratio that was rounded to a single digit (`5`, `0.5` shown from 4.92 or 0.525) is `unknown` with the reason `coarse-derivation`: ratios of unrelated numbers cluster among small integers, so one digit says too little to tell a derivation from luck. An exact ratio (`12` over `4` is `3`), a ratio shown with two or more significant digits, and the other derivations are unaffected; a mean, percent change or percent-of shown as one digit can still be `derived` by chance, so treat it as weak.
- A zero that only a zero operand builds is `unknown` with the reason `zero-operand`: a product, a ratio or a percent-of where an operand is zero (`0 outages` times `$5,000` is `$0`, `0%` of `$5,000` is `$0`) is zero whatever the claim is. It never counts toward `derivation.matches` either. A zero built by two different values (`5` and `-5`), a drop to zero (`100%` fewer) and a zero that is in the evidence are unaffected.
- A year or an ordinal in the output (`2031`, `3rd`) is a label. If only a derivation builds it (`1,000` plus `1,031`), the number is `unknown` with the reason `label-derivation`, never `derived`. A count between 1900 and 2100 written without a separator reads as a year, so `2007 units` from `1000` and `1007` is `unknown` too; write `2,007` to have it derived.
- A number whose only doubt is thousands-versus-decimal (`1.250`) still takes part in a derivation, with its primary reading.
- Evidence tables that list the later period first (newest first) read a percent change against the order of mention; set `evidenceOrder: 'newest-first'` so that the direction rule follows the table.

For a table of many rows and a printed total, use `reconcile`; it is exact and not limited to pairs.

### Verdict

- `untraced`: at least one number is `untraced`.
- `unknown`: nothing is untraced, but at least one number is `unknown`, or at least one stretch of the output was skipped with the reason `unread-glued-form`: digits glued to letters the kit does not know and cannot call an identifier (`12foo`, `3xyz`, `50p`, `9999kr`, `Rs1,500`). The kit cannot tell what the number means, so it never calls the output clean. Add the text to `ignore` (or match it with `ignorePattern`) to accept it; the entry stays in `skipped` with the reason `ignored`.
- `clean`: every number is `traced`, `rounded`, `derived` or `ignored`, and nothing was skipped as an unread form. An output with no numbers is `clean` (there was nothing to trace), so check `numbers.length` and `skipped` if you expect some.

A skipped entry with the reason `identifier` (`X3`, `v2.1`, `iPhone15`, `5G`, `3D`, `COVID-19`, `Llama-3.3-70B-Instruct`, `192.168.1.1`, `0x1F`, `x86_64`) is a name, a version or a code. It is listed, and it does not change the verdict.

## What gets treated as a number, and what does not

- Digits: ASCII digits, full-width digits and punctuation (U+FF01 to U+FF5E), and the decimal digits of every script in the Basic Multilingual Plane (Arabic-Indic, Devanagari, Thai and the rest) are read, folded to ASCII the way NFKC folds full-width forms, with offsets still pointing into your original text. Decimal digits outside that plane (mathematical digits such as `𝟓𝟎`) are not numbers to this library, but they are listed in `skipped` with the reason `unread-glued-form`, so they cannot hide a figure. Number words (`twelve percent`) are not read.
- Numbers glued to Latin letters are identifiers, not numbers: `X3`, `v2.1`, `H2O`, `COVID-19`, `GPT-4`, `F-16`, `5G`, `A4`, `3D`, `2FA`, `4WD`, `1080p`, `FY2025`, `Q3`, `x86_64`, `iPhone15`. They are skipped in the output and listed in `skipped` with the reason `identifier`, so a model name or version string is never asked to trace. A letter-glued form that is a unit (`5kg`, `250W`, `45days`, `10x`), a magnitude (`5bn`), an ordinal (`3rd`) or a currency code (`100USD`) is read as such. Dotted chains like `1.2.3` and `192.168.1.1` are skipped as versions and addresses, and a version keeps its whole suffix (`v1.2.3+4`, `1.2.3-rc.1`, `2.0.0-beta.2+build.5`). In the evidence, the digits inside a skipped identifier are kept as weak evidence: an output number equal to them (a `2025` against `FY2025`) is `unknown`, never `traced`.
- A number glued to letters that are neither a unit nor a known code shape (`12foo`, `3xyz`, `50p`, `9999kr`) is not an identifier: it is probably a quantity the kit cannot read. It is listed in `skipped` with the reason `unread-glued-form` and makes the verdict `unknown`. A currency written as a letter prefix (`Rs1,500`, `RM1234.50`, `kr9999`) is the same; a comma chain after a letter prefix (`H2,500`) is skipped whole, never read as the digits after the comma.
- Units are read glued (`250W`, `50Hz`, `60dB`, `450kcal`, `5000mAh`, `940Mbps`, `45days`, `250bp`, `3X`) in any capitalization where capitals do not change the meaning (`9000KG` is `kg`). Units whose capitals do (`mW` and `MW`) are read exactly as written. A single letter such as `W` or `d` is a unit only when glued; a spaced `5 W` is not read.
- Hyphenated quantities are read when the word after the number is a unit, percent or currency word (`first-100-days`, `30-day`, `year-over-year-12-percent`, `revenue-of-9999-dollars`). Other hyphenated words (`sales-9999-units`) are names.
- Underscores around a number are markup or filler, not part of the number: `_12.5%_` is 12.5%, `1766____` is 1766. An underscore inside a word (`foo_12`, `x86_64`, `12_000`) keeps the number part of a name.
- Letters of other scripts do not glue: `100円`, `第3回` and `1,234.50米ドル` contain the numbers 100, 3 and 1,234.50. A look-alike Cyrillic or Greek letter next to a digit therefore cannot hide the number.
- Invisible characters split a number: `1<ZWSP>234` is two numbers, so a hidden character cannot make a number vanish. NFC and NFD text read the same numbers.
- A lone surrogate is an ordinary non-digit.
- Scientific notation (`1.5e3`) is read exactly and may carry a percent sign, currency or unit (`1e2%`, `1.2e3 kg`); an exponent over 30 is `too-long`, however many digits it has.
- The micro sign (U+00B5 and U+03BC) is a unit prefix for `m`, `s`, `g` and `L` (`5µm`, `3 μL`); anywhere else it ends the number instead of hiding it.
- A date part followed by a superscript or exponent (`Oct 5²`, `2026-10-05²`) is flagged like any other number with an exponent.
- Canonically equivalent letters read the same: the Kelvin sign is `K` and the Angstrom sign is `Å`, so `K3` is an identifier like `K3`.
- Percent signs after magnitudes are kept (`1 million %`, `5M%`).
- Combining marks stay with their letter, so `café3` is an identifier whether it is written precomposed or decomposed. A combining mark after a digit does not hide the digit.
- Numbers handed in as pre-extracted tokens follow the same rules: a value over 60 digits is `too-long` whatever its flags say, and a token whose `ambiguous` flag disagrees with its `ambiguity` reason (or that has alternates without being ambiguous) is a `TypeError`. Tokens from `extractNumbers` carry `magnitude` (the power of ten a written `million`, `K` or `e6` applies) and `parenthesized` (a bare `(557)`); keep both when you store tokens, because evidence `scale` hints skip a number with a `magnitude`, and a `parenthesized` figure also answers to a minus sign. Consecutive tokens of one `evidenceId` that were written together form one date.

## Options

`traceNumbers(output, evidence, options)`. Every option is read once. An unknown option name is a `RangeError`, so a typo cannot silently turn a check off.

| Option | Default | Meaning |
| --- | --- | --- |
| `locale` | `en-US` | locale of the output text |
| `evidenceLocale` | same as `locale` | locale of the evidence text |
| `parenthesesAreNegative` | `true` | read `(1,234)` as negative |
| `preset` | `strict` | `strict` or `report`; the other options override it |
| `derivations` | none | any of `sum`, `difference`, `ratio`, `percent-change`, `percent-of`, `average`, `product` |
| `maxEvidenceNumbers` | `500000` | 1 to 500,000; evidence with more numbers than this is a `RangeError`, thrown before the rest of the text is read |
| `maxDerivationMatches` | `3` | 1 to 1,000,000; a derived number buildable in more ways than this is `unknown` (`derivation-too-likely`) |
| `maxDerivationDensity` | `0.5` | a derived number whose neighborhood has this many candidates per displayed value, or more, is `unknown` (`derivation-too-likely`) |
| `roundSums` | `false` | let `sum` and `difference` match after display rounding |
| `evidenceOrder` | `oldest-first` | `newest-first` for tables that list the later period first |
| `evidenceScaleApplies` | `bare` | `bare-and-currency` also scales cells that print a currency without a magnitude; a document can set its own `scaleApplies` |
| `evidenceScale`, `evidenceCurrency` | none | scale (`thousand`, `million`, `billion`, `trillion` or an exponent of ten) and currency code of the bare numbers in string evidence; a document can set its own `scale` and `currency` |
| `allowBareOutput` | `false` | let a bare output number match an evidence amount that has a currency (`5,829 million` against `$5,829 million`), marked `unitUnverified` |
| `rounding` | `['half-up', 'half-even']` | accepted rounding modes; `[]` means exact matches only (exact derivations such as a sum still work) |
| `maxOperands` | `2` | `2` or `3`: how many evidence numbers `sum`, `difference` and `average` may combine |
| `maxCandidates` | `5000` | derivation search cap, 1 to 1,000,000; the triples count too, so `maxOperands: 3` usually needs a larger cap (about 100,000 for 40 numbers) |
| `signMode` | `explicit` | `explicit`, `strict` (a dropped sign is `unknown`) or `magnitude` |
| `allowBareEvidence` | `false` | let a percent or amount trace to a unit-less evidence number |
| `ignore` | none | exact raw strings to skip, and plain numbers (a number skips only unit-less plain numbers of that signed value) |
| `ignoreKinds` | none | skip every number of these kinds (for example `['ordinal']`) |
| `ignoreYears` | `false` | skip years and the year of a date |
| `ignoreSmallIntegersUpTo` | off | skip unit-less whole numbers from 0 to this value (0 to 1,000,000) |
| `ignoreStructure` | off | skip list markers, bracket citations and step or figure labels; see below |
| `ignorePattern` | none | a `RegExp`; see below |

Scale and currency hints apply to the bare numbers of a document: counts and decimals with no unit, percent sign or magnitude of their own. Percents, years, dates and numbers like `$3 million` are left alone. `{ id: 'tbl', text: 'Revenue (in thousands)\n2019 | 5,735', scale: 'thousand', currency: 'USD' }` makes `5,735` read as `$5,735,000`, so `$5,735 thousand` traces and `$5.7 million` rounds from it. A table that prints `$` on its first row only is the same pattern with `currency: 'USD'`, but only for its bare cells: a cell that already prints the `$` (`$ 1,577`, `$ (1,577)`) is a currency amount and is not rescaled unless the document sets `scaleApplies: 'bare-and-currency'` (a cell with its own magnitude, `$1.5 billion`, is never rescaled).

`evidence` is one string, or an array whose items are `{ id, text, scale?, currency? }` documents and/or pre-extracted tokens (`NumberToken`, optionally with `evidenceId`). Tokens are validated; a malformed one is a `TypeError`. `evidenceOrder` flips only the direction of changes, ratios and percents; sums, products and averages do not depend on it.

Common ignores: citation markers and reference numbers that are not claims. Start with `ignoreStructure: true`. It skips a plain whole number of up to three digits that only labels the answer's own structure: a list marker at the start of a line (`1.` or `2)`, after an optional bullet, including the very first characters of the text), a bracket citation (`[3]`, `[1, 2]`, `[1-3]`), and the number after Step, Passage, Figure, Option, Question or Section (`Step 4`, `Fig. 2`). The skipped numbers come back with the status `ignored` and the reason `structure`. It does not touch a count in a sentence (`7 offices` against `9 offices` is still `untraced`), a legal citation (`Section 50(1)` is checked), or the numbers of tokens you extracted yourself, which carry no text. `ignorePattern: /\[\d+\]|Section \d/` skips `[3]` and `Section 4` the hand-made way; `ignoreYears: true` skips years. Be careful with `ignoreSmallIntegersUpTo: 10`: it also hides a real wrong small count. On a labeled corpus of 289 RAGTruth responses (not shipped), skipping small integers up to 10 let 3 of 72 responses with an unsupported number come back clean (strict preset), and skipping the structure numbers let 0 of 72 through while keeping 42 of 45 honest question-answering responses clean.

`ignorePattern` is tested against a short window only: the number itself (at most its first 64 characters) plus up to 32 characters before it and 16 after. The pattern must overlap the number to ignore it. The pattern is copied into a private global RegExp, so your flags (`g`, `y`) and `lastIndex` are never touched or shared, and empty matches advance by a whole code point under `u`/`v`. The window bounds how much text a pattern can see, so work stays linear in the text; it cannot make a badly written pattern fast, so keep patterns simple (`/Section \d/`, not nested quantifiers).

Supported locale languages: `de`, `fr`, `es`, `it`, `pt`, `nl`, `ru`, `pl`, `sv`, `da`, `nb`, `nn`, `no`, `fi`, `cs`, `sk`, `sl`, `hr`, `ro`, `hu`, `bg`, `tr`, `id`, `vi`, `el`, `uk`, `sr`, `lt`, `lv`, `et` (comma decimal) and `en`, `ja`, `zh`, `ko`, `he`, `th`, `hi`, `ms`, `fil`, `ga`, `cy` (dot decimal), with regional exceptions (`de-CH`, `es-MX`, `es-US` and a few more use a dot; `en-ZA` uses a comma). Indian digit grouping (`12,34,567`) is read for regions `IN`, and an apostrophe groups digits (`1'234'567`) for regions `CH` and `LI`. Numeric dates are month-first for `en-US`, `en` and `en-PH`, day-first otherwise. An unsupported language is a `RangeError`, not a guess.

## reconcile

```ts
reconcile({ rows: [{ label, amount }, ...], total, tolerance = '0' }, { minorUnitDigits = 2, allowFloat = false })
reconcileComponents({ parts: { paid: '1000.00', reserve: '250.50' }, total: '1250.50', tolerance: '0' }, { minorUnitDigits: 2 })
```

- A **string** amount is an exact decimal in major units, written plain (`"12.34"`) or as a report prints it: comma thousands in groups of exactly three (`"38,400"`), one currency sign (`$ € £ ¥ ₹`, `"$600.00"`), accounting parentheses (`"(557)"`) or a minus sign, and a leading decimal (`".5"`). Spaces, a decimal comma, other digit systems, exponents and misplaced commas are a `TypeError`.
- An **integer `number` or `bigint`** is in minor units: `1234` is `12.34` at the default two minor-unit digits. Use `minorUnitDigits: 0` for currencies without a minor unit.
- A **non-integer number, `NaN` or `Infinity`** is a `TypeError`: floats are not exact. `allowFloat: true` is the one escape hatch, and it changes the meaning of every JS `number` in the call to a major-unit decimal read from its shortest round-trip text (`0.1` is exactly `0.1`, `12` is `12`). Use it only when you cannot get strings.
- The result is `{ ok, sum, total, difference, tolerance, rows }` with exact decimal strings. `difference` is `sum - total`; `ok` is `|difference| <= tolerance` (inclusive). Zero prints as `0`.
- Empty rows, a missing total, a negative tolerance and unknown keys are errors, not passes.

## Known limits

Choices that are made on purpose, not pending work:

- Size limits: a text over 5,000,000 UTF-16 units, an array over 1,000,000 items, or more than 50,000,000 characters of evidence in total is a `RangeError`, and so is evidence with more than 500,000 numbers (`maxEvidenceNumbers` lowers that). The numbers are the memory limit: each evidence number costs on the order of a kilobyte of heap, so 500,000 of them need about 600 MB. A number of more than 60 digits is `unknown`.

- The word list for units, currencies and month names is short and English. Other words are not units (`5 users`), and an English month name only counts with a capital letter. Month names are read in English and seven other languages and in the East Asian date form (see Normalization); the other locales cover separators, digits and the order of numeric dates, and worded dates in them are `unknown`. Words are English first. Magnitude words and percent words are read in German, French, Spanish, Italian, Portuguese, Dutch and Swedish (see Normalization); the names of units, currencies and months are not translated, and a magnitude word on the stop list above makes the number `unknown`, and a magnitude word on neither list is an ordinary word after the number, so the digits are read as written.
- `to` and a spaced en dash join two numbers into a range even in prose that is not a range (`9 to 5 job`, `pages 3 – 7`): the effect is that a unit, a currency or a magnitude written on one number is also given to the other (`$5 to 10` is two dollar amounts, so `rose $5 to 1,200` reads 1,200 as dollars too). A percent sign is shared only from the second number onto a bare first one (`5 to 8%`), and numbers that are different kinds of quantity are left alone (`8% to $4.2 billion`, `8% to 1,200`).
- `3 x 4` gives the first number the unit of the second (`3 x 4 cm`), including where the first is a count (`2 x 5 kg`).
- An ordinary space groups digits only under comma-decimal locales and only as `1 234`; `1 234` under `en-US` is two numbers.
- `1.2.3-rc.1` and `v1.2.3+4` are versions; other hyphenated words after a number (`3.5-inch`) are not.
- A percent sign written before the number (`%12`), number words, and digits outside the Basic Multilingual Plane are not read (the digits are listed in `skipped`).
- Rounding is half-up and half-even only; truncation is untraced.
- A number written with a zero exponent (`5e0`) carries no magnitude, so an `evidenceScale` hint can still rescale it; leave the hint off for evidence that prints scientific notation.
- An output with no numbers is `clean`: check `numbers.length` and `skipped` if you expect some. Identifier shapes (`X3`, `v2.1`, `iPhone15`, `5G`) are skipped and listed; a hyphenated name with letters on both sides of its number (`sales-9999-units`) is an identifier too, whatever it means in prose. `skipped` is filled only when the output is a string, not when you pass tokens.
- A derivation is not scoped to a document, row or sentence: any two numbers of the same class in the evidence can combine. The coincidence guard (`maxDerivationMatches`, `maxDerivationDensity`) is the protection, and the cost is that some honest derived numbers on dense pages are `unknown`.
- Derived values do not chain: a figure computed in the output and then used in a second computation is not an operand.
- Operands of one derivation need the same class and unit. A table that prints `$` on its first row only needs the `currency` hint, not a mixed derivation.
- The kit checks numbers, not sentences: right numbers in the wrong place, a direction flip (`rose` for `fell`) and swapped fields pass.

## What it does not do

- It does not read the source documents for you. You supply the evidence text; if the evidence is incomplete or wrong, the result is only as good.
- It does not know whether the evidence is true. `traced` means the number, in that unit, appears in the evidence after normalization. It does not mean the sentence means what the evidence means: a number can match a different figure of the same value.
- It does not understand sentences. It cannot tell "up 30%" from "down 30%", a revenue figure from a headcount, or which two numbers a derived value is about. Words, negation and context are invisible to it.
- It does not read number words (`twelve`, `half`), fractions (`3/4`, `3⁄4` and `3½` are flagged, not evaluated), scales stated elsewhere (`in thousands`), a percent sign written before the number (`%12`), or currency named in prose other than `dollars`, `euros` and the three-letter codes.
- It does not infer units that are not written: a percent written as `0.45` does not trace to `45%`, and `1,234` does not trace to `$1,234` unless you set `allowBareOutput` (the other way round, a `$1,234` output against a bare `1,234` in the evidence, needs `allowBareEvidence`).
- It does not truncate: an output that cuts digits off (`12.3%` from `12.39%`) is untraced, because only half-up and half-even rounding are accepted.
- A derived match is not proof the model derived it; with many evidence numbers, coincidences happen. Treat `derived` with a high `matches` count as weak.
- It is a mechanical check on numbers and sums. It makes no claim about whether an output is fit for any accounting, audit or legal purpose.

## Relationship to grounding-kit

`grounding-kit` checks that a citation marker on a sentence points at the evidence span it should. This library checks the numbers, with no citations needed. They answer different questions and can run on the same output.

## Development

```sh
npm ci
npm run verify   # lint, typecheck, tests, build, packaging checks
npm run attw     # type-resolution check of the packed tarball
npm run audit:dependencies
```

Node 20 or newer. ESM only. Zero runtime dependencies; no `node:` imports in `src`, so it runs in browsers too.
