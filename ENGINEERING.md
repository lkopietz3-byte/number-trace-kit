# Engineering contract

This package is a pure TypeScript/ESM library with three entry points:
`extractNumbers` (text to exact-decimal tokens), `traceNumbers` (does each
output number trace to the evidence) and `reconcile` / `reconcileComponents`
(do rows add up). It has no UI, storage, network, clock or randomness. The
source entry is `src/index.ts`; the package export resolves to generated
`dist/index.js`.

## Layout

- `src/decimal.ts`: BigInt decimals and fractions, exact rounding (half-up,
  half-even), canonical keys. No floats.
- `src/locale.ts`: decimal mark and numeric-date order per locale. An unknown
  language is a `RangeError`.
- `src/extract.ts`: the scanner. Folds full-width and Arabic-Indic characters
  one code unit to one code unit (so offsets stay valid), then walks the text
  once. Look-behind and look-ahead are fixed-size windows; a digit-and-separator
  chain is collected once and consumed left to right.
- `src/trace.ts`: evidence indexes, matching, rounding, derivations, verdict.
- `src/reconcile.ts`: exact sums and the amount-type rules.
- `src/input.ts`: read-once helpers (options bags, array snapshots).

## Invariants

- **Exact arithmetic only.** Values are decimal strings; arithmetic is BigInt.
  Equality is on canonical keys (sign, leading zeros and trailing fraction
  zeros removed) so `12.50` equals `12.5`. Precision (`scale`) is kept
  separately and is what rounding is measured against.
- **Fail only on positive evidence.** `untraced` means the number, in that
  unit, is not among the evidence numbers. Anything that cannot be decided is
  `unknown`: an ambiguous reading, a locale guess, a superscript or exponent, a
  number over 60 digits, a derivation whose direction cannot be confirmed, a
  derivation search larger than `maxCandidates`.
- **A one-sided unit is not a match.** A direct or rounded match where only one side has a recognized unit
  (`5pm` against `5.0`) is `unknown` (`unit-unverified`). Leniency is opt-in and always visible: matches allowed by
  `allowBareEvidence` / `allowBareOutput`, and derived numbers, stay marked `unitUnverified` and are counted in
  `counts.unitUnverified`. A dropped sign is marked `signDiffers`, counted, and `unknown` under `signMode: 'strict'`.
- **Strong and weak links.** A match through primary readings on both sides is
  strong. A match that needs a non-primary reading of an ambiguous number on
  either side is weak and yields `unknown`. A number whose only reading is a
  locale guess (`weakPrimary`) never produces a strong link.
- **Derivations are opt-in, pairwise by default, and counted before they run.**
  The number of candidates (pairs times enabled derivations, plus triples at
  `maxOperands: 3`) is compared to `maxCandidates` before anything is
  generated. Over the cap: no candidates, `candidateCapHit`, every non-direct
  number `unknown`. Sums and differences must match exactly unless
  `roundSums`; ratios, percents, averages and products match after rounding to
  the output's precision. Direction follows evidence order (or
  `evidenceOrder: 'newest-first'`); a match only in the reverse order is
  `unknown`.
- **Identical values never form a derivation pair.** Candidates built from two
  evidence numbers of the same class, unit and value (or a triple containing
  such a pair) go to a separate twin list, not the candidate list. They cannot
  make a number `derived`, count toward `derivation.matches` or the density,
  and a number only they build is `unknown` (`twin-operands`). A product, ratio
  or percent-of that is zero only through a zero operand is held the same way
  (`zero-operand`). They are still counted in `derivationCandidates` and in the
  cap. A year or ordinal in the output is never `derived`: it is `unknown`
  (`label-derivation`), and so is an inexact ratio shown with one significant
  digit (`coarse-derivation`).
- **A derived match is checked for coincidence.** `derivation.matches` counts
  the candidates that produce the displayed value. More than
  `maxDerivationMatches`, or a neighborhood denser than
  `maxDerivationDensity`, is `unknown` (`derivation-too-likely`). Do not relax
  the guard to make a row pass.
