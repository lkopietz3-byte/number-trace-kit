# Method

How the numbers printed by `npm run bench` were made, what each label means, and what they cannot show. Evidence labels: Verified (checked by running something), Reported (a source says so), Unknown (not checked).

## Words used

- **Flagged**: the kit marked at least one number in the answer `untraced`. For the plain checkers, one of their numbers was not found in the evidence.
- **False fail**: an honest answer, or an honest number, that was flagged.
- **Catch**: an answer or number that really is unsupported and was flagged.
- **False pass**: an unsupported answer or number that came back `clean`.
- **Unknown**: the kit said it cannot tell and sent the number to a person. It counts as neither a flag nor a pass, and it is printed next to the false passes so nothing is hidden in it.
- Every rate is `k/n` with its denominator and a 95% Wilson score interval. Intervals are for sampling noise only; they say nothing about whether the labels are right.

## 1. Labeled number benchmark (203 items)

Composition: 103 honest items (20 traced, 20 rounded, 43 derived: sums, differences, ratios, percent changes, averages; 20 RAGTruth answers whose numbers all occur in the source) and 100 items with exactly one error: 14 invented numbers, 12 wrong units, 14 misrounded figures, 24 wrong derivations, 12 swapped numbers, 6 flipped directions, 18 RAGTruth numbers an annotator marked as absent from the source. By source: TAT-QA 147 items, FinQA 18, RAGTruth 38.

How the labels were made: the TAT-QA and FinQA answers are assembled from literal evidence text and labeled number parts, so each number's status is true by construction; planted errors are programmatic edits of those, recorded in `meta.edit`, and rejected when a generous oracle (any evidence number, its roundings, any pairwise sum, difference, ratio, percent, product, average, or three-number sum or average) could produce the planted value. RAGTruth items use the annotators' labels. An independent script re-derived all 775 number labels with separate code and found 0 violations (Reported: from the stage that built the benchmark; not re-run here). No person read the items.

Two groups are reported apart from the headline: **swapped numbers and flipped directions** are boundary probes, because every number in them is in the evidence and a value check cannot see them; and **coincidentally derivable** planted numbers (some pairwise derivation of evidence numbers can also produce them) are excluded in a second catch line.

What it cannot show: the errors are programmatic edits, cleaner than model errors; the answers use sentence templates written for the benchmark; each item holds one error; spelled-out numbers are not labeled. It flatters the kit and is the weakest evidence here. 38 RAGTruth items carry number-centered excerpts of their passages instead of the full passages (Verified: identical results, see below).

Settings: `default` (the five common derivations on), `report` (the `report` preset alone, as shipped: it turns on average and product too), `strict` (the `strict` preset with no derivations, so every honest derived answer is flagged by construction), and `allowBareEvidence`.

## 2. RAGTruth field corpus (289 answers)

