# Contributing

## Setup

```bash
npm ci
```

## Before you commit

```bash
npm run verify
```

`verify` runs lint, typecheck, tests, the build, and the packaging checks
in one command. It must pass locally before you commit.

## Fixing a bug

A behavior fix needs a regression test that fails on the old code first.
Write the test, confirm it fails against the current source, then make
your fix and confirm the test passes. Commit the test and the fix
together, with a message that says what was wrong. Add a row to
`test/verdict-table.test.ts` when the bug was a wrong verdict.

## Verdict changes

Never edit a fixture or an expected verdict to make a test pass. If a verdict
must change, say so in the commit message with the input that changed.

## Release

This is a public MIT package. Only the maintainer releases it, and only through
the release workflow: add a dated `CHANGELOG.md` entry, set `version` in
`package.json`, merge, then push a tag `v<version>` that matches it.
`.github/workflows/release.yml` verifies the build and publishes with npm
trusted publishing. Never run `npm publish` by hand.

## License

By contributing you agree that your contribution is licensed under the MIT
License in `LICENSE`.

## Security

Report vulnerabilities privately, not in an issue; see `SECURITY.md`.
