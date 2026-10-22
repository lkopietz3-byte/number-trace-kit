# Method

How `number-trace-kit` decides, why each default is what it is, how to change it, and how often each heuristic was wrong when measured. Exact matching rules are in the README; this file is the reasoning and the evidence.

## What this kit does and does not claim

The kit checks evidence. It does not certify truth or compliance.

- `traced` means a number, in that unit, appears in the evidence you supplied after normalization. It does not mean the evidence is true, that the sentence means what the evidence means, or that the right number is in the right place.
- `clean` means every number was found, rounded from, or derived from the evidence and nothing was left unread. It is not an approval.
- Nothing here is legal, accounting, audit, medical or financial advice, and a `clean` result is not a statement that an output is fit for any of those purposes. Do not rely on this kit as the only check on a decision that matters. Keep a person in the loop for anything `untraced` or `unknown`, and for the failures listed under Honest limits.
- The software is provided as is, under the MIT license (`LICENSE`).

## Principles

1. **Exact arithmetic.** Values are decimal strings and BigInt. A JS float never carries a compared value. Reason: a float cannot say that `0.1 + 0.2` equals `0.3`, and a check that rounds silently can pass a wrong figure.
2. **Fail only on positive evidence.** `untraced` is returned only when the number, in that unit, is not among the evidence numbers. Anything the kit cannot decide is `unknown`, never a pass and never a failure. Reason: a false alarm and a false pass both cost trust, and "cannot tell" is the honest third answer.
3. **Never drop a number silently.** Every stretch of text that holds digits is either a number, listed in `skipped` with a reason, or ignored by an option you set.
4. **Linear time on hostile input.** Texts are scanned once; caps on text size, evidence size and derivation search keep cost bounded.

## Verdicts

| Verdict | When | Reason | How to change it |
| --- | --- | --- | --- |
| `untraced` | at least one number is `untraced` | the number is positively absent from the evidence | skip numbers you accept with `ignore`, `ignoreKinds`, `ignoreYears`, `ignoreStructure`, `ignorePattern`; add derivations with `preset: 'report'` or `derivations` |
| `unknown` | nothing untraced, but a number is `unknown` or a glued form such as `12foo` was skipped | the kit cannot tell what the number means or whether it matches, so it never calls the output clean | resolve the cause (pass the right `locale`, spell the date in the evidence, add the unit), or accept the number with `ignore` |
| `clean` | every number is `traced`, `rounded`, `derived` or `ignored` and nothing unread was skipped | nothing positive was found against the output | not a setting. An output with no numbers is `clean`; check `numbers.length` and `skipped` if you expect some |

Number statuses: `traced` (same class and exact value), `rounded` (evidence rounded to the digits shown), `derived` (an opted-in computation over evidence numbers), `untraced`, `ignored`, `unknown`. Every `unknown` carries a `reason`; the list is in the README under Verdict.

## Defaults and why

