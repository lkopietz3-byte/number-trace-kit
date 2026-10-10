# number-trace-kit: agent instructions

Check that every number in an AI output traces to the evidence it was given, and that rows add up to printed totals, using exact decimal arithmetic (BigInt, never floats). Zero-dependency, framework-agnostic TypeScript. Private and unreleased (`"private": true`, `UNLICENSED`).

## Read first
- `ENGINEERING.md` holds this package's invariants and design rules; read it before changing behavior.
- `README.md` states the matching rules exactly; behavior and README must stay in step.
- `SECURITY.md` covers the security posture; follow it for anything touching input handling.

## Commands (from package.json)
- `npm run verify`
- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run verify:package` packs and installs the tarball offline; run `npm run build` first.

## Rules
- Run `npm run verify` and read its output before calling work done. Report any step that did not run.
- Build cleans `dist/` first; never trust a stale `dist/` for declaration or package checks.
- Never weaken lint, tests or `api-surface.json` to get green. Public API changes are deliberate (`node scripts/verify-package.mjs --update-api`) and must be called out.
- Do not run `npm publish`, push, or tag without explicit permission. The package is private; treat any claim that a version is published as Reported until the registry confirms it.
- Runtime `dependencies` stay empty; add dev tooling only. No `node:` imports in `src`.
- Keep unrelated uncommitted work intact; never stage or reset the whole tree. Commit by explicit path.

## Code Review Rules

- No floats in any value comparison. Values are exact decimal strings and BigInt; a JS `number` never carries a value that is traced, rounded, derived or reconciled. Small structural checks (a day is at most 31, a year-shaped token has four digits) may use `Number` on short digit strings.
- "Cannot tell" is its own state (`unknown`, `ambiguous`), never a silent pass and never a false fail. A candidate-cap overflow, an ambiguous reading, a direction that cannot be confirmed and a locale guess must stay `unknown`.
- `traced` means the number appears in the evidence after normalization. Do not make the docs or the code claim more (truth of the evidence, meaning of the sentence).
- Every loop over caller text is linear. No unanchored regex over untrusted text; the only regexes are on bounded strings (locale tags, number-to-string output, flags). A caller regex is copied, bounded to a short window, and never shared.
- Read every caller value once (options, documents, rows, parts, getters, proxies). Reject sparse arrays, wrong types and unknown option names.
- Table lookups from caller text go through `own()` or a `Map`, never a bare object index.
