import { describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'
import { GROWTH_LIMIT, growthRatio } from './growth.js'

// Regression rows for the finding of the independent review of the compound-unit fixes (head c0ace37):
// run11:P2 (a range that resolves a bare currency sign must update the currency-dependent compound too).

const verdict = (output: string, evidence: string): string => traceNumbers(output, evidence).verdict
const shape = (text: string): string[] =>
  extractNumbers(text).map((t) => `${t.raw}|${t.currency ?? '-'}|${t.unit ?? '-'}|${t.ambiguous === true ? 'amb' : 'ok'}`)

describe('run11:P2 a range that resolves a bare currency sign carries the resolved currency on the compound', () => {
  it.each([
    ['$5 dollar-days to $10 CAD-days'],
    ['$5 CAD-days to $10 dollar-days'],
    ['$5 dollar-days to $10 CAD'],
    ['$5 CAD to $10 dollar-days'],
    ['$5-10 CAD-days'],
    ['$5 dollar-days to $7 dollar-days to $10 CAD-days'],
  ])('run11:P2 %s has one currency and one unit on every member', (text) => {
    const toks = extractNumbers(text)
    expect(toks.length).toBeGreaterThanOrEqual(2)
    for (const t of toks) {
      expect(t.currency, `${t.raw} currency`).toBe('CAD')
      expect(t.unit, `${t.raw} unit`).toBe('CAD-day')
    }
  })

  it.each([
    ['$5 to $10 CAD-days', '$5 dollar-days to $10 CAD-days'],
    ['$5 dollar-days to $10 CAD-days', '$5 to $10 CAD-days'],
    ['$5 CAD-days to $10 dollar-days', '$5 to $10 CAD-days'],
    ['$5 to $10 CAD-days', '$5 CAD-days to $10 dollar-days'],
    ['$5 to $10 CAD-days', '$5 dollar-days to $10 CAD'],
    ['$5 dollar-days to $10 CAD-days', '$5 dollar-days to $10 CAD-days'],
  ])('run11:P2 %s against %s is clean', (output, evidence) => {
    expect(verdict(output, evidence)).toBe('clean')
  })

  it('run11:P2 the range stays distinct from other currencies and units', () => {
    expect(verdict('$5 to $10 CAD-days', '$5 dollar-days to $10 USD-days')).not.toBe('clean')
    expect(verdict('$5 to $10 CAD-days', '$5 to $10 CAD-hours')).not.toBe('clean')
    expect(verdict('$5 to $10 CAD-days', '$5 to $10 CAD')).not.toBe('clean')
  })

  it('run11:P2 a conflicting code in the range never resolves to a compound', () => {
    expect(shape('$5 dollar-days to $10 EUR-days').every((s) => s.endsWith('|amb'))).toBe(true)
    expect(verdict('$5 to $10 EUR-days', '$5 dollar-days to $10 EUR-days')).not.toBe('untraced')
  })

  it('run11:P2 two amounts that are not a range keep their own currencies', () => {
    expect(shape('$5 dollar-days, $10 CAD-days')).toEqual(['$5 dollar-days|USD|USD-day|ok', '$10 CAD-days|CAD|CAD-day|ok'])
  })

  it('run11:P2 a range with no bare sign is unchanged', () => {
    expect(shape('$5 to $10 CAD-days')).toEqual(['$5|CAD|CAD-day|ok', '$10 CAD-days|CAD|CAD-day|ok'])
    expect(shape('$5 USD-days to $10 USD-days')).toEqual(['$5 USD-days|USD|USD-day|ok', '$10 USD-days|USD|USD-day|ok'])
  })

  it('run11:P2 resolving a currency in a long chain is linear', { timeout: 120_000 }, () => {
    const run = (n: number): (() => void) => {
      const text = '$5 dollar-days to $10 CAD-days, $7 CAD-days to $9 dollar-days. '.repeat(Math.ceil(n / 64))
      return () => {
        expect(extractNumbers(text).length).toBeGreaterThan(0)
      }
    }
    expect(growthRatio(run)).toBeLessThan(GROWTH_LIMIT)
  })
})
