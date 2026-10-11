# number-trace-kit

Does every number in this AI output trace to the evidence it was given, and do the rows add up to the printed totals?

A small TypeScript library that pulls the numbers out of a text, normalizes them into exact decimals, and checks each one against the numbers in the evidence you supply. It also adds up rows and compares the sum to a printed total, to the cent. All comparisons use exact decimal arithmetic (BigInt), never floats.

Status: version 0.1.0, private and unreleased. The package is marked `"private": true` and `UNLICENSED`; it is not published anywhere and no license has been chosen.

## What it does

- **`extractNumbers(text, options?)`** finds every number and returns tokens with the exact decimal value, the precision shown, the kind (percent, currency, count, decimal, year, date part, ordinal), the unit or currency, and the offsets in your text. A form that can be read two ways is returned with `ambiguous: true` and its other readings. It never picks one quietly.
- **`traceNumbers(output, evidence, options?)`** gives every number in the output one of six statuses: `traced`, `rounded`, `derived`, `untraced`, `ignored` or `unknown`, and an overall verdict of `clean`, `untraced` or `unknown`.
- **`reconcile({ rows, total, tolerance? })`** and **`reconcileComponents({ parts, total })`** add up amounts in exact decimals and report `ok`, the sum, the total and the signed difference.

It does not call a model, read a network, or use the clock or randomness. Same input, same options, same result.

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
2. **Cannot be compared.** A number glued to a superscript or an inline exponent (`10²`, `10^6`) or longer than 60 digits is `unknown`.
3. **Dates and times** are compared part by part (year, month, day, hour, minute, second). A part matches an evidence part with the same value and the same role. A numeric date whose day and month cannot be told apart (`10/12/2026` when both are 12 or below and different) has no roles; it traces only to evidence that writes the same date text, and is `unknown` if the same values appear any other way (another date, or a bare month, day or year).
4. **Traced.** Same class and the same exact value after normalization (see Normalization). Classes are: percent (`%`), percentage points (`pp`), currency (one class per currency code), and plain numbers (counts, decimals, years, ordinals). A percent never matches a plain number or an amount; `$45` never matches `45 EUR`.
5. **Rounded.** The evidence is more precise than the output, and rounding the evidence value to the number of decimals the output shows gives the output value. The result says which rule produced the match: `half-up` (a tie goes away from zero), `half-even` (a tie goes to the even neighbor) or `either` (not a tie, both agree). `12.34%` rounds to `12.3%` and `12%`, never to `13%`. A magnitude counts as precision: `1.2 million` is precise to the nearest 100,000, so it matches `1,234,567` but not `1,350,000`.
6. **Derived.** Only for the derivations you list in `options.derivations` (none by default), and by default only pairwise: two evidence numbers of the same class and unit, one operation (three with `maxOperands: 3`). See Derivations.
7. **Unknown, another reading.** Nothing above matched, but the number would match if an ambiguous number on either side were read the other way (see Ambiguity). Status `unknown`, reason `ambiguous-reading`.
8. **Unknown, search too large.** Derivations are on and the candidate cap was hit (see Derivations). Status `unknown`, reason `candidate-cap`.
9. **Untraced.** Nothing above matched. This is a positive finding: the number, in that unit, is not in the evidence you gave. `nearMisses` lists evidence with the same value but a different unit, kind or sign.

### Normalization

