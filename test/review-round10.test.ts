import { describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'
import type { TraceOptions } from '../src/index.js'

// Regression rows from the 0.1.0 readiness review (head b1173f8). Each row names its finding and was seen failing
// before its fix.

type Evidence = Parameters<typeof traceNumbers>[1]
type Output = Parameters<typeof traceNumbers>[0]
const trace = (output: Output, evidence: Evidence, options?: TraceOptions): ReturnType<typeof traceNumbers> =>
  traceNumbers(output, evidence, options)

describe('readiness-review:evidence-aside a percent in parentheses after a word is a label, not an accounting negative', () => {
  const invoiceEvidence = [
    { id: 'last-quarter', text: 'Last quarter the total was $1,000.00.' },
    { id: 'invoice-17', text: 'Subtotal $1,200.00. Tax (8.25%) $99.00. Total due $1,299.00.' },
  ]
  const invoiceOutput =
    'The invoice total is $1,299.00, which includes 8.3% tax and is up 30% from last quarter. Payment is due in 45 days.'

  it('readiness-review:evidence-aside the README invoice example has no signDiffers', () => {
    const r = trace(invoiceOutput, invoiceEvidence, { derivations: ['percent-change'] })
    expect(r.verdict).toBe('untraced')
    expect(r.numbers.map((n) => n.status)).toEqual(['traced', 'rounded', 'derived', 'untraced'])
    expect(r.counts.signDiffers).toBe(0)
    expect(r.numbers.filter((n) => n.signDiffers === true)).toEqual([])
  })

  it.each([
    ['Tax is 8.25% here.', 'Subtotal $1,200.00. Tax (8.25%) $99.00.'],
    ['Gross margin was 12%.', 'Gross margin (12%) for the year.'],
    ['Churn was 3.5%.', 'Customer churn (3.5%) rose.'],
    ['It is 12.5% of the total.', 'Revenue $5 million (12.5%) up.'],
  ])('readiness-review:evidence-aside %s traces to %s with no signDiffers, in strict mode too', (output, evidence) => {
    for (const signMode of ['explicit', 'strict'] as const) {
      const r = trace(output, evidence, { signMode })
      expect(r.verdict, signMode).toBe('clean')
      expect(r.counts.signDiffers, signMode).toBe(0)
    }
  })

  it.each([
    ['The tax rate is -8.25%.', 'Subtotal $1,200.00. Tax (8.25%) $99.00.'],
    ['Gross margin was -12%.', 'Gross margin (12%) for the year.'],
  ])('readiness-review:evidence-aside an invented sign is not clean: %s against %s', (output, evidence) => {
    const r = trace(output, evidence)
    expect(r.verdict).not.toBe('clean')
    expect(r.numbers[0]?.status).not.toBe('traced')
    expect(r.numbers[0]?.status).not.toBe('rounded')
  })

  it('readiness-review:evidence-aside the other reading is unknown, not a false fail: the label may hide a negative', () => {
    const r = trace('The tax rate is -8.25%.', 'Tax (8.25%) $99.00.')
    expect(r.numbers[0]).toMatchObject({ status: 'unknown', reason: 'ambiguous-reading' })
  })

  it.each([
    ['Net loss was -$500.', 'Net loss was ($500).'],
    ['Change was -1,234.', 'Change (1,234).'],
    ['Net margin was -12%.', 'Net margin was (12%).'],
    ['Net margin was -12.5%.', 'Net margin: (12.5%).'],
  ])('readiness-review:evidence-aside a true accounting negative still answers to its sign: %s against %s', (output, evidence) => {
    expect(trace(output, evidence).verdict).toBe('clean')
  })

  it.each([
    ['Loss was $500.', 'Net loss was ($500).'],
    ['Count was 1,234.', 'Count (1,234).'],
    ['Margin was 12%.', 'Net margin was (12%).'],
    ['Margin was 12.5%.', 'Net margin: (12.5%).'],
  ])('readiness-review:evidence-aside an unsigned figure against a real negative is still marked signDiffers: %s against %s', (output, evidence) => {
    const r = trace(output, evidence)
    expect(r.counts.signDiffers).toBe(1)
  })

  it.each([
    ['Tax is 8.25%.', 'Tax \uff08\uff18.25%\uff09 due'],
    ['Margin is 12%.', 'Caf\u00e9 margin (12%) up'],
    ['Margin is 12%.', 'Gross margin (12 %) up'],
  ])('readiness-review:evidence-aside full-width, accented and spaced forms read the same: %s against %s', (output, evidence) => {
    const r = trace(output, evidence)
    expect(r.verdict).toBe('clean')
    expect(r.counts.signDiffers).toBe(0)
  })

  it('readiness-review:evidence-aside evidence handed in as extracted tokens keeps its documented rule: a parenthesized negative is always held', () => {
    const tokens = extractNumbers('Tax (8.25%) $99.00.')
    const r = trace('Tax is 8.25%.', tokens)
    expect(r.counts.signDiffers).toBe(1)
  })

  it('readiness-review:evidence-aside parenthesesAreNegative: false reads every parenthesis as plain text', () => {
    const r = trace('Tax is 8.25%.', 'Tax (8.25%) $99.00.', { parenthesesAreNegative: false })
    expect(r.verdict).toBe('clean')
    expect(r.counts.signDiffers).toBe(0)
  })
})
