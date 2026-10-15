#!/usr/bin/env node
// Dev-only cross-check of the built package (dist/) against two reference implementations. Run `npm run build` first.
//   npm run crosscheck                        ICU on every supported locale this Node has, Python on 50,000 rounding and derivation cases
//   node scripts/crosscheck.mjs --cases 5000  fewer Python cases
//   node scripts/crosscheck.mjs --write-fixture   regenerate test/fixtures/decimal-crosscheck.json from Python (what the vitest check reads)
//   node scripts/crosscheck.mjs --check-fixture   fail if Python no longer produces the committed fixture
// The reference answers come from scripts/crosscheck-decimal.py (python3 -I, standard library only) and from this Node's Intl.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkCase, checkLocale, generateCases, icuLocales } from './crosscheck-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []))
const fixturePath = join(root, 'test', 'fixtures', 'decimal-crosscheck.json')
const SEED = 20261015

function python(cases) {
  const run = spawnSync('python3', ['-I', join(here, 'crosscheck-decimal.py')], { input: JSON.stringify(cases), maxBuffer: 1 << 30, encoding: 'utf8' })
  if (run.error) throw new Error(`python3 could not run: ${run.error.message}`)
  if (run.status !== 0) throw new Error(`the Python reference failed:\n${run.stderr}`)
  const version = spawnSync('python3', ['-I', '-c', 'import sys; print(sys.version.split()[0])'], { encoding: 'utf8' }).stdout.trim()
  return { expected: JSON.parse(run.stdout), version }
}

if (args['write-fixture'] || args['check-fixture']) {
  const cases = generateCases(SEED, 3000)
  const { expected, version } = python(cases)
  const fixture = { note: 'Cases from scripts/crosscheck-lib.mjs (seed 20261015) and the answers scripts/crosscheck-decimal.py gave for them. Read by test/decimal-crosscheck.test.ts. Regenerate with node scripts/crosscheck.mjs --write-fixture.', python: version, seed: SEED, cases: cases.map((c, i) => ({ c, e: expected[i] })) }
  const text = JSON.stringify(fixture) + '\n'
  if (args['write-fixture']) { writeFileSync(fixturePath, text); console.log(`wrote ${fixturePath}: ${cases.length} cases, Python ${version}`) } else {
    const have = JSON.parse(readFileSync(fixturePath, 'utf8'))
    const same = JSON.stringify(have.cases) === JSON.stringify(fixture.cases)
    console.log(same ? `the committed fixture is what Python ${version} gives (${cases.length} cases)` : 'DIFFERENT: Python no longer gives the committed fixture')
    process.exit(same ? 0 : 1)
  }
  process.exit(0)
}

const kit = await import(pathToFileURL(join(root, 'dist', 'index.js')).href)
const dec = await import(pathToFileURL(join(root, 'dist', 'decimal.js')).href)
const locale = await import(pathToFileURL(join(root, 'dist', 'locale.js')).href)
let failed = 0

// ICU
const tags = icuLocales(locale.SUPPORTED_LANGUAGES)
let prints = 0
let ambiguous = 0
const icuBad = []
for (const tag of tags) {
  const r = checkLocale(kit.extractNumbers, locale.resolveLocale, tag)
  prints += r.prints
  ambiguous += r.ambiguous
  icuBad.push(...r.mismatches)
}
console.log(`ICU ${process.versions.icu} (CLDR ${process.versions.cldr}), Node ${process.version}: ${tags.length} locales of ${locale.SUPPORTED_LANGUAGES.length} languages, ${prints} printed numbers read back, ${ambiguous} flagged ambiguous, ${icuBad.length} mismatches`)
for (const m of icuBad.slice(0, 40)) console.log(`  ${m}`)
if (icuBad.length) failed++

// Python
const n = Number(args.cases ?? 50000)
const cases = generateCases(SEED + 1, n)
const { expected, version } = python(cases)
let checks = 0
const bad = []
cases.forEach((c, i) => {
  const r = checkCase(kit, dec, c, expected[i])
  checks += r.checks
  bad.push(...r.bad)
})
console.log(`Python ${version} decimal and fractions: ${cases.length} cases, ${checks} comparisons, ${bad.length} mismatches`)
for (const m of bad.slice(0, 40)) console.log(`  ${m}`)
if (bad.length) failed++
process.exit(failed ? 1 : 0)
