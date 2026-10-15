import { describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'
import type { TraceOptions } from '../src/index.js'

// Regression rows from the release-gate review of 0.1.0 (head 464d7ec). Each row names its finding id
// (gate-review, gate-false-pass or gate-hostile) and was seen failing before its fix.

type Evidence = Parameters<typeof traceNumbers>[1]
const verdict = (output: string, evidence: Evidence, options?: TraceOptions): string => traceNumbers(output, evidence, options).verdict
const trace = (output: string, evidence: Evidence, options?: TraceOptions): ReturnType<typeof traceNumbers> =>
  traceNumbers(output, evidence, options)

describe('gate-review:F01 and gate-hostile:G06 a parenthesized negative against positive evidence', () => {
  it('gate-review:F01 ($5.2 million) against $5.2 million is not clean', () => {
    const r = trace('Net loss was ($5.2 million).', 'Net income was $5.2 million.')
    expect(r.verdict).toBe('unknown')
    expect(r.numbers[0]).toMatchObject({ status: 'unknown', reason: 'sign-differs' })
  })

  it.each([
    ['Net loss was ($5.2 million).', 'Net income was $5.2 million.'],
    ['Net income was ($500).', 'Net income was $500.'],
    ['Net income was ($1,234.00).', 'Net income was $1,234.00.'],
    ['Count (1,234) here', 'Count 1,234 here'],
    ['Growth (12.5%) here', 'Growth 12.5% here'],
  ])('gate-review:F01 gate-hostile:G06 %s is not clean against %s', (output, evidence) => {
    expect(verdict(output, evidence)).not.toBe('clean')
    expect(verdict(output, evidence, { signMode: 'strict' })).not.toBe('clean')
  })

  it('gate-hostile:G06 -$500 stays untraced, and the same written negative still traces', () => {
    expect(verdict('Net income was -$500.', 'Net income was $500.')).toBe('untraced')
    expect(verdict('Net income was ($500).', 'Net income was ($500).')).toBe('clean')
    expect(verdict('Net income was ($500).', 'Net income was -$500.')).toBe('clean')
    expect(verdict('Net income was -$500.', 'Net income was ($500).')).toBe('clean')
  })

  it('gate-review:F01 the reverse (a dropped sign) keeps its documented pass and mark', () => {
    const r = trace('Net income was $500.', 'Net income was ($500).')
    expect(r.verdict).toBe('clean')
    expect(r.counts.signDiffers).toBe(1)
  })

  it('gate-review:F01 magnitude mode ignores the sign, and a derived number is held the same way', () => {
    expect(verdict('Net loss was ($500).', 'Net income was $500.', { signMode: 'magnitude' })).toBe('clean')
    const r = trace('Total was ($500).', 'Items cost $100 and $400.', { derivations: ['sum'] })
    expect(r.numbers[0]).toMatchObject({ status: 'unknown', reason: 'sign-differs' })
    expect(trace('Total was $500.', 'Items cost $100 and $400.', { derivations: ['sum'] }).numbers[0]?.status).toBe('derived')
  })

  it('gate-review:F19 a parenthetical figure is read as a possible negative and never passes silently', () => {
    expect(verdict('Growth was strong (12.5%).', 'Growth was 12.5%.')).toBe('unknown')
  })
})

describe('gate-false-pass:G5-F01 a space other than ASCII or U+00A0 between a number and its word', () => {
  // Every horizontal space the platform or a typesetter can print, plus the invisible characters that sit where a space would.
  const gaps: [string, string][] = [
    ['U+202F narrow no-break', ' '], ['U+2009 thin', ' '], ['U+2002 en', ' '], ['U+2003 em', ' '],
    ['U+2007 figure', ' '], ['U+200A hair', ' '], ['U+205F medium math', ' '], ['U+2008 punctuation', ' '],
    ['U+1680 ogham', ' '], ['TAB', '\t'], ['U+200B zero width space', '​'], ['U+00AD soft hyphen', '­'],
    ['U+3000 ideographic', '　'], ['U+00A0 no-break', ' '],
  ]

  it.each(gaps)('gate-false-pass:G5-F01 wrong AM/PM, scale and percent never pass clean with %s', (_name, sp) => {
    expect(verdict(`Doors open at 9:00${sp}PM.`, 'Doors open at 9:00 AM.')).toBe('untraced')
    expect(verdict(`Revenue was $5.2${sp}billion.`, 'Revenue was $5.2.')).toBe('untraced')
    expect(verdict(`Churn was 12${sp}%.`, 'Churn was 12.')).not.toBe('clean')
    expect(verdict(`The dose is 5${sp}kg.`, 'The dose is 5 g.')).toBe('untraced')
  })

  it.each(gaps)('gate-false-pass:G5-F01 the honest form with %s traces to the ASCII-space spelling', (_name, sp) => {
    expect(verdict(`Churn was 12${sp}%.`, 'Churn was 12%.')).toBe('clean')
    expect(verdict(`Revenue was $5.2${sp}billion.`, 'Revenue was $5.2 billion.')).toBe('clean')
    expect(verdict(`The dose is 5${sp}kg.`, 'The dose is 5 kg.')).toBe('clean')
    expect(verdict(`Doors open at 6${sp}PM.`, 'Doors open at 6 PM.')).toBe('clean')
    expect(verdict(`Doors open at 9:00${sp}PM.`, 'Doors open at 9:00 PM.')).toBe('clean')
  })

  it('gate-false-pass:G5-F01 a line break still ends a number (a list of "5" then "Units" is not 5 units)', () => {
    expect(extractNumbers('Count: 5\nUnits: 3').map((t) => t.unit)).toEqual([undefined, undefined])
  })

  it('gate-false-pass:G5-F01 grouping is unchanged: a thin or narrow space groups digits, a tab or an en space does not', () => {
    expect(extractNumbers('1 234', { locale: 'en-US' }).map((t) => t.value)).toEqual(['1234'])
    expect(extractNumbers('1\t234', { locale: 'fr-FR' }).map((t) => t.value)).toEqual(['1', '234'])
  })
})