- Thousands separators and the decimal mark follow the locale (`en-US` by default). `1,234.50`, `1234.5` and `1 234,50` (French) are the same number when read in the right locale. Under a comma-decimal locale an ordinary space also groups digits, but only as a short first group followed by groups of exactly three (`1 234`, `12 345 678`); `5 12` and `2024 123` stay two numbers. Under `en-US` an ordinary space never groups. Trailing fraction zeros do not matter for equality (`12.50` equals `12.5`) but do count as precision for rounding.
- `1.2 million`, `1.2M` after a currency symbol, `$3.4M`, `5 bn` and `7 thousand` are scaled exactly (`1200000`).
- Currency: `$` is read as USD (the symbol is also used for other dollars; use `US$`, `CA$`, `A$`, a code, or a word to be explicit). `USD 5`, `5 USD`, `$5`, `US$5` and `5 dollars` are the same amount. `¥` stays `¥`; it is not guessed to be JPY or CNY.
- Percent: `45%`, `45 %`, `45 percent` and `45 per cent` are the same. `0.5 pp` and `0.5 percentage points` are percentage points, a different class from percent.
- A range such as `10-12` is two numbers (written `10-12`, `10–12`, `10 – 12` or `10 to 12`), and what is written once covers all of them: a unit, a percent sign, a currency, a magnitude and its precision (`10-12%`, `$10-12`, `5-10 days`, `$1-2M`, `1.5-2.5 million`, `-5–-3%`). A scientific exponent belongs to its own number only: in `1e3–2000 kg` the second endpoint stays 2,000. A date range shares its month (`Oct 5-7`, `5-7 October`). A hyphen with spaces around it is arithmetic, not a range.
- A dimension such as `3 x 4 cm`, `3x4 cm` or `2 × 4` is two numbers with an operator between, and a unit written once covers both. A standalone multiple (`10 x faster`, `3x`) is a number with the unit `x`.
- Signs: a leading `-`, `−` (U+2212) or `+` is an explicit sign. `(1,234)`, `($5)` and `(12.5%)` are negative when the number has a separator, a decimal, a currency or a percent sign; a bare `(2)` or `(2024)` is left alone. Turn parentheses off with `parenthesesAreNegative: false`.
- Sign matching (`signMode: 'explicit'`, the default): an explicit sign in the output must agree with the evidence, so `-5%` does not trace to `5%`. An unsigned output may drop a sign the evidence has, and the result is marked `signDiffers`. `signMode: 'magnitude'` ignores signs entirely.
- Units: a recognized measurement unit (`kg`, `km`, `days`, `hours`, `MB`, `x` and a short list of others, glued or as the next word, after any numeric form including `1.2e3 kg`) must agree when both sides have one. If only one side has a recognized unit, the number still traces and the result is marked `unitUnverified`; the same holds for a derived number (`7 kg` from `3` and `4`), but never for operands in different units, and a ratio takes no unit. Words that are not in the list (`users`, `orders`) are not units.
- `allowBareEvidence: true` lets a percent or amount in the output match an evidence number with no unit at all (a table cell that prints `1,234.50`), marked `unitUnverified`. It applies on every path: exact, rounded, derived, and the weaker links that give `unknown`. Default off.
- A year inside a date also vouches for a bare year elsewhere, and a bare year vouches for the year of a date.

### Ambiguity: never guessed

A token is `ambiguous` when the text can be read more than one way. The primary reading is what `value` holds; other readings are in `alternates`.

| Form | Why it is ambiguous | Primary reading |
| --- | --- | --- |
| `1.234` under `en-US` | one separator then exactly three digits, and the separator is the decimal mark: could be 1,234 written the German way | `1.234` (alternate `1234`) |
| `1,234` under `de-DE` | the same, mirrored | `1.234` (alternate `1234`) |
| `12,5` under `en-US`, `3.14` under `de-DE` | the separator does not fit the locale; one reading, but it is a guess about the locale | read as a decimal |
| `4K`, `2M` | a magnitude letter with no currency: 4,000, or the label "4K" | `4000` (alternate `4`) |
| `10²`, `10^6` | an exponent that is not expanded | `10` |
| `3/4`, `1/2/3` | a fraction or ratio, which is not evaluated; the same fraction written the same way in the evidence still traces | each half |
| `10/12/2026` | day and month order | no roles |
| digit runs over 60 digits | too long to compare | the digits |

How an ambiguous number is matched: if its primary reading matches the other side's primary reading, it traces (and the token says `ambiguous: true`). If the only link is through another reading (an exact match, a rounded match, or a derivation using the other reading), the status is `unknown` with reason `ambiguous-reading`. A number whose only reading is a locale guess (`12,5` under `en-US`, or `12,5K`) can never trace, only be `unknown` or `untraced`; that holds whatever other readings it also has, and the token says so with `localeGuess: true`. A number in a slash chain (`1.000/2.000`) is judged as the whole chain, whatever else is ambiguous about its parts. Pass the right `locale` for the output and `evidenceLocale` for the evidence (they are read separately; the evidence locale defaults to the output locale).

### Derivations

`options.derivations` is a list of any of:

