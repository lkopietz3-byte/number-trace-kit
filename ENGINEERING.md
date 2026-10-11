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
- **Strong and weak links.** A match through primary readings on both sides is
  strong. A match that needs a non-primary reading of an ambiguous number on
  either side is weak and yields `unknown`. A number whose only reading is a
  locale guess (`weakPrimary`) never produces a strong link.
- **Derivations are opt-in, pairwise, and counted before they run.** The
  number of candidates (pairs times enabled derivations) is compared to
  `maxCandidates` before anything is generated. Over the cap: no candidates,
  `candidateCapHit`, every non-direct number `unknown`. Sums and differences
  must match exactly; ratios and percents match after rounding to the output's
  precision. Direction follows evidence order; a match only in the reverse
  order is `unknown`.
- **Linear time.** Extraction visits each character a bounded number of times.
  Digit chains are collected once. Over-long digit runs are never converted to
  BigInt. Rounding indexes are built lazily, once per distinct output scale.
  Evidence indexes cap each key's list at eight entries; the derivation index
  keeps a count and the first candidate of each kind per key, so candidates that
  collide on one value cost one lookup, not a rescan.
- **A caller RegExp is never run on caller text at large.** `ignorePattern` is
  copied into a private global RegExp and tested only on a window around each
  number (at most 64 characters of the number, 32 before, 16 after). Empty
  matches advance by a whole code point under `u`/`v`.
- **Groups share their modifiers.** A range, a dimension and a slash chain are
  groups. What one member says (unit, percent sign, currency, magnitude and its
  precision, the whole fraction text) applies to every member; a group is
  re-applied only when it learns something new, so long chains stay linear.
  Chain and grouping scans compute their boundaries once and never restart
  from the next element.
- **Every option applies on every path.** `allowBareEvidence`, `rounding`,
  `signMode` and `derivations` are honored by the exact, rounded, derived and
  weak (`unknown`) paths alike.
- **Read once.** Option bags, evidence documents, tokens, rows and parts are
  read one time each into local snapshots; the snapshot is what is validated
  and used. Sparse arrays and `undefined` items are rejected; array length is
  bounded before the walk. Errors thrown by a caller's getter or proxy
  propagate unchanged. Unknown option names are a `RangeError`.
- **No prototype reach.** Lookup tables keyed by text from the caller go
  through `own()`.
- **Text policy.** ASCII, full-width and every BMP script's decimal digits are
  numbers (folded one code unit to one code unit); digits outside the BMP are
  not. Numbers glued to Latin letters on the left, or to unknown Latin letters
  on the right, are identifiers and are skipped in the output (evidence keeps
  their digits as weak tokens). Letters of other scripts never glue, so a
  look-alike letter cannot hide a number. Invisible characters split numbers
  rather than hiding them.

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

`npm run verify` runs all of them. `verify:package` packs the tarball,
installs it into an empty project offline, imports every `exports` entry,
compares the exported names to `api-surface.json`, runs
`scripts/consumer-probe.mjs` by package name and type-checks
`scripts/consumer-probe.mts` under strict NodeNext.

## Tests

- `test/verdict-table.test.ts`: the verdict regression table. Honest outputs
  that must be clean, laundering outputs that must be flagged, and hostile
  inputs. Written first.
- `test/extract.test.ts`, `test/trace-rules.test.ts`, `test/reconcile.test.ts`,
  `test/decimal.test.ts`: the rules, one behavior per case.
- `test/hostile.test.ts`: scaling (20k versus 80k characters, CPU time),
  single reads, proxies, getters, wrong types, huge arrays.

## Release

The package is private and unreleased. Releasing means choosing a license,
removing `"private": true`, adding repository metadata and following the
maintainer's release process. None of that has been done.