- **Linear time.** Extraction visits each character a bounded number of times.
  Digit chains are collected once. Over-long digit runs are never converted to
  BigInt. Rounding indexes are built lazily, once per distinct output scale.
  Evidence indexes cap each key's list at eight entries (a unit-less output reads
  the exact unit-less list before the capped list of every plain figure, so
  figures with units cannot crowd out a bare one; a rated output reads the figure written without a rate from a list of its own, so eight figures of another rate cannot crowd out that one either); the derivation index
  keeps a count and the first candidate of each kind per key, so candidates that
  collide on one value cost one lookup, not a rescan.
  Cost, stated exactly: extraction is linear in characters; the evidence heap is
  about a kilobyte per number, so evidence is capped at 500,000 numbers
  (`maxEvidenceNumbers` lowers it) and the scan stops the moment it is exceeded.
  Derivation candidates are counted before they are built (same-class pairs
  times derivations, plus the count-times-amount and percent-of-amount pairs)
  and cost one sort by value. Only the pairs and triples that can make a candidate
  are visited (same class and unit, a count with an amount, a percent with an
  amount), so tokens that never combine cost a pass, not a loop over every pair.
  The derivation index of one output scale holds
  only the candidates within 26 units of the numbers written at that scale; a
  scale that needs more than 64 separate stretches is filed whole once. At most
  12 distinct scales are answered, so the worst case is candidates times 12,
  and the usual case for an output with many precisions is candidates plus a
  few lookups per scale. The rounding index of a scale (direct matches) is still
  one pass over the evidence per distinct scale.
- **A caller RegExp is never run on caller text at large.** `ignorePattern` is
  copied into a private global RegExp and tested only on a window around each
  number (at most 64 characters of the number, 32 before, 16 after). Empty
  matches advance by a whole code point under `u`/`v`.
- **Groups share their modifiers.** A range, a dimension and a slash chain are
  groups. What one member says (unit, percent sign, currency, magnitude and its
  precision, the whole fraction text) applies to every member; a group is
  re-applied only when it learns something new, so long chains stay linear.
  Chain and grouping scans compute their boundaries once and never restart
  from the next element. A pair is joined into a range only when the two
  numbers can be one quantity (`rangeCanShare`): a percent beside an amount or a
  measured unit never is, and in the spoken forms ("to", a spaced en dash,
  "between ... and") a percent is never carried forward and never with a
  magnitude ("rose 8% to $4.2 billion" is a change and its result).
- **Structure numbers are an opt-in, bounded scan.** `ignoreStructure` skips a plain whole number of at most three digits
  that labels the answer's own structure (a line-start list marker of one or two digits, a bracket citation, the number after
  the singular Step, Passage, Figure, Option or Question, again one or two digits). Each check looks at a fixed window around
  the number and never runs a regex. A legal citation (`Section 230`, `Section 50(1)`) and a plural (`figures 240`) are not structure. Numbers from caller-supplied tokens carry no text and are never skipped this way.
- **Every option applies on every path.** `allowBareEvidence`, `rounding`,
  `signMode` and `derivations` are honored by the exact, rounded, derived and
  weak (`unknown`) paths alike.
- **Read once.** Option bags, evidence documents, tokens, rows and parts are
  read one time each into local snapshots; the snapshot is what is validated
  and used. Sparse arrays and `undefined` items are rejected; array length is
  bounded before the walk. Errors thrown by a caller's getter or proxy
  propagate unchanged. Unknown option names are a `RangeError`.
- **No prototype reach.** Lookup tables keyed by text from the caller go
  through `own()`. Every caller value (option, evidence document field, token field,
  reconcile row field) is read as an own property (`getOwn`, `readOptions`), and the
  records the kit builds with optional fields (tokens, suffix and group records,
  currency matches) have no prototype (`noProto`), so a polluted `Object.prototype`
  (`ignoreSmallIntegersUpTo`, `tolerance`, `text`, `amount`, `unit`, `currency`) cannot
  change a verdict. Returned tokens inherit nothing from `Object.prototype` for the same reason (their prototype chain ends in an internal object, so `token.hasOwnProperty` is not there, and a token is not `deepStrictEqual` to a plain object literal).