Source: RAGTruth (real answers from six language models, annotators' span-level hallucination labels). Selection: test split, quality `good`, the answer has a digit, not a response the earlier benchmark used, seeded sample (seed 20261012): per task 45 answers with an annotated number that is absent from the source, 45 with no annotation, and 15 with only non-numeric annotations; summaries had 19 of the first kind. That is 135 clean, 109 numeric-error and 45 non-numeric-error answers across question answering, summaries and data-to-text (Yelp records as JSON). The sampling ran in Python; `data/selection-field.json` holds the chosen ids.

Token labels have two layers.

1. **Rule layer (kit never consulted).** A token inside an annotated span whose digits are absent from the source is `ERROR`; one outside every span is `HONEST`; one inside a span whose value is in the source is `UNCLEAR`. Then rules for list markers and passage references (`STRUCT`), unit-conversion pairs (`CONV`, such as `104°F (40°C)`), clock times in the data-to-text answers (compared with the times in the source), review counts and star ratings read from the JSON (data-to-text), all written from the answer text and the source, not the kit's output.
2. **Manual layer.** 38 hand judgements for residual tokens (`data/adjudication-manual.json`): 14 honest, 6 numbers annotators missed, 16 claims about the answer's own length (`META`), 2 unclear. **All 38 were written after the kit's verdicts were seen** (they are flagged `post_kit`). Eight of the 14 honest false fails rest on them. A frozen rule had a bug on a leading decimal point (`.25`) and was corrected by hand.

What the headline false-fail rate leaves out. `14/697 = 2.0%` counts flagged tokens classed `HONEST`. The kit also flagged 43 tokens that are not unsupported claims but are not plain honest numbers either: 21 unit-conversion pairs, 15 claims about the answer's own length, 6 numbers the annotators missed, 1 scale convention (`out of 5`). Counting all of them as honest, the rate is `57/753 = 7.6%`. The unit-conversion pairs and the word counts are the documented limits in the README.

Response-level rows: "honest responses" are the 135 with no annotation; "responses with an unsupported number" are those with at least one `ERROR` token (72).

Settings: `strict` with no ignore; `strict+markers` (an `ignorePattern` for list markers and `Passage N` references, the way a developer would have written it before `ignoreStructure` existed); `strict+structure` (`ignoreStructure: true`); `strict+small10` (`ignoreSmallIntegersUpTo: 10`); `report` and `report+markers`.

Committed form. The repository holds the answers, span offsets, per-run source facts and, for question answering and summaries, number-centered excerpts (48 characters either side of every digit). Data-to-text evidence (Yelp) is not committed. Offline, 184 of 289 answers run from excerpts. **Verified** with `node bench/build/check-excerpts.mjs --raw <dir>`: on every question answering and summary answer of this corpus and of the holdout (184 and 145 answers, 1,043 and 1,124 numbers) and every setting, the excerpts give the same status for every number and the same verdict for every answer as the full source: 0 differences.

## 3. FinanceBench (1,601 answers)

All 1,100 Correct and 501 Incorrect completions that contain a digit (refusals dropped) of the open-source sample, evidence = the annotators' filing pages. Labels are the dataset's human Correct and Incorrect, plus a script that finds whether the answer's headline number equals the gold value (within 1%, in any scale); that script agreed with the humans on 94% of Correct answers with a numeric gold (Reported: field trial). 153 Incorrect answers have a wrong headline number.

Each filing page is given to the kit twice, as printed and read at the filing's statement scale. The scale per filing is chosen without labels: the one of thousand, million, billion under which most currency numbers across all answers about that filing trace. This is optimistic: it uses the answers themselves. Answers with at most 4 numbers are "concise"; the rest "work through" figures the filing does not print (ratios, sums), which `strict` calls untraced by design.

Nothing from FinanceBench is committed (CC BY-NC). `npm run bench:fetch` downloads it; hashes are in `SOURCES.json`.

## 4. Fresh holdout and head-to-head

Purpose: numbers on data the kit was never tuned on, against plain checkers, with the labels fixed first.

**Source and draw.** RAGTruth train split (a split disjoint from the test split by source; none of its responses or sources is in sections 1 or 2). Quality `good`, the answer has a digit. Seed 20261014, drawn by `bench/build/select-holdout.mjs`: per task, annotated-number-absent answers (70 question answering, 25 summaries, 40 data-to-text) and 25 answers with no annotation. The first draw was 25 of each; labeling showed that most question answering and many data-to-text items were annotated only on list markers or clock formats, so the draws of the first kind were enlarged (the first 25 are unchanged). No kit run happened before or between.

**Label rule** (`bench/build/label-holdout.mjs`, written before the first kit run; the kit is never consulted). Numbers are found by `bench/lib/tokens.mjs`, a plain digit finder, and judged by the rule layer of section 2.
- `C`: the annotators marked nothing in the answer.
- `E`: the annotators marked a span and at least one number in it is absent from the source and is not a list marker, a passage or step reference, a clock time that equals a time in the source, or a unit-conversion pair.
- `amb`: the annotators marked a number span but every absent number in it is explained by those rules. These 60 answers are left out of scoring.
The rule was refined after reading the annotated spans of the drawn answers (it was the list markers and clock formats that made the first draw mostly ambiguous), before any kit run. Result: 210 drawn, 75 `E`, 75 `C`, 60 `amb`; 150 labeled.

**Freeze.** The labels, the selection and the label code were committed, with their SHA-256 hashes in `data/FROZEN-holdout.sha256`, before the kit was run on the holdout (the commit that added them is the one titled "bench: derived field corpus, ... labels frozen before any kit run on it"). `npm run bench` re-checks the hashes and prints a warning if any file changed.

**The checkers.** The kit with `strict` or `report` and `ignoreStructure: true` or not; and four deterministic checkers written the way a developer would (`bench/lib/baselines.mjs`, no language model): `exact-string` (a number's text, with $, % and commas as written, must be a substring of the evidence); `regex-set` (the value of every number, after dropping commas, $ and %, must be among the values the same regex finds in the evidence); `regex-set+structure` (the same, skipping list markers and passage or step references); `regex-set+rounding` (also accepting a number that equals an evidence number rounded to the digits shown, with plain floats).

**Scoring.** Item level. Recall is the share of `E` answers flagged; the false-flag rate is the share of `C` answers flagged; precision is flagged `E` over all flagged. "On the annotated number" counts an `E` answer only when the flagged number overlaps the number the label rule found. `unknown` counts as not flagged. Every miss and every false flag of the kit's headline setting is printed.

**Results as first run** (all tasks, full evidence; 75 `E`, 75 `C`):

| Checker | Recall (E flagged) | False flags (C flagged) | Precision |
| --- | --- | --- | --- |
| kit, `strict` | 73/75 = 97.3% (90.8 to 99.3%) | 22/75 = 29.3% (20.2 to 40.4%) | 73/95 = 76.8% (67.4 to 84.2%) |
| kit, `strict`, `ignoreStructure` | 71/75 = 94.7% (87.1 to 97.9%) | 11/75 = 14.7% (8.4 to 24.4%) | 71/82 = 86.6% (77.6 to 92.3%) |
| kit, `report` | 63/75 = 84.0% (74.1 to 90.6%) | 15/75 = 20.0% (12.5 to 30.4%) | 63/78 = 80.8% (70.7 to 88.0%) |
| kit, `report`, `ignoreStructure` | 61/75 = 81.3% (71.1 to 88.5%) | 9/75 = 12.0% (6.4 to 21.3%) | 61/70 = 87.1% (77.3 to 93.1%) |
| exact-string | 67/75 = 89.3% (80.3 to 94.5%) | 33/75 = 44.0% (33.3 to 55.3%) | 67/100 = 67.0% (57.3 to 75.4%) |
| regex-set | 74/75 = 98.7% (92.8 to 99.8%) | 33/75 = 44.0% (33.3 to 55.3%) | 74/107 = 69.2% (59.9 to 77.1%) |
| regex-set+structure | 74/75 = 98.7% (92.8 to 99.8%) | 22/75 = 29.3% (20.2 to 40.4%) | 74/96 = 77.1% (67.7 to 84.4%) |
| regex-set+rounding | 67/75 = 89.3% (80.3 to 94.5%) | 14/75 = 18.7% (11.5 to 28.9%) | 67/81 = 82.7% (73.1 to 89.4%) |

By task, kit `strict`+`ignoreStructure` against regex-set+structure: data-to-text recall 22/24 against 23/24, false flags 1/25 against 13/25; question answering recall 24/26 against 26/26, false flags 2/25 against 2/25; summaries recall 25/25 against 25/25, false flags 8/25 against 7/25. The `unknown` outcomes of the kit rows: `strict`+`ignoreStructure` sent 2 `E` answers to a person and let 2 through as `clean`; `report`+`ignoreStructure` sent 9 and let 5 through; of the `C` answers, `report` sent 7 to a person, the others at most 2.

What the table says, plainly. The kit and a plain regex check find almost the same unsupported numbers on this sample (71 against 74 of 75), the regex check slightly more. The kit flags half as many clean answers as the plain regex checks with list markers skipped (11 against 22 of 75), mainly in data-to-text, where clock times, star ratings and review counts are written in other forms than the source. The one plain checker with a similar false-flag rate, `regex-set+rounding`, catches 67 of 75. The intervals overlap on every row, so none of these gaps is established by 75 answers per class. On question answering and summaries alone the regex check with list markers skipped did as well as the kit. The holdout has few rounded or derived numbers, units, scales or dates, which is where the kit does something a regex cannot, so it is a weak test of those.

**Read after the run (post-kit, not part of the labels).** Every miss and false flag of the headline row, checked against the answer and the source:

| Item | What happened | Reading |
| --- | --- | --- |
| RT-16293 (miss, `clean`) | the annotated span is the cell references `A1:A5`, `A2:A5` | the label counted the digits inside cell names; the kit skips identifier shapes by design |
| RT-13496 (miss, `clean`) | the annotated span is `Private IPv4 Address` | the label counted the 4 in `IPv4`; the kit skips identifiers by design |
| RT-9698 (miss, `unknown`) | `5:00 PM`, the source has the hours in 24-hour form | the kit read the time as ambiguous and sent it to a person |
| RT-7558 (miss, `unknown`) | `1:30 PM`, twice | the same |
| RT-1275, RT-1857, RT-1930, RT-2806, RT-1864, RT-5625, RT-4743 (7 false flags) | `46 words`, `62 words`, `136 words`, `84 words`, `105 words`, `99 words`, `94-word` | a claim about the answer's own length, not in the source: the documented limit, skipped with `ignorePattern` |
| RT-13526 (false flag) | `$500` for a full day | the source says `$250 for half day and double that for the full day`; the number is arithmetic written in words, which the kit does not read |
| RT-13798 (false flag) | `250-300 degrees` | neither 250 nor 300 is in the source: a real unsupported number the annotators did not mark |
| RT-5070 (false flag) | `March 2024` | the source has `2024` and `March` in separate places; the kit checks whole dates and the month and year were not written together |
| RT-9460 (false flag) | `2.0 out of 5 stars` | the scale `5` is not in the source; the documented convention case |

So of the 4 misses, 2 are label artifacts and 2 are abstentions, none a silent pass of a real number. Of the 11 false flags, 7 are word counts, 1 is a true unsupported number the annotators missed, 1 is arithmetic in words, 1 is a date assembled from two mentions, 1 is a rating scale.

**What the holdout cannot show.** It comes from the same dataset family as section 2, with the same annotators and the same kinds of sources, so it tests generalization to unseen answers but not to a different domain. The `E` label is the annotators' and includes noise (identifier digits, annotators' misses of other numbers in `C` answers). The holdout answers are model prose, not financial tables. Labels were frozen before the run; the rule was refined from the annotated spans before the run, not from kit output. The numbers above are the first run; fixes made to the kit after it are in the changelog and do not change this table. Data-to-text evidence is not committed, so 50 of the 150 labeled answers run only after `npm run bench:fetch`. With committed excerpts only (question answering and summaries, 101 labeled answers: 51 `E`, 50 `C`), kit `strict`+`ignoreStructure` has recall 49/51 = 96.1% (86.8 to 98.9%) and false flags 10/50 = 20.0% (11.2 to 33.0%); `regex-set+structure` has 51/51 and 9/50.

## Cross-checks (dev only)

`npm run crosscheck` and the tests `test/icu-crosscheck.test.ts` and `test/decimal-crosscheck.test.ts`.

- **Locales against ICU.** Every locale of the 41 supported languages that this Node's ICU has its own data for (338 on ICU 78.3 / CLDR 48.0) prints 51 numbers (integers and decimals, both signs, written as exact decimal strings, so no float is involved) in four grouping modes, 204 printings, and the kit reads them back; it also prints four amounts in five currencies (symbol and code) and four percents, and the amounts must read back exactly (a currency word the kit does not know, such as the Bulgarian `щ.д.`, is read as a plain number) and the percents as percents. The kit's decimal mark and numeric-date order are compared with ICU's. Before the fixes in this release: 293 mismatches (31 regional decimal marks, 12 date orders, the marks repeated across the printed numbers); after: 0 of 83,824 printings (the decimal printings alone are 68,952 of them). Two printings the README says are not read are skipped: a percent sign written before the number (Turkish `%12,34`) and the Cape Verdean `1234$50`. Not covered: worded dates, and any Node version other than 26.3.0 (the CI matrix ships older ICU data; the test reads whatever ICU the running Node has).
- **Rounding and derivations against Python.** `scripts/crosscheck-decimal.py` (standard library `decimal` and `fractions`, run with `python3 -I`, version 3.9.6 here) answers from the cases alone. Five kinds: the rounding kernel (half-up and half-even, exact ties, negative scales), exact sum and difference, exact quotient, product, percent-of and percent-change, one evidence number written with fewer decimals (rounded, truncated, off by one unit), and each of the seven derivations on two numbers (the value the rule accepts must be `derived`, the reverse direction must be `unknown`, near misses must be `untraced`). 50,000 seeded cases, 146,009 comparisons, 0 mismatches. The check is not vacuous: kits with only half-up rounding, with ties always to even, or with `roundSums` switched on are caught (34, 79 and 420 mismatches on 4,000 cases). The oracle encodes the documented rules (direction, coarse rounding, exactness of sums); where the reference and the kit first disagreed, the reference was corrected only for rules the README states (a coarse rounding is `unknown`; the same value written with fewer digits is the same value; a direct rounding of an evidence number is `rounded`).
- A 3,000-case fixture of the Python answers is committed and asserted under `npm test`; `node scripts/crosscheck.mjs --check-fixture` shows Python still gives it.

## Reproducing

```sh
npm run bench                                   # committed data only
npm run bench:fetch -- --yes && npm run bench   # everything; FinanceBench and the data-to-text answers need the download
node bench/build/derive.mjs --raw bench/.cache/ragtruth --check       # committed derived files still match the raw download
node bench/build/check-excerpts.mjs --raw bench/.cache/ragtruth       # excerpts and full text give the same verdicts
npm run crosscheck
```

Done on 2026-10-15 at `b9a4713`: the local raw copies used for the full runs were compared with `SOURCES.json` (19 files, size and SHA-256: 0 differences). Done on 2026-10-21 at `e7b0b4a`, the last commit that changed the source: the offline run (committed data only) and `npm run crosscheck`, on Node 26.12.0 and Python 3.9.6, with the same figures as before. Not done: the full runs on the raw downloads after the source changes of `633ca6f`, `244dbe7`, `37809ce`, `fb144a7` and `e7b0b4a` (the data-to-text answers, FinanceBench and the full holdout are as run at `b9a4713`); downloading the pinned files again to compare them with the pinned URLs' content; runs on any Python other than 3.9.6 or any Node other than 26.3.0 and 26.12.0; a person reading the items.
