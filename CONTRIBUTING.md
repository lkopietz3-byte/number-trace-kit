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

## Publishing

@evidencekit/numbers is a public MIT package. After 0.1.0, every release goes only through
`.github/workflows/release.yml`: push a `v*` tag whose version matches `package.json`
and the workflow runs the checks and publishes with npm trusted publishing. Do not push
tags without the owner's decision. Before tagging, update `CHANGELOG.md` and run
`npm run verify`, `npm run attw` and `npm pack --dry-run`. The release job also requires a
successful `Verify` workflow run on the tagged commit (so tag a commit that went through the
pull request or `main` checks), runs the checks once, and publishes with `--ignore-scripts`
so the test suite does not run a second time.

### First publish (0.1.0)

npm's documentation does not say whether a name that has never been published can be given
a trusted publisher, so 0.1.0 has two possible paths, and only the owner takes them (an agent
never runs `npm trust`, `npm login` or `npm publish`):

1. On tag day the owner first tries to set up trusted publishing for the new name:

   ```bash
   npm trust github @evidencekit/numbers --file release.yml --repo evidencekit/numbers --allow-publish --yes
   ```

   If npm accepts it, there is a pending trusted publisher for `release.yml`. Push the `v0.1.0`
   tag on the green `main` commit and the workflow publishes 0.1.0 with provenance. npm expires a
   trusted-publisher setting that has no successful publish within 2 days, so create it on the day
   of the tag and push the tag at once.
2. If npm refuses because the package does not exist, the owner runs `npm publish --access public` once
   (a scoped name needs it on its first publish), by hand, from a clean checkout of the tagged commit (`git clone`, `git checkout v0.1.0`,
   `npm ci`; the `prepublishOnly` script runs `npm run verify`). That publish has no provenance.
   The owner does not set up trusted publishing yet: npm expires a trusted-publisher setting that
   has no successful publish within 2 days, and the next release (0.1.1) will not be ready by
   then. On the day of the 0.1.1 release the owner runs the `npm trust` command above, now that
   the package exists, and pushes the `v0.1.1` tag right after it, so 0.1.1 publishes from the
   tag with provenance and so does every later version. Pushing the `v0.1.0` tag afterward is
   safe: the workflow skips a version that is already on the registry.

The README links to `bench/` files under `blob/main`, which resolve once the release branch
is merged to `main`. A published `name@version` can never be reused, so fix forward with a
new version.

## License

By contributing you agree that your contribution is licensed under the MIT
License in `LICENSE`.

## Security

Report vulnerabilities privately, not in an issue; see `SECURITY.md`.
