import { describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'
import type { TraceOptions } from '../src/index.js'

// Regression rows from the round 1 audit of the should-fix items (S1 to S9) and the
// triage of the unverified P3 items. Each row names its finding id; each was seen failing
// before its fix.

const vals = (text: string): string[] => extractNumbers(text).map((t) => t.value)
const verdict = (output: string, evidence: Parameters<typeof traceNumbers>[1], options?: TraceOptions): string =>
  traceNumbers(output, evidence, options).verdict

describe('S1 false-pass:F08: a leading decimal point survives punctuation', () => {
  it.each([
    ['x ~.5% y', '0.5'],
    ['x ≈.5', '0.5'],
    ['#.5', '0.5'],
    ['“.5”', '0.5'],
    ['x |.99', '0.99'],
    ['x _.5_ y', '0.5'],
    ['x `.5` y', '0.5'],
    ['x ,.5 y', '0.5'],
    ['x ≥.5 y', '0.5'],
    ['x ≤.5 y', '0.5'],
    ['x ^.5 y', '0.5'],
    ['x @.5 y', '0.5'],
    ['x &.5 y', '0.5'],
    ['x !.5 y', '0.5'],
    ['x ?.5 y', '0.5'],
    ['x *.5 y', '0.5'],
    ['x ‘.5’ y', '0.5'],
    ['x ~.99 y', '0.99'],
  ])('%s reads %s', (text, value) => {
    expect(vals(text)).toEqual([value])
  })

  it('a growth figure of ~.5% never traces to 5%', () => {
    expect(verdict('Growth was ~.5% last year', 'Growth was 5% last year')).toBe('untraced')
    expect(verdict('Growth was ~.5% last year', 'Growth was 0.5% last year')).toBe('clean')
  })

  it('a decimal comma after a symbol keeps its mark, as a locale guess under en-US', () => {
    expect(vals('x ~,5% y')).toEqual(['0.5'])
    expect(extractNumbers('x ~,5% y', { locale: 'de-DE' })[0]).toMatchObject({ value: '0.5', ambiguous: false })
    expect(verdict('Growth was ~,5%', 'Growth was 5%', { locale: 'de-DE' })).toBe('untraced')
    expect(vals('item,5')).toEqual(['5'])
  })

  it('after a letter, a digit or another point the point still belongs to the sentence', () => {
    expect(vals('item.5')).toEqual(['5'])
    expect(vals('5%.5')).toEqual(['5', '5'])
    expect(vals('wait...5 left')).toEqual(['5'])
  })
})

describe('S2 field:F2: clock times are read as minutes of the day', () => {
  const clean = (o: string, e: string): void => expect(verdict(o, e), `${o} | ${e}`).toBe('clean')
  const untraced = (o: string, e: string): void => expect(verdict(o, e), `${o} | ${e}`).toBe('untraced')

  it('S2 field:F2 the same time written in 12-hour and 24-hour form traces', () => {
    clean('6pm', '18:0')
    clean('9:00 AM', '9:0')
    clean('Open 9:00 AM to 6:00 PM', '09:00-18:00')
    clean('Open 9:00 AM to 6:00 PM', '{"hours": "9:0-18:0"}')
    clean('18:30', '6:30 PM')
    clean('6:30 p.m.', '18:30')
    clean('12 AM', '00:00')
    clean('12 PM', '12:00')
    clean('12:30 AM', '0:30')
    clean('noon at 12:00 PM', '12:00')
    clean('5 PM', '5pm')
    clean('5:00 PM', '17:00')
  })

  it('S2 field:F2 a different time is untraced, even when its numbers appear elsewhere', () => {
    untraced('5pm', '17:30')
    untraced('10:30 pm', 'Rooms 10 and 30 are 22 steps apart')
    untraced('10:30 pm', 'Open 10:30 am')
    untraced('9:00 PM', '09:00-18:00')
    untraced('6am', '18:00')
    untraced('12 AM', '12:00 PM')
  })

  it('S2 field:F2 a time written without am or pm may be either, so a link only through the other reading is unknown', () => {
    const r = traceNumbers('Doors at 10:30.', 'Show starts at 10:30 PM.')
    expect(r.verdict).toBe('unknown')
    expect(r.numbers[0]).toMatchObject({ status: 'unknown', reason: 'ambiguous-reading' })
    expect(verdict('Doors at 10:30 PM.', 'Show starts at 10:30.')).toBe('unknown')
    clean('Doors at 10:30.', 'Show starts at 10:30.')
    clean('Doors at 10:30 AM.', 'Show starts at 10:30.')
    // 24-hour forms and a leading zero are not ambiguous.
    expect(extractNumbers('18:30 and 09:00 and 0:30')).toMatchObject([
      { kind: 'time', value: '1110', ambiguous: false },
      { kind: 'time', value: '540', ambiguous: false },
      { kind: 'time', value: '30', ambiguous: false },
    ])
    expect(extractNumbers('9:00')[0]).toMatchObject({ kind: 'time', value: '540', ambiguous: true, ambiguity: 'meridiem', alternates: [{ value: '1260' }] })
  })

  it('S2 field:F2 times are minutes since midnight, whatever the spelling', () => {
    const v = (s: string): string[] => extractNumbers(s).map((t) => `${t.kind}:${t.value}`)
    expect(v('6pm')).toEqual(['time:1080'])
    expect(v('6:00 PM')).toEqual(['time:1080'])
    expect(v('12 am')).toEqual(['time:0'])
    expect(v('12:15 pm')).toEqual(['time:735'])
    expect(v('11:59 pm')).toEqual(['time:1439'])
    expect(v('18:0')).toEqual(['time:1080'])
    expect(extractNumbers('5 p.m.')[0]).toMatchObject({ kind: 'time', unit: 'pm', raw: '5 p.m.' })
  })

  it('S2 field:F2 a range of hours takes the meridiem from its end and flips the start when it must', () => {
    const v = (s: string): string[] => extractNumbers(s).map((t) => `${t.raw}:${t.value}`)
    expect(v('5-6pm')).toEqual(['5:1020', '6pm:1080'])
    expect(v('9-5pm')).toEqual(['9:540', '5pm:1020'])
    expect(v('11-1pm')).toEqual(['11:660', '1pm:780'])
    expect(v('12-2pm')).toEqual(['12:720', '2pm:840'])
    expect(v('6am to 6:30pm')).toEqual(['6am:360', '6:30pm:1110'])
    expect(v('9-5:30pm')).toEqual(['9:540', '5:30pm:1050'])
    clean('Open 9-5pm', 'Open 9am to 5pm')
    clean('from 6am to 6:30pm', 'Mon 6:0-18:30')
  })

  it('S2 field:F2 a time with seconds still traces by its parts, with the new reason when it does not', () => {
    clean('at 14:05', 'closed at 14:05:30')
    const r = traceNumbers('at 14:06:30', 'closed at 14:05:30')
    expect(r.verdict).not.toBe('clean')
    for (const n of r.numbers) if (n.status === 'unknown') expect(n.reason).toBe('time-not-in-evidence')
    clean('at 8:30:15 PM', 'at 20:30:15')
    expect(verdict('at 8:30:15 PM', 'at 8:30:15 AM')).not.toBe('clean')
  })

  it('S2 field:F2 a time is read, never computed, and a bare number still does not clear 5pm', () => {
    expect(verdict('Open until 5pm.', 'Ask about 3 and 2.', { preset: 'report' })).toBe('untraced')
    const r = traceNumbers('Open until 5pm.', '{"review_stars": 5.0}')
    expect(r.numbers[0]).toMatchObject({ status: 'unknown', reason: 'unit-unverified' })
    expect(verdict('at 17:00', 'We have 17 and 0 items')).toBe('untraced')
  })
})

describe('S3 false-pass:F15: ignoreStructure skips list markers, citation numbers and step labels', () => {
  const list = '1. **Revenue:** $48.2 million.\n2. **Cash:** $19.5 million.'
  const evidence = 'Revenue $48.2 million. Cash $19.5 million.'

  it('S3 false-pass:F15 a numbered answer is untraced by default and clean with ignoreStructure', () => {
    expect(verdict(list, evidence)).toBe('untraced')
    const r = traceNumbers(list, evidence, { ignoreStructure: true })
    expect(r.verdict).toBe('clean')
    expect(r.numbers.filter((n) => n.status === 'ignored').map((n) => [n.token.raw, n.reason])).toEqual([['1', 'structure'], ['2', 'structure']])
  })

  it('S3 false-pass:F15 the first marker of the text and the bullet forms are covered', () => {
    expect(verdict('1. Revenue $5 million.', 'Revenue $5 million.', { ignoreStructure: true })).toBe('clean')
    expect(verdict('Summary:\n  - 2) Revenue $5 million.\n* 3. Cash $5 million.', 'Revenue $5 million. Cash $5 million.', { ignoreStructure: true })).toBe('clean')
    expect(verdict('1) Revenue $5 million.\r\n2) Cash $5 million.', 'Revenue $5 million. Cash $5 million.', { ignoreStructure: true })).toBe('clean')
  })

  it('S3 false-pass:F15 bracket citations and Step, Passage, Figure, Option, Question, Section labels', () => {
    const o = { ignoreStructure: true }
    expect(verdict('Revenue was $5 million [3].', 'Revenue $5 million.', o)).toBe('clean')
    expect(verdict('Revenue was $5 million [1, 2].', 'Revenue $5 million.', o)).toBe('clean')
    expect(verdict('Revenue was $5 million [1-3].', 'Revenue $5 million.', o)).toBe('clean')
    for (const label of ['Step 4', 'Passage 12', 'Figure 2', 'Option 3', 'Question 7', 'Section 5', 'Fig. 2', 'step 4', 'Passages 2']) {
      expect(verdict(`In ${label}, revenue was $5 million.`, 'Revenue $5 million.', o), label).toBe('clean')
    }
  })

  it('S3 false-pass:F15 a real small count is still checked', () => {
    const o = { ignoreStructure: true }
    expect(verdict('We have 7 offices.', 'We have 9 offices.', o)).toBe('untraced')
    expect(verdict('1. We have 7 offices.', '1 office. We have 9 offices.', o)).toBe('untraced')
    expect(verdict('7. offices were closed', 'We have 9 offices.', o)).toBe('clean')
    expect(verdict('Revenue grew [5 apples] and 7 offices.', 'x 5 apples', o)).toBe('untraced')
    // A sum of three digits is a count, a four-digit year-like or longer number is not a marker.
    expect(verdict('2026. Revenue was $5 million.', 'Revenue $5 million.', o)).toBe('untraced')
    // A legal section citation is a claim: an invented "Section 50(1)" must not pass (RAGTruth RT-12765).
    expect(verdict('Under Section 50(1) of the Act.', 'Under Section 12(2) of the Act.', o)).toBe('untraced')
    expect(verdict('Option 3 costs 3 dollars.', 'Option 3 costs 4 dollars.', o)).toBe('untraced')
  })

  it('S3 false-pass:F15 it is off by default, and ignoreSmallIntegersUpTo still hides a wrong small count', () => {
    expect(verdict('We have 7 offices.', 'We have 9 offices.', { ignoreSmallIntegersUpTo: 10 })).toBe('clean')
    expect(verdict('1. Revenue $5 million.', 'Revenue $5 million.')).toBe('untraced')
    expect(() => traceNumbers('1', '1', { ignoreStructure: 'yes' as unknown as boolean })).toThrow(TypeError)
  })

  it('S3 false-pass:F15 caller tokens carry no text, so nothing is skipped', () => {
    const toks = extractNumbers('1. Revenue $5 million.')
    expect(traceNumbers(toks, 'Revenue $5 million.', { ignoreStructure: true }).verdict).toBe('untraced')
  })
})