| Default | Reason | How to change it |
| --- | --- | --- |
| `preset: 'strict'`: direct and rounded matches only, no derivations | the safest reading: a number must be in the evidence or a rounding of it. A derived number is a claim about arithmetic the model may not have done | `preset: 'report'` or `derivations: [...]` |
| `derivations`: none | derivations make coincidences possible; they are opt-in and counted against a cap | list any of `sum`, `difference`, `ratio`, `percent-change`, `percent-of`, `average`, `product` |
| `rounding: ['half-up', 'half-even']` | the two real rounding conventions; truncation is not accepted because a cut figure (`12.3%` from `12.39%`) is a different number | `rounding: []` for exact matches only |
| `maxCandidates: 5000` | the derivation search is counted before it runs; past the cap every non-direct number is `unknown`, not guessed | raise it (to 1,000,000), narrow the evidence, or narrow the derivation list |
| `maxDerivationMatches: 3`, `maxDerivationDensity: 0.5` | on a page with many numbers, a derived figure that can be built many ways says little. The guard turns it into `unknown` (`derivation-too-likely`) | raise either limit only if you accept looser matches |
| `maxOperands: 2` | pairs only; triples multiply the candidate count | `maxOperands: 3` for three-operand `sum`, `difference` and `average` |
| `roundSums: false` | sums and differences are exact, so only an exact match counts | `roundSums: true` (the `report` preset sets it) |
| `signMode: 'explicit'` | an explicit sign must agree (`-5%` is not `5%`); a negative in parentheses against positive evidence is `unknown` (`sign-differs`) because it may be a parenthetical figure; an unsigned output may drop a sign, and is marked `signDiffers` | `'strict'` makes a dropped sign `unknown`; `'magnitude'` ignores signs |
| `allowBareEvidence: false`, `allowBareOutput: false` | a percent or amount against a unit-less number is a likely coincidence | set either to `true` (the `report` preset does); matches are marked `unitUnverified` |
| unit on one side only is `unknown` (`unit-unverified`) | `5pm` against `5.0 stars` can be a coincidence between different quantities | no switch; write the unit on both sides or `ignore` the number. An invoice quantity `3 x Widget A` is not a multiple (see the README, Normalization) |
| `locale: 'en-US'` | a separator can be a decimal mark or a grouping mark; the locale decides | pass `locale` for the output and `evidenceLocale` for the evidence |
| `parenthesesAreNegative: true` | accounting prints losses in parentheses, but a bare `(2)` or `(2024)` is left alone, and in the evidence a percent in parentheses right after a word or a figure (`Tax (8.25%)`) is a label, not a loss, and the same words in the output trace to it as written. Prose that uses parentheses as asides for amounts needs `false` | `false` |
| `evidenceScale`, `evidenceCurrency`: none | the kit never guesses a scale from a header such as "(in thousands)"; you say it | set them, or `scale` and `currency` on an evidence document |
| `evidenceOrder: 'oldest-first'` | the direction of a change follows the order the evidence mentions the numbers | `'newest-first'` for tables that list the later period first |
| `checkIdentifiers: false` | identifiers (`Q3`, `5G`, `v2.1`) are names, not numbers, so they are skipped and listed without changing the verdict; a wrong quarter passes if the numbers around it trace | `true`: an identifier the evidence text does not contain is `unknown` (`not-in-evidence`) |
| nothing ignored | an ignore hides real errors | `ignore`, `ignoreKinds`, `ignoreYears`, `ignoreStructure`, `ignoreSmallIntegersUpTo`, `ignorePattern` |
| size limits (text 5,000,000 UTF-16 units, 1,000,000 array items, 50,000,000 evidence characters, 500,000 evidence numbers, 500,000 output numbers) | bounded memory and time on untrusted input; over the limit is a `RangeError`, not a partial answer | `maxEvidenceNumbers` and `maxOutputNumbers` lower their limits; the others are fixed |
| unknown option names are a `RangeError` | a typo must not silently turn a check off | fix the name |
| `reconcile`: tolerance `'0'`, floats are a `TypeError` | totals are exact; a float is not | `tolerance`, `allowFloat: true` knowingly |

## How the rates below were measured

- **Data.** The labeled benchmark in `bench/` (203 number items: 103 honest, 100 with one planted or annotator-labeled error; the planted errors are programmatic edits, so it flatters the kit), RAGTruth answers with annotator labels (a field corpus of 289, and a holdout of 150 labeled before the kit ran), and FinanceBench (1,601 answers). Sources, licenses and labeling method: `bench/METHOD.md`, `bench/SOURCES.json`, `bench/NOTICE.md`. Some hand judgements were made after the kit's verdicts were seen; `bench/METHOD.md` counts them.
- **Revision.** The figures marked Verified were run at the release head (version 0.1.0, code revision `b9a4713`, 2026-10-15; the commits after it change documentation only). The figures marked Reported come from an earlier revision or from a source other than this run (a synthetic test, a review), and are not claimed to hold at the release head.
- **Run.** Verified by running `npm run bench` on Node 26.3.0 with ICU 78.3 on 2026-10-15: the labeled benchmark, all 289 RAGTruth answers, FinanceBench and the full 150-answer holdout, from local copies of the raw downloads that `npm run bench:fetch` fetches (19 files; their sizes and SHA-256 hashes match `bench/SOURCES.json`; they were not downloaded again for the check). The same run without the raw downloads (offline, committed data only) covers the 184 question-answering and summary answers that run from committed excerpts and the 101 holdout answers whose evidence is committed (the other 49 need the raw download).
- **Terms.** "False flag" is an honest item the kit marked `untraced`. "Caught" is a planted error marked `untraced`. "False pass" is a planted error that came back `clean`; "sent to a person" is a planted error that came back only `unknown`. Each is `k/n` with its denominator. Intervals are 95% Wilson; they are in `bench/` output and in the README. Read each number as what one run on one sample said, not as a rate on your data.

## Heuristics and their measured rates

Counts that say Verified were produced by the run above. Reported means they come from an earlier revision or from a source other than this run. "Not measured" means no labeled data covers the case; the heuristic is covered by tests but has no rate.