- `sum`: `a + b`. Exact match required.
- `difference`: later minus earlier in the order the evidence mentions the numbers; an unsigned output matches either way round. Exact match required. A difference of two percents is a percentage-point number and also matches a `%` output.
- `ratio`: `a / b`, a plain number or an `x` multiple (`0.8`, `0.8x`).
- `percent-change`: `(b - a) / a * 100`, a percent.
- `average`: the mean of two evidence numbers (three with `maxOperands: 3`), in the same class and unit. Matched after display rounding, like a ratio, so the result says `exact: false` and which rounding rule matched when the mean has more digits than the output shows.
- `percent-of`: `a / b * 100` for two numbers of the same class (what percent is a of b), and `p% * x` when one operand is a percent and the other an amount or count (7.5% of $200.50).

Rules:

- Pairs by default; `maxOperands: 3` (opt-in) also tries every triple for `sum`, `difference` and `average`. A three-operand `difference` is one figure less the other two (`100 - 30 - 25`); no figure is "earlier", so it has no direction rule, and the sign follows the arithmetic. Direction rules for pairs are unchanged, and nothing changes for a call that does not set `maxOperands`. Operands must be in the same class and unit (percents with percents, amounts of one currency with each other). Two percents give a percent through `percent-of` (`10%` and `20%` give `50%`). Years, dates, ordinals and ambiguous numbers are never operands. A value that appears more than twice counts twice.
- Sums and differences are exact arithmetic, so only an exact match counts. Ratios and percents are inexact, so they match after rounding to the output's precision, and the result says `exact: false` and which rounding rule matched. A loose match is visible: `derivation.matches` counts how many different candidates produced the number.
- Direction follows the order the evidence mentions the numbers: the first mentioned is the "from", the second the "to". If a number matches only when the operands are taken the other way round (an unsigned `30%` where the evidence lists the new value first), the status is `unknown` with reason `derivation-direction`, because the direction of a change is in the words, which this library does not read.
- The search is capped. The number of candidates (pairs times derivations, plus triples times derivations at `maxOperands: 3`) is counted first. If it is larger than `maxCandidates` (default 5,000, at most 1,000,000), nothing is generated, `candidateCapHit` is true, and every number that is not a direct match is `unknown` with reason `candidate-cap`: never traced, and never called untraced, because the search was not complete. Narrow the evidence or the derivation list, or raise the cap.
- Many candidates make coincidences likely. A derived status says "this number can be built from two evidence numbers", not "the model built it that way". Look at `derivation.operands` and `matches`.

For a table of many rows and a printed total, use `reconcile`; it is exact and not limited to pairs.

### Verdict

- `untraced`: at least one number is `untraced`.
- `unknown`: nothing is untraced, but at least one number is `unknown`.
- `clean`: every number is `traced`, `rounded`, `derived` or `ignored`. An output with no numbers is `clean` (there was nothing to trace).

## What gets treated as a number, and what does not

- Digits: ASCII digits, full-width digits and punctuation (U+FF01 to U+FF5E), and the decimal digits of every script in the Basic Multilingual Plane (Arabic-Indic, Devanagari, Thai and the rest) are read, folded to ASCII the way NFKC folds full-width forms, with offsets still pointing into your original text. Digits outside that plane (mathematical digits) are not numbers to this library, and number words (`twelve percent`) are not read.
- Numbers glued to Latin letters are identifiers, not numbers: `X3`, `v2.1`, `H2O`, `COVID-19`, `GPT-4`, `F-16`, `5G`, `A4`, `3D`, `FY2025`, `Q3`, `x86_64`, `iPhone15`. They are skipped in the output, so a model name or version string is never asked to trace. A letter-glued form that is a unit (`5kg`, `10x`), a magnitude (`5bn`), an ordinal (`3rd`) or a currency code (`100USD`) is read as such. Dotted chains like `1.2.3` and `192.168.1.1` are skipped as versions and addresses, and a version keeps its whole suffix (`v1.2.3+4`, `1.2.3-rc.1`, `2.0.0-beta.2+build.5`). In the evidence, the digits inside a skipped identifier are kept as weak evidence: an output number equal to them (a `2025` against `FY2025`) is `unknown`, never `traced`.
- Letters of other scripts do not glue: `100円`, `第3回` and `1,234.50米ドル` contain the numbers 100, 3 and 1,234.50. A look-alike Cyrillic or Greek letter next to a digit therefore cannot hide the number.
- Invisible characters split a number: `1<ZWSP>234` is two numbers, so a hidden character cannot make a number vanish. NFC and NFD text read the same numbers.
- A lone surrogate is an ordinary non-digit.
- Scientific notation (`1.5e3`) is read exactly and may carry a percent sign, currency or unit (`1e2%`, `1.2e3 kg`); an exponent over 30 is `too-long`, however many digits it has.
- The micro sign (U+00B5 and U+03BC) is a unit prefix for `m`, `s`, `g` and `L` (`5µm`, `3 μL`); anywhere else it ends the number instead of hiding it.
- A date part followed by a superscript or exponent (`Oct 5²`, `2026-10-05²`) is flagged like any other number with an exponent.
- Canonically equivalent letters read the same: the Kelvin sign is `K` and the Angstrom sign is `Å`, so `K3` is an identifier like `K3`.
- Percent signs after magnitudes are kept (`1 million %`, `5M%`).
- Combining marks stay with their letter, so `café3` is an identifier whether it is written precomposed or decomposed. A combining mark after a digit does not hide the digit.
- Numbers handed in as pre-extracted tokens follow the same rules: a value over 60 digits is `too-long` whatever its flags say, and a token whose `ambiguous` flag disagrees with its `ambiguity` reason (or that has alternates without being ambiguous) is a `TypeError`.