- **The output is bounded too.** `maxOutputNumbers` (default and maximum 500,000) stops the scan of an output text the moment it holds more numbers
  and skipped forms; a 5,000,000-character text of single digits would otherwise be millions of tokens.
- **Text policy.** ASCII, full-width and every BMP script's decimal digits are
  numbers (folded one code unit to one code unit); digits outside the BMP, and
  every other character of Unicode category No or Nl (circled, dingbat,
  superscript, subscript and roman numerals), are not, and are listed in `skipped`
  as unread forms, so none of them can hide a figure. Numbers glued to Latin
  letters on the left, or to unknown Latin letters on the right, are identifiers
  and are skipped in the output (evidence keeps their digits as weak tokens, and
  the text of every skipped form, so the output can be checked against it). A
  skip never reaches back into a number already read, and a stretch that was
  skipped closes the look-behind for what follows. Letters of other scripts never
  glue, so a look-alike letter cannot hide a number. Invisible characters split
  numbers, and between a number and its unit, percent or magnitude word they
  count as the space they stand for; a line break is not a space.

## Setup and verification

Declared dependencies are TypeScript, Vitest, ESLint and the package-check
tools in package-lock.json. For a clean environment use `npm ci`.

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run verify:package
```

`npm run verify` runs all of them. Two more checks run in CI and are worth
running before a release: `npm run attw` (are the types and the module format
right for every resolution mode) and `npm run audit:dependencies` (known
advisories in the lockfile, dev tools included). `verify:package` packs the tarball,
installs it into an empty project offline, imports every `exports` entry,
compares the exported names to `api-surface.json`, runs
`scripts/consumer-probe.mjs` by package name and type-checks
`scripts/consumer-probe.mts` under strict NodeNext.

## Tests

- `test/sweep.test.ts`: a seeded combinatorial sweep. A grammar of number forms
  (locale-printed numbers, percents, currencies, magnitudes, scientific
  notation, units including the micro sign, ranges, dimensions, dates, signs,
  versions, fractions, superscripts) is placed in varied contexts and checked
  against four invariants: an equivalent writing is never untraced; a different
  value or incompatible unit is never traced; NFC/NFD and full-width/ASCII give
  the same statuses; and traced/untraced agree with an independent reading of
  the evidence, where a weak or ambiguous number may only be traced by the same
  group written the same way. `SWEEP_SEED=n` shifts every seed to hunt with
  fresh draws.

- `test/verdict-table.test.ts`: the verdict regression table. Honest outputs
  that must be clean, laundering outputs that must be flagged, and hostile
  inputs. Written first.
- `test/extract.test.ts`, `test/trace-rules.test.ts`, `test/reconcile.test.ts`,
  `test/decimal.test.ts`: the rules, one behavior per case.
- `test/hostile.test.ts`: scaling (40k versus 160k characters, CPU time),
  single reads, proxies, getters, wrong types, huge arrays.
- `test/locales.test.ts`: numbers as `Intl.NumberFormat` prints them in 27
  locales read back exactly.
- `test/fuzz.test.ts`: a deterministic fuzz; extraction never throws and tokens
  slice back to their raw text.
- `test/derivations-more.test.ts`, `test/field-round.test.ts`: averages and
  three-operand derivations; whole dates, scale and currency hints, the
  coincidence guard and other rows from reports and pricing pages.
- `test/review-round*.test.ts`: regression rows for defects found in
  independent review, each reproduced before its fix.
- `test/field-regression.test.ts`: real model answers (RAGTruth) with annotator
  labels, run from the committed number-centered excerpts in `bench/data`. It
  fails when a number is newly flagged `untraced`, newly `unknown`, or newly
  passes, or when a response with an unsupported number newly comes back `clean`,
  against `bench/data/field-regression-baseline.json`. A baseline moves only on
  purpose (`node bench/build/make-regression-baseline.mjs`) and the commit says why.
- `test/icu-crosscheck.test.ts`: every ICU locale of the supported languages
  prints numbers; the kit reads them back and agrees with ICU on the decimal mark
  and numeric-date order. A CLDR update that changes a locale fails it on purpose. The kit's locale rules were fitted to
  the CLDR data of Node 26.3.0 (ICU 78.3), the only version this release was run on; the CI compatibility matrix runs the
  same test on older Node lines with older CLDR data (Not run: unverified until it has run there).
- `test/decimal-crosscheck.test.ts`: 3,000 seeded cases answered by Python's
  `decimal` and `fractions` (rounding, exact arithmetic, the seven derivations).

## Benchmark and cross-checks

`bench/` and `scripts/crosscheck*` are development tools. Neither is in the npm
tarball (`files` lists `dist`, `README.md`, `METHOD.md`, `LICENSE` and `CHANGELOG.md`), and nothing in
`src` may import from them. `npm run bench` prints false-fail, catch and false-pass
with denominators and 95% intervals; `bench/METHOD.md` says how every label was
made. Rules:

- The README's "Accuracy on real data" numbers are copied from `npm run bench`.
  Change the kit, rerun, update the README; never quote a number the bench did not print.
- Third-party data is committed only as derived data a license allows (model
  answers, annotator labels, number-centered excerpts). FinanceBench (CC BY-NC) is
  never committed. Raw downloads go through `npm run bench:fetch`, which checks pinned
  SHA-256 hashes, and are never executed.
- The fresh holdout (`bench/data/ragtruth-holdout.jsonl`, labels frozen in
  `data/FROZEN-holdout.sha256`) was measured once. Tuning the kit against it spends
  it: report new holdout numbers only from a new draw labeled before the run, and say
  so.
- `npm run crosscheck` compares the built package with Node's ICU (every locale of
  the supported languages) and with Python's `decimal` (50,000 cases). Run it after
  touching `src/locale.ts`, `src/decimal.ts` or the rounding and derivation code.

## Release

The package is public and MIT licensed (`LICENSE`, `"license": "MIT"`, repository
metadata in `package.json`). `files` lists `dist`, `README.md`, `METHOD.md`,
`LICENSE` and `CHANGELOG.md`, and `scripts/verify-package.mjs` fails if the tarball
holds anything else, if `private` is set, or if the license is not MIT.

Publishing happens when a `v*` tag is pushed.
`.github/workflows/release.yml` refuses to run off a tag, refuses a tag that does not
match the `package.json` version, requires a successful `Verify` workflow run on the tagged
commit (the Node 20 to 24 consumer matrix included), runs the audit, `npm run verify` and
`npm run attw` once, checks the registry (only a confirmed E404 means "not published yet",
so a re-run on a published version does nothing), and publishes with npm trusted publishing
(`id-token: write`, no stored token, no npm cache) and `--ignore-scripts`, so the tested
`dist/` is what ships and the suite does not run again (`prepublishOnly` still runs
`npm run verify` for a hand publish).

1. Add a dated entry to `CHANGELOG.md` and set `version` in `package.json`.
2. Merge to `main`, wait for `Verify` to pass on every job, then push the tag `v<version>`.
3. Trusted publishing must be configured for this package on npmjs.com.

The 0.1.0 path is the one exception to "only through the workflow". npm's docs do not say
whether a never-published name can be given a trusted publisher. On tag day the owner first
tries `npm trust github number-trace-kit --file release.yml --repo lkopietz3-byte/number-trace-kit --allow-publish --yes`.
If npm refuses because the package does not exist, the owner (never an agent) runs
`npm publish` once from a clean checkout of the tagged commit, which gives 0.1.0 no
provenance, then sets up trusted publishing the same day, so 0.1.1 onward publish from the
tag with provenance. Every later release goes only through `release.yml`; nobody runs
`npm publish` by hand again (`CONTRIBUTING.md` has the steps).

Before the first tag: the GitHub repository named in `package.json`, the README and `SECURITY.md`
(`lkopietz3-byte/number-trace-kit`) must exist, be public and have private vulnerability reporting on, because
trusted publishing, provenance and the README link to `bench/` all point at it. The release review found it did not exist yet.

A published `name@version` can never be reused and npm's unpublish window is
narrow, so fix forward with a new patch version instead of unpublishing.