| Heuristic | What it does and why | Measured false flag | Measured false pass |
| --- | --- | --- | --- |
| Direct match, exact value and class (`traced`) | the base rule | labeled: 0 of 20 honest traced items flagged (Verified) | labeled: swapped numbers and flipped direction pass by design, 12 of 12 swapped and 2 of 6 flipped came back `clean` under the default settings (Verified) |
| Rounding, half-up and half-even (`rounded`) | an honest figure is often a rounding of a more precise one | labeled: 0 of 20 honest rounded items flagged (Verified) | labeled: misrounded figures, 1 of 14 `clean`, 3 `unknown` under the default settings (Verified) |
| `strict` preset, no derivations | the safest reading | labeled: 43 of 103 honest items flagged, because every honest derived answer is `untraced` (Verified) | labeled: 0 of 82 detectable planted errors `clean`, 1 `unknown` (Verified) |
| Derivations listed (the labeled benchmark's default run: sum, difference, ratio, percent-change, percent-of) | lets an honest computed figure pass | labeled: 9 of 103 flagged = 8.7% (Verified) | labeled: 1 of 82 `clean` = 1.2%, 6 of 82 `unknown` (Verified) |
| `report` preset | every derivation, rounded sums, bare-unit leniency, coincidence guard | labeled: 6 of 103 flagged = 5.8% (Verified; the run uses the preset as shipped, with average and product on); RAGTruth excerpts, 4 of 387 honest numbers flagged (Verified) | labeled: 3 of 82 `clean` = 3.7%, 15 of 82 `unknown` (Verified); RAGTruth excerpts: 2 of 66 unsupported numbers passed = 3.0% (Verified, after the coarse 0 or 1 rule); full corpus 2 of 106 = 1.9% (Verified) |
| `allowBareEvidence` | a percent or amount may match a unit-less evidence number | labeled: 9 of 103 flagged (Verified) | labeled: 4 of 82 `clean` = 4.9%, 8 of 82 `unknown` (Verified) |
| Coincidence guard (`derivation-too-likely`) | a figure buildable many ways is `unknown`, not `derived` | counted inside the `report` rows above | checked against an independent oracle: 4,959 derivation outputs, 0 unsound (Reported) |
| Identical values never pair (`twin-operands`) | one fact printed twice cannot support a doubled or zero figure | counted inside the derivation rows above | on twin-rich evidence, 44 of 16,503 outputs matched only through a twin pair and were `derived` before the rule, now `unknown` (Reported) |
| Coarse ratio (`coarse-derivation`) | a ratio shown with one significant digit says too little | not measured on labeled data | on 1,500 random outputs, 228 were `derived` by chance before the rule, 1 after (Reported, a synthetic test) |
| Coarse zero or one (`coarse-derivation`) | a whole number 0 or 1 that only a rounding of a ratio, percent-of, product or percent change builds says too little | RAGTruth excerpts under `report`: honest numbers marked `unknown` unchanged at 15 of 387 (Verified) | RAGTruth excerpts under `report`: unsupported numbers passed fell from 5 to 2 of 66 (Verified); a claim of zero passed on 16 of 67 realistic evidences before the rule (Reported by the release review, `report` preset) |
| Early years held as labels (`label-derivation`) | a four-digit whole number from 1000 to 1899 written with no separator can be a year, and a derivation can build one by coincidence (`1879` from `1876` and a count of `3`); only 1900 to 2100 reads as a year elsewhere | an honest derived count in that range (`1500 units` from `1000` and `500`) becomes `unknown`; not measured on labeled data | in a sweep of 8,070 wrong years from 1000 to 1899 against evidence with a year and three small counts under `report`, 408 came back `clean` before the rule (Reported by the review) and 0 after (Verified by rerunning that sweep after the change) |
| Hyphenated compound units (`kilowatt-hours`, `ft-lb`, `mile-per-hour`) | two units with a hyphen between them are one unit, so energy is not power and a dollar-day is not a dollar; `kilowatt-hours` is `kWh` | not measured on labeled data | the pairs from the review (`25 kilowatt-hours` against `25 kilowatts`, `mile-per-hour` against `miles`, `dollar-days` against `dollars`, and the others) were `clean` before the rule and are not after (Verified by the regression rows) |
| Coarse rounding (`coarse-rounding`) | `About 1,200` from `1,234` is `unknown`, not `untraced`; it only turns a failure into `unknown` | the labeled benchmark and field corpus were unchanged by it (Reported) | none added: it never turns a pass into anything |
| Unit on one side only is `unknown` | `5pm` against `5.0` could be a coincidence | RAGTruth excerpts, 184 answers, `strict` with list markers ignored: 14 of 387 honest numbers `unknown` = 3.6% (Verified); the full-corpus rate with and without the rule was not rerun and is not quoted | RAGTruth excerpts, same setting: 0 of 66 unsupported numbers passed (Verified); the earlier before-and-after count is dropped because it was measured on code that has changed |
| `ignoreStructure` | skips list markers, bracket citations and `Step 4` style labels | RAGTruth excerpts: honest responses not clean 35 of 90 without it, 18 of 90 with it (Verified); full corpus: 42 of 45 honest question-answering responses clean with it, 25 of 45 without (Verified) | RAGTruth excerpts: 0 of 39 responses with an unsupported number came back `clean` either way (Verified); full corpus 0 of 72 (Verified) |
| `ignoreSmallIntegersUpTo: 10` | hides small counts, which includes real wrong counts | fewer honest flags (15 of 90 honest responses not clean) (Verified) | RAGTruth excerpts: 2 of 39 responses with an unsupported number came back `clean` = 5.1% (Verified); full corpus 3 of 72 (Verified). Not recommended |
| Clock times as minutes since midnight | `6pm`, `18:00` and `18:0` are one value | on data-to-text answers, honest tokens flagged fell from 44.9% (189 of 421) to 2.6% (8 of 310) (Reported) | no unsupported number passed after the change, 0 of 40 (Reported) |
| Whole-date matching | a date traces as day, month and year together | not measured on labeled data; the `March 2024` put together from two places in a source is a known false flag (Verified on the holdout) | not measured |
| Locale separators and numeric date order | a separator is read by the locale, never guessed | 338 ICU locales, 83,824 printed decimals, amounts and percents read back with 0 mismatches (Verified by `npm run crosscheck` on 2026-10-15, at the release head) | a locale guess is `unknown`, never a pass |
| Rounding and derivation arithmetic | BigInt, half-up and half-even | 50,000 seeded cases against Python `decimal` and `fractions` (146,009 comparisons), 0 mismatches (Verified by `npm run crosscheck` on 2026-10-15, at the release head) | same |
| Rates (`/month`, `/kg`) are part of the quantity | `25 mg/kg` is not `25 mg`, `$29/month` is not `$29/year`; a percent or an amount whose rate only one side writes still traces, exactly or by rounding, because answers drop the rate in prose | no honest number newly flagged on the RAGTruth excerpts or the earnings-release rows (Verified); no labeled rate corpus | not measured on labeled data |
| Skipped forms listed, not read (compound `2h45m`, `2026-W10`, circled and subscript numerals, an unread form the evidence does not repeat) | the kit cannot tell what the figure means, so the verdict is `unknown`, never `clean` | on the RAGTruth excerpts the offline strict figures did not move (Verified) | not measured on labeled data; covered by the release-review regression rows |
| En dash may be a minus (`ambiguous-sign`) | typeset text uses it as a minus, prose as a dash | not measured | not measured |
| Candidate cap, scale cap | a search that was not run is `unknown` | not measured | none by construction: nothing is passed |

Against plain checkers, on the 150-answer holdout (Verified at the release head, with the full holdout evidence): with `strict` and `ignoreStructure`, the kit flagged 71 of 75 answers with an unsupported number and 11 of 75 clean answers. A regex that checks values against the evidence, with list markers skipped, flagged 74 of 75 and 22 of 75. The kit and a plain regex check find about the same unsupported numbers on this sample; the kit flags half as many clean answers, mostly in data-to-text. On the 101 question-answering and summary answers alone (the part that runs offline from committed excerpts) the regex check with list markers skipped did better than the kit on both measures: it flagged 51 of 51 answers with an unsupported number against the kit's 49 of 51, and 9 of 50 clean answers against the kit's 10 of 50. The difference between them shows where the kit does more than a regex: rounded and derived numbers, units, dates and locales, which the holdout has few of.

## Honest limits

- It checks numbers, not sentences. A right number in the wrong place, a direction flip (`rose` for `fell`) and swapped fields pass. On the labeled benchmark 0 of 18 such items were caught under the default settings. On 153 FinanceBench answers with a wrong headline number, 8 (5.2%) came back `clean` (Verified at the release head); the audit found the values on the page, in the wrong row or rounded from another cell.
- It does not know whether the evidence is true or complete.
- It does not read number words (`twelve`), fractions it cannot value (`⅓`), a scale stated elsewhere (`in thousands`; you set `scale`), or currency written as prose other than dollars, euros and codes.
- The word lists for units, currencies and month names are short and mostly English. Month names are read in English and seven other languages.
- Some honest answers are flagged. About one honest RAGTruth response in seven needs a person under `strict` with list markers ignored (20 of 135, Verified). Claims about the answer itself (`in 46 words`) are `untraced`.
- A derived match is not proof the model derived the number. Treat `derived` with a high `matches` count as weak.
- The labeled benchmark is small and its errors are programmatic edits. The RAGTruth and FinanceBench rows are real model answers with outside labels, but each is one sample.
- Derivations are not scoped to a document, row or sentence; any two numbers of one class in the evidence can combine. Derived values do not chain.

The README lists the rest under Known limits.