## Options

`traceNumbers(output, evidence, options)`. Every option is read once. An unknown option name is a `RangeError`, so a typo cannot silently turn a check off.

| Option | Default | Meaning |
| --- | --- | --- |
| `locale` | `en-US` | locale of the output text |
| `evidenceLocale` | same as `locale` | locale of the evidence text |
| `parenthesesAreNegative` | `true` | read `(1,234)` as negative |
| `derivations` | none | any of `sum`, `difference`, `ratio`, `percent-change`, `percent-of` |
| `rounding` | `['half-up', 'half-even']` | accepted rounding modes; `[]` means exact matches only (exact derivations such as a sum still work) |
| `maxOperands` | `2` | `2` or `3`: how many evidence numbers `sum`, `difference` and `average` may combine |
| `maxCandidates` | `5000` | derivation search cap, 1 to 1,000,000; the triples count too, so `maxOperands: 3` usually needs a larger cap (about 100,000 for 40 numbers) |
| `signMode` | `explicit` | `explicit` or `magnitude` |
| `allowBareEvidence` | `false` | let a percent or amount trace to a unit-less evidence number |
| `ignore` | none | exact raw strings to skip, and plain numbers (a number skips only unit-less plain numbers of that signed value) |
| `ignoreKinds` | none | skip every number of these kinds (for example `['ordinal']`) |
| `ignoreYears` | `false` | skip years and the year of a date |
| `ignoreSmallIntegersUpTo` | off | skip unit-less whole numbers from 0 to this value |
| `ignorePattern` | none | a `RegExp`; see below |

`evidence` is one string, or an array whose items are `{ id, text }` documents and/or pre-extracted tokens (`NumberToken`, optionally with `evidenceId`). Tokens are validated; a malformed one is a `TypeError`.

Common ignores: citation markers and reference numbers that are not claims. `ignorePattern: /\[\d+\]|Section \d/` skips `[3]` and `Section 4`; `ignoreSmallIntegersUpTo: 10` skips small unit-less counts; `ignoreYears: true` skips years.

`ignorePattern` is tested against a short window only: the number itself (at most its first 64 characters) plus up to 32 characters before it and 16 after. The pattern must overlap the number to ignore it. The pattern is copied into a private global RegExp, so your flags (`g`, `y`) and `lastIndex` are never touched or shared, and empty matches advance by a whole code point under `u`/`v`. The window bounds how much text a pattern can see, so work stays linear in the text; it cannot make a badly written pattern fast, so keep patterns simple (`/Section \d/`, not nested quantifiers).

Supported locale languages: `de`, `fr`, `es`, `it`, `pt`, `nl`, `ru`, `pl`, `sv`, `da`, `nb`, `nn`, `no`, `fi`, `cs`, `sk`, `sl`, `hr`, `ro`, `hu`, `bg`, `tr`, `id`, `vi`, `el`, `uk`, `sr`, `lt`, `lv`, `et` (comma decimal) and `en`, `ja`, `zh`, `ko`, `he`, `th`, `hi`, `ms`, `fil`, `ga`, `cy` (dot decimal), with regional exceptions (`de-CH`, `es-MX`, `es-US` and a few more use a dot; `en-ZA` uses a comma). Indian digit grouping (`12,34,567`) is read for regions `IN`, and an apostrophe groups digits (`1'234'567`) for regions `CH` and `LI`. Numeric dates are month-first for `en-US`, `en` and `en-PH`, day-first otherwise. An unsupported language is a `RangeError`, not a guess.

