import { describe, expect, it } from 'vitest'
import * as dec from '../src/decimal.js'
import { traceNumbers } from '../src/index.js'
import { checkCase } from '../scripts/crosscheck-lib.mjs'
import type { CrosscheckCase, CrosscheckExpected } from '../scripts/crosscheck-lib.mjs'
import fixtureText from './fixtures/decimal-crosscheck.json?raw'

// Rounding, exact arithmetic and the derivations, checked against Python's decimal and fractions.
// test/fixtures/decimal-crosscheck.json holds 3,000 seeded cases and the answers scripts/crosscheck-decimal.py gave for them
// (python3 -I, standard library only). The kit never sees the answers when it computes. `npm run crosscheck` redoes the whole check
// against dist/ with 50,000 fresh cases, and `node scripts/crosscheck.mjs --check-fixture` proves Python still gives this fixture.
//   R rounding kernel (half-up and half-even, ties, negative scales)   A exact sum and difference   Q quotient, product, percent-of, percent-change
//   T one evidence number written with fewer decimals: rounded, truncated or off by one unit
//   D each derivation on two numbers: the value the rule accepts, the reverse direction (unknown), and near misses (untraced)

interface Fixture { python: string; seed: number; cases: { c: CrosscheckCase; e: CrosscheckExpected }[] }
const fixture = JSON.parse(fixtureText) as Fixture

describe('decimal cross-check against Python (decimal-crosscheck:)', () => {
  const kits = { traceNumbers: (output: string, evidence: string, options: never) => traceNumbers(output, evidence, options) }
  for (const kind of ['R', 'A', 'Q', 'T', 'D']) {
    it(`decimal-crosscheck: kind ${kind} agrees with Python ${fixture.python} on every case`, () => {
      const mine = fixture.cases.filter(({ c }) => c.k === kind)
      expect(mine.length).toBeGreaterThan(100)
      const bad: string[] = []
      let checks = 0
      for (const { c, e } of mine) {
        const r = checkCase(kits, dec, c, e)
        checks += r.checks
        bad.push(...r.bad)
      }
      expect(checks).toBeGreaterThanOrEqual(mine.length)
      expect(bad.slice(0, 10)).toEqual([])
    })
  }

  it('decimal-crosscheck: the fixture is broad (ties, negative scales, both rounding modes, all seven derivations)', () => {
    const count = (pred: (c: CrosscheckCase) => boolean) => fixture.cases.filter(({ c }) => pred(c)).length
    expect(count((c) => c.k === 'R' && (c.s as number) < 0)).toBeGreaterThan(20)
    expect(count((c) => c.k === 'R' && c.m === 'e')).toBeGreaterThan(100)
    for (const op of ['sum', 'difference', 'ratio', 'percent-change', 'percent-of', 'average', 'product']) {
      expect(count((c) => c.k === 'D' && c.op === op), op).toBeGreaterThan(50)
    }
    const expects = new Set(fixture.cases.flatMap(({ e }) => (e.ys ?? []).map((y) => y.expect)))
    expect([...expects].sort()).toEqual(['derived', 'rounded', 'unknown', 'untraced'])
  })
})