## reconcile

```ts
reconcile({ rows: [{ label, amount }, ...], total, tolerance = '0' }, { minorUnitDigits = 2, allowFloat = false })
reconcileComponents({ parts: { paid: '1000.00', reserve: '250.50' }, total: '1250.50' })
```

- A **string** amount is an exact decimal in major units (`"12.34"`): digits, optional sign, optional fraction. No spaces, separators, exponents or currency symbols.
- An **integer `number` or `bigint`** is in minor units: `1234` is `12.34` at the default two minor-unit digits. Use `minorUnitDigits: 0` for currencies without a minor unit.
- A **non-integer number, `NaN` or `Infinity`** is a `TypeError`: floats are not exact. `allowFloat: true` is the one escape hatch, and it changes the meaning of every JS `number` in the call to a major-unit decimal read from its shortest round-trip text (`0.1` is exactly `0.1`, `12` is `12`). Use it only when you cannot get strings.
- The result is `{ ok, sum, total, difference, tolerance, rows }` with exact decimal strings. `difference` is `sum - total`; `ok` is `|difference| <= tolerance` (inclusive). Zero prints as `0`.
- Empty rows, a missing total, a negative tolerance and unknown keys are errors, not passes.

## Known limits

These came out of review and a combinatorial sweep, and are decided, not pending:

- The word list for units, currencies and month names is short and English. Other words are not units (`5 users`, `3 Mio.`), and a month name only counts with a capital letter.
- `to` and a spaced en dash join two numbers into a range even in prose that is not a range (`9 to 5 job`, `pages 3 – 7`): the only effect is that a unit or percent sign written on one number is also given to the other.
- `3 x 4` gives the first number the unit of the second (`3 x 4 cm`), including where the first is a count (`2 x 5 kg`).
- An ordinary space groups digits only under comma-decimal locales and only as `1 234`; `1 234` under `en-US` is two numbers.
- `1.2.3-rc.1` and `v1.2.3+4` are versions; other hyphenated words after a number (`3.5-inch`) are not.
- A percent sign written before the number (`%12`), number words, and digits outside the Basic Multilingual Plane are not read.
- Rounding is half-up and half-even only; truncation is untraced.

## What it does not do

- It does not read the source documents for you. You supply the evidence text; if the evidence is incomplete or wrong, the result is only as good.
- It does not know whether the evidence is true. `traced` means the number, in that unit, appears in the evidence after normalization. It does not mean the sentence means what the evidence means: a number can match a different figure of the same value.
- It does not understand sentences. It cannot tell "up 30%" from "down 30%", a revenue figure from a headcount, or which two numbers a derived value is about. Words, negation and context are invisible to it.
- It does not read number words (`twelve`, `half`), fractions (`3/4` is flagged, not evaluated), scales stated elsewhere (`in thousands`), a percent sign written before the number (`%12`), or currency named in prose other than `dollars`, `euros` and the three-letter codes.
- It does not infer units that are not written: a percent written as `0.45` does not trace to `45%`, and `1,234` does not trace to `$1,234` unless you set `allowBareEvidence`.
- It does not truncate: an output that cuts digits off (`12.3%` from `12.39%`) is untraced, because only half-up and half-even rounding are accepted.
- A derived match is not proof the model derived it; with many evidence numbers, coincidences happen. Treat `derived` with a high `matches` count as weak.
- It is a mechanical check on numbers and sums. It makes no claim about whether an output is fit for any accounting, audit or legal purpose.

## Relationship to grounding-kit

`grounding-kit` checks that a citation marker on a sentence points at the evidence span it should. This library checks the numbers, with no citations needed. They answer different questions and can run on the same output.

## Development

```sh
npm install
npm run verify   # lint, typecheck, tests, build, packaging checks
```

Node 20 or newer. ESM only. Zero runtime dependencies; no `node:` imports in `src`, so it runs in browsers too.
