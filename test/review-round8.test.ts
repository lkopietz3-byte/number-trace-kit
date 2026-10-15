import { describe, expect, it } from 'vitest'
import { extractNumbers, reconcile, reconcileComponents, traceNumbers } from '../src/index.js'
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

describe('S4 field:F5: the evidence scale reaches currency-tagged cells when asked', () => {
  const doc = (text: string, extra: Record<string, unknown> = {}): { id: string; text: string } => ({
    id: 'cf', text, scale: 'million', currency: 'USD', ...extra,
  }) as { id: string; text: string }
  const table = 'Capital expenditures | $ 1,577 | 1,400\nDepreciation | 900 | 800'

  it('S4 field:F5 with scaleApplies the first-row and total cells with a $ are scaled like the bare ones', () => {
    for (const cell of ['$ 1,577', '$1,577', '$ (1,577)', '($1,577)']) {
      const evidence = [doc(`Capital expenditures | ${cell} | 1,400\nDepreciation | 900 | 800`, { scaleApplies: 'bare-and-currency' })]
      expect(verdict('Capital expenditures were $1,577 million.', evidence), cell).toBe('clean')
      expect(verdict('Depreciation was $900 million.', evidence), cell).toBe('clean')
      expect(verdict('Capital expenditures were $1,578 million.', evidence), cell).toBe('untraced')
    }
  })

  it('S4 field:F5 by default only bare cells are scaled, as before', () => {
    expect(verdict('Capital expenditures were $1,577 million.', [doc(table)])).toBe('untraced')
    expect(verdict('Depreciation was $900 million.', [doc(table)])).toBe('clean')
    expect(verdict('Capital expenditures were $1,577 million.', [doc(table, { scaleApplies: 'bare' })])).toBe('untraced')
  })

  it('S4 field:F5 a cell that already has a magnitude, a percent or a unit is never rescaled', () => {
    const evidence = [doc('Debt | $1.5 billion | 12.5% | 30 days', { scaleApplies: 'bare-and-currency' })]
    expect(verdict('Debt was $1.5 billion.', evidence)).toBe('clean')
    expect(verdict('Debt was $1,500 trillion.', evidence)).toBe('untraced')
    expect(verdict('Margin was 12.5%.', evidence)).toBe('clean')
  })

  it('S4 field:F5 string evidence takes evidenceScaleApplies, and a bad value is a RangeError', () => {
    expect(verdict('Capex was $1,577 million.', 'Capex | $ 1,577', { evidenceScale: 'million', evidenceCurrency: 'USD', evidenceScaleApplies: 'bare-and-currency' })).toBe('clean')
    expect(verdict('Capex was $1,577 million.', 'Capex | $ 1,577', { evidenceScale: 'million', evidenceCurrency: 'USD' })).toBe('untraced')
    expect(() => traceNumbers('1', [doc('1', { scaleApplies: 'all' })])).toThrow(RangeError)
    expect(() => traceNumbers('1', '1', { evidenceScaleApplies: 'all' as unknown as 'bare' })).toThrow(RangeError)
  })

  it('S4 field:F5 a euro cell in a table of millions is scaled too, and stays euros', () => {
    const evidence = [doc('Revenue | €5,200', { scaleApplies: 'bare-and-currency' })]
    expect(verdict('Revenue was €5,200 million.', evidence)).toBe('clean')
    expect(verdict('Revenue was $5,200 million.', evidence)).toBe('untraced')
  })
})

describe('S7 false-pass:F07: whole-date checks beyond English month names', () => {
  const tr = (o: string, e: string, locale?: string): string => verdict(o, e, locale === undefined ? undefined : { locale })
  const dates = (text: string, locale?: string): string[] =>
    extractNumbers(text, locale === undefined ? undefined : { locale }).map((t) => `${t.part ?? t.kind}:${t.value}`)

  it('S7 false-pass:F07 a wrong day does not trace to an unrelated number', () => {
    expect(tr('Le 5 mars 2026', 'Déposé le 4 mars 2026 et 5 jours', 'fr-FR')).toBe('untraced')
    expect(tr('Am 5. März 2026', 'Eingereicht am 4. März 2026. Frist: 5 Tage.', 'de-DE')).toBe('untraced')
    expect(tr('Due 8-Jun-2026.', 'Due 7-Jun-2026. Net 8 days.')).toBe('untraced')
    expect(tr('El 5 de marzo de 2026', 'Presentado el 4 de marzo de 2026 y 5 días', 'es-ES')).toBe('untraced')
    expect(tr('Il 5 marzo 2026', 'Depositato il 4 marzo 2026 e 5 giorni', 'it-IT')).toBe('untraced')
    expect(tr('Em 5 de março de 2026', 'Em 4 de março de 2026 e 5 dias', 'pt-PT')).toBe('untraced')
    expect(tr('Op 5 maart 2026', 'Op 4 maart 2026 en 5 dagen', 'nl-NL')).toBe('untraced')
    expect(tr('Den 5 mars 2026', 'Den 4 mars 2026 och 5 dagar', 'sv-SE')).toBe('untraced')
  })

  it('S7 false-pass:F07 the same date written another way is clean', () => {
    expect(tr('2026年3月4日', 'Filed 2026-03-04')).toBe('clean')
    expect(tr('2026年3月4日に提出', 'Filed 2026-03-04', 'ja-JP')).toBe('clean')
    expect(tr('2026년 3월 4일', 'Filed 2026-03-04', 'ko-KR')).toBe('clean')
    expect(tr('Le 4 mars 2026', '2026-03-04', 'fr-FR')).toBe('clean')
    expect(tr('Le 4 mars 2026', '2026-03-04')).toBe('clean')
    expect(tr('Am 4. März 2026', '2026-03-04', 'de-DE')).toBe('clean')
    expect(tr('El 4 de marzo de 2026', '2026-03-04', 'es-ES')).toBe('clean')
    expect(tr('El 4 de marzo del 2026', '2026-03-04', 'es-ES')).toBe('clean')
    expect(tr('Em 4 de março de 2026', 'March 4, 2026', 'pt-BR')).toBe('clean')
    expect(tr('4 maart 2026', '4 March 2026', 'nl-NL')).toBe('clean')
    expect(tr('Due 8-Jun-2026.', 'Due June 8, 2026.')).toBe('clean')
    expect(tr('Due Jun-08-2026.', 'Due 2026-06-08.')).toBe('clean')
    expect(tr('Due 08-JUN-2026.', 'Due 2026-06-08.')).toBe('clean')
    expect(tr('Le 1er mars 2026', '2026-03-01', 'fr-FR')).toBe('clean')
    expect(tr('Le 4 févr. 2026', '2026-02-04', 'fr-FR')).toBe('clean')
    expect(tr('März 2026', '2026-03-04', 'de-DE')).toBe('clean')
    expect(tr('im Mai 2026', 'Mai 2026', 'de-DE')).toBe('clean')
  })

  it('S7 false-pass:F07 the roles of each part are read', () => {
    expect(dates('Le 5 mars 2026', 'fr-FR')).toEqual(['day:5', 'month:3', 'year:2026'])
    expect(dates('Am 5. März 2026', 'de-DE')).toEqual(['day:5', 'month:3', 'year:2026'])
    expect(dates('5 de marzo de 2026', 'es-ES')).toEqual(['day:5', 'month:3', 'year:2026'])
    expect(dates('Due 8-Jun-2026')).toEqual(['day:8', 'month:6', 'year:2026'])
    expect(dates('Jun-08-2026')).toEqual(['month:6', 'day:8', 'year:2026'])
    expect(dates('2026年3月4日')).toEqual(['year:2026', 'month:3', 'day:4'])
    expect(dates('3月4日')).toEqual(['month:3', 'day:4'])
    expect(dates('2026年3月')).toEqual(['year:2026', 'month:3'])
    // NFD spelling of an accented month is the same month.
    expect(dates('5 février 2026', 'fr-FR')).toEqual(['day:5', 'month:2', 'year:2026'])
  })

  it('S7 false-pass:F07 an honest number next to a month word that is not a month is untouched', () => {
    expect(dates('5 mm of rain, 12 marbles, 2026 votes')).toEqual(['count:5', 'count:12', 'year:2026'])
    expect(dates('Take 5 may 2026 stay')).toEqual(['count:5', 'year:2026'])
    // Mars, the planet; Mayo, the clinic: capitalized, these are months only in a locale that has a table.
    expect(dates('The Mars 2020 rover')).toEqual(['year:2020'])
    expect(dates('Mars 2020', 'fr-FR')).toEqual(['month:3', 'year:2020'])
    expect(dates('5 mars 2026')).toEqual(['day:5', 'month:3', 'year:2026'])
  })

  it('S7 false-pass:F07 a month word with a dot is needed for a non-English abbreviation', () => {
    expect(dates('5 sept. 2026')).toEqual(['day:5', 'month:9', 'year:2026'])
    expect(dates('5 sept 2026')).toEqual(['count:5', 'year:2026'])
  })

  it('S7 false-pass:F07 a locale without a month table cannot read a worded date, so its parts are unknown', () => {
    const r = traceNumbers('5 марта 2026 г.', 'Подано 4 марта 2026 и 5 дней', { locale: 'ru-RU' })
    expect(r.verdict).toBe('unknown')
    expect(r.numbers.map((n) => `${n.token.raw}:${n.status}:${n.reason ?? ''}`)).toEqual(['5:unknown:unread-date', '2026:unknown:unread-date'])
    // The same phrase written the same way in the evidence still traces.
    expect(traceNumbers('Срок: 5 марта 2026', 'Подано 5 марта 2026', { locale: 'ru-RU' }).verdict).toBe('clean')
    // A table language, English and the East Asian locales are not affected.
    expect(traceNumbers('Il 5 marzo 2026', 'Il 5 marzo 2026', { locale: 'it-IT' }).verdict).toBe('clean')
    expect(extractNumbers('5 items 2026', { locale: 'en-US' }).map((t) => t.ambiguous)).toEqual([false, false])
    expect(extractNumbers('5 items 2026', { locale: 'ru-RU' }).map((t) => t.ambiguity)).toEqual(['date', 'date'])
    expect(extractNumbers('5 Mrz 2026', { locale: 'ja-JP' }).map((t) => t.ambiguous)).toEqual([false, false])
  })
})

describe('S8 false-pass:F12: a leading en dash may be a minus, and +/- is a tolerance', () => {
  const rows = (text: string): string[] => extractNumbers(text).map((t) => `${t.raw}=${t.value}${t.ambiguity === undefined ? '' : `/${t.ambiguity}`}`)

  it('S8 false-pass:F12 an en dash glued to a number is an ambiguous sign, never a silent positive', () => {
    const r = traceNumbers('Change –3.2%', 'Change 3.2%')
    expect(r.verdict).toBe('unknown')
    expect(r.numbers[0]).toMatchObject({ status: 'unknown', reason: 'ambiguous-sign' })
    expect(verdict('Change –3.2%', 'Change -3.2%')).toBe('unknown')
    expect(verdict('Change –3.2%', 'Change −3.2%')).toBe('unknown')
    expect(verdict('Change –3.2%', 'Change 7.9%')).toBe('untraced')
    // The same text copied from the source is not a guess.
    expect(verdict('Change –3.2%', 'Change –3.2%')).toBe('clean')
    expect(verdict('(–3.2%)', '(–3.2%)')).toBe('clean')
    expect(extractNumbers('Change –3.2%')[0]).toMatchObject({ raw: '–3.2%', value: '3.2', ambiguous: true, ambiguity: 'sign', alternates: [{ value: '-3.2' }] })
  })

  it('S8 false-pass:F12 a range with an en dash is unchanged', () => {
    expect(rows('5–8%')).toEqual(['5=5', '8%=8'])
    expect(rows('5 – 8%')).toEqual(['5=5', '8%=8'])
    expect(rows('10–12 kg')).toEqual(['10=10', '12 kg=12'])
    expect(rows('$5–$8')).toEqual(['$5=5', '$8=8'])
    expect(rows('Oct 5–7')).toEqual(['Oct=10', '5=5', '7=7'])
    expect(rows('-5–-3%')).toEqual(['-5=-5', '-3%=-3'])
    expect(verdict('Growth of 5–8%.', 'Growth of 5% to 8%.')).toBe('clean')
  })

  it('S8 false-pass:F12 other dashes keep their meaning', () => {
    expect(rows('Change -3.2%')).toEqual(['-3.2%=-3.2'])
    expect(rows('Change −3.2%')).toEqual(['−3.2%=-3.2'])
    expect(rows('Change ‑3.2%')).toEqual(['‑3.2%=-3.2'])
    expect(rows('Change —3.2%')).toEqual(['3.2%=3.2'])
    expect(rows('item–5')).toEqual(['5=5'])
  })

  it('S8 false-pass:F12 +/- and +- are read like ±', () => {
    expect(rows('Accuracy is ±5%')).toEqual(['5%=5'])
    expect(rows('Accuracy is +/-5%')).toEqual(['5%=5'])
    expect(rows('Accuracy is +-5%')).toEqual(['5%=5'])
    expect(rows('Accuracy is +/−5%')).toEqual(['5%=5'])
    expect(rows('Accuracy is +/–5%')).toEqual(['5%=5'])
    expect(verdict('Accuracy is ±5%', 'Accuracy is +/-5%')).toBe('clean')
    expect(verdict('Accuracy is +/-5%', 'Accuracy is 5%')).toBe('clean')
    expect(verdict('Accuracy is +/-5%', 'Accuracy is 6%')).toBe('untraced')
    // A plain minus after a plus elsewhere is still a minus.
    expect(rows('+5 and -5')).toEqual(['+5=5', '-5=-5'])
  })
})

describe('S9 docs-release:F1 docs-release:F2 hostile:F7 hostile:F10: error messages and locale tags', () => {
  it('S9 docs-release:F1 an array of strings as evidence says how to fix it', () => {
    expect(() => traceNumbers('5', ['5'] as never)).toThrow(TypeError)
    expect(() => traceNumbers('5', ['5'] as never)).toThrow(/evidence\[0\] must be a \{ id, text \} object or a number token, got string\. Wrap each string as \{ id, text \}, or join the strings into one string\./)
    expect(() => traceNumbers('5', [5] as never)).toThrow(/evidence\[0\] must be a \{ id, text \} object or a number token, got number\./)
  })

  it('S9 docs-release:F2 a wrong type for evidence or output says what is valid', () => {
    expect(() => (traceNumbers as (o: string) => unknown)('5')).toThrow('evidence must be a string or an array of { id, text } documents or tokens')
    expect(() => traceNumbers('5', 5 as never)).toThrow('evidence must be a string or an array of { id, text } documents or tokens')
    expect(() => traceNumbers(5 as never, '5')).toThrow('output must be a string or an array of tokens')
    expect(() => traceNumbers({} as never, '5')).toThrow('output must be a string or an array of tokens')
    expect(() => traceNumbers(['5'] as never, '5')).toThrow(/output\[0\] must be a number token, got string/)
  })

  it('S9 hostile:F7 a bare hi locale reads Indian grouping, as the platform prints it', () => {
    expect(extractNumbers('12,34,567.89', { locale: 'hi' }).map((t) => [t.value, t.ambiguous])).toEqual([['1234567.89', false]])
    expect(verdict('Total 12,34,567.89', 'Total 1234567.89', { locale: 'hi' })).toBe('clean')
    expect(verdict('Total 12,34,567.89', 'Total 1234567.89', { locale: 'hi-IN' })).toBe('clean')
    // Western grouping still reads under hi.
    expect(extractNumbers('1,234,567.89', { locale: 'hi' })[0]?.value).toBe('1234567.89')
  })

  it('S9 hostile:F7 numbers as the platform prints them read back exactly, in every region of every supported language', () => {
    const langs = 'de fr es it pt nl ru pl sv da nb nn no fi cs sk sl hr ro hu bg tr id vi el uk sr lt lv et en ja zh ko he th hi ms fil ga cy'.split(' ')
    const regions = ['', 'US', 'GB', 'IN', 'CH', 'LI', 'MX', 'ZA', 'BR', 'PT', 'AT', 'CA', 'AU', 'DE', 'FR', 'ES', 'JP', 'CN', 'TW', 'AE', 'EG', 'BD', 'PK', 'NP', 'LK']
    const numbers = [1234567.89, 1234.5, 12.5, 100000, 0.75, 1234567, 12345678.9, 99999.99, 4321.123]
    let tags = 0
    const bad: string[] = []
    for (const lang of langs) {
      for (const region of regions) {
        const tag = region === '' ? lang : `${lang}-${region}`
        const nf = new Intl.NumberFormat(tag, { maximumFractionDigits: 3 })
        if (!nf.resolvedOptions().locale.toLowerCase().startsWith(lang)) continue
        tags++
        for (const n of numbers) {
          const printed = nf.format(n)
          const toks = extractNumbers(printed, { locale: tag })
          const want = String(n)
          const ok = toks.length === 1 && (toks[0]?.value === want || (toks[0]?.alternates ?? []).some((a) => a.value === want))
          if (!ok) bad.push(`${tag}: ${printed} -> ${toks.map((t) => t.value).join('|')}`)
        }
      }
    }
    expect(tags).toBeGreaterThan(500)
    expect(bad.slice(0, 5)).toEqual([])
  })

  it('S9 hostile:F10 a BCP 47 tag with a -u- extension is accepted, and another extension says why it is not', () => {
    for (const tag of ['en-US-u-nu-latn', 'ja-JP-u-ca-japanese', 'en-US-u-hc-h12', 'de-u-nu-arab', 'hi-IN-u-nu-deva', 'fr_FR']) {
      expect(() => extractNumbers('1', { locale: tag }), tag).not.toThrow()
    }
    // The extension keywords are not read as a region: nu is not a country.
    expect(extractNumbers('1.234,5', { locale: 'de-u-nu-latn' })[0]).toMatchObject({ value: '1234.5', ambiguous: false })
    expect(extractNumbers('1,234.5', { locale: 'en-u-nu-latn' })[0]).toMatchObject({ value: '1234.5', ambiguous: false })
    expect(extractNumbers('1,234.5', { locale: 'en-u-ca-gregory-nu-latn' })[0]).toMatchObject({ value: '1234.5' })
    expect(() => extractNumbers('1', { locale: 'en-US-x-private' })).toThrow(/"x" extension is not supported/)
    expect(() => extractNumbers('1', { locale: 'en-t-fr' })).toThrow(/"t" extension is not supported/)
    expect(() => extractNumbers('1', { locale: 'en-u' })).toThrow(RangeError)
    expect(() => extractNumbers('1', { locale: 'zz-ZZ' })).toThrow(/language "zz" is not supported/)
    expect(() => extractNumbers('1', { locale: 'e' })).toThrow(/not a language tag/)
  })
})

describe('triage false-pass:F18 units, decades and an ordinal day', () => {
  const unitOf = (text: string): string[] => extractNumbers(text).map((t) => `${t.value}:${t.unit ?? ''}`)

  it('false-pass:F18 area and volume units are not length units', () => {
    expect(unitOf('800 m\u00b2')).toEqual(['800:m2'])
    expect(unitOf('800 m2')).toEqual(['800:m2'])
    expect(unitOf('800m2')).toEqual(['800:m2'])
    expect(unitOf('800 ft2 and 3 km\u00b3')).toEqual(['800:ft2', '3:km3'])
    expect(unitOf('5 sqft')).toEqual(['5:ft2'])
    expect(verdict('The lot is 800 m\u00b2.', 'The lot is 800 m.')).toBe('untraced')
    expect(verdict('The lot is 800 m2.', 'The lot is 800 m\u00b2.')).toBe('clean')
    expect(verdict('The lot is 800 ft2.', 'The lot is 800 m2.')).toBe('untraced')
    // A capital is a code, not a unit: M2 chips, A4 paper.
    expect(unitOf('the M2 chip')).toEqual([])
  })

  it('false-pass:F18 ppm, ppb, rpm and similar are units when spaced too', () => {
    expect(verdict('Lead was 10 ppm.', 'Lead was 10 ppb.')).toBe('untraced')
    expect(verdict('Lead was 10 ppm.', 'Lead was 10 ppm.')).toBe('clean')
    expect(verdict('It spins at 60 rpm.', 'It spins at 60 bpm.')).toBe('untraced')
    expect(verdict('It holds 5 gal.', 'It holds 5 gallons.')).toBe('clean')
    expect(verdict('It is 5 yd.', 'It is 5 yards.')).toBe('clean')
    expect(verdict('It is 5 yd.', 'It is 5 m.')).toBe('untraced')
  })

  it('false-pass:F18 a decade is not seconds', () => {
    expect(unitOf('the 1990s')).toEqual(['1990:decade'])
    expect(unitOf('in the 2020s')).toEqual(['2020:decade'])
    expect(unitOf('a 1200s timeout and 90s')).toEqual(['1200:second', '90:second'])
    expect(verdict('Popular in the 1990s.', 'Popular in the 1990s.')).toBe('clean')
    expect(verdict('Popular in the 1990s.', 'Popular in 1990.')).not.toBe('clean')
    expect(verdict('It timed out after 30s.', 'It timed out after 30 seconds.')).toBe('clean')
  })

  it('false-pass:F18 an ordinal day is not untraced when the evidence has that day of a date', () => {
    const r = traceNumbers('Due on the 30th.', 'Due June 30, 2026.')
    expect(r.numbers[0]).toMatchObject({ status: 'unknown', reason: 'ordinal-date' })
    expect(verdict('Due on the 29th.', 'Due June 30, 2026.')).toBe('untraced')
    expect(verdict('Due on the 30th.', 'Due on the 30th.')).toBe('clean')
  })
})

describe('triage false-pass:F14 reconcile reads one currency and the decimal mark you name', () => {
  it('false-pass:F14 rows in two currencies are a TypeError, not a sum', () => {
    expect(() => reconcile({ rows: [{ label: 'a', amount: '\u20ac1,000' }, { label: 'b', amount: '$5' }], total: '1005' })).toThrow(/mix currency signs/)
    expect(() => reconcile({ rows: [{ label: 'a', amount: '\u20ac1,000' }, { label: 'b', amount: '5' }], total: '\u20ac1,005' })).not.toThrow()
    expect(() => reconcile({ rows: [{ label: 'a', amount: '$1,000' }], total: '\u00a31,000' })).toThrow(/mix currency signs/)
    expect(reconcile({ rows: [{ label: 'a', amount: '$1,000' }, { label: 'b', amount: '$5.50' }], total: '$1,005.50' }).ok).toBe(true)
  })

  it('false-pass:F14 decimalMark reads a comma-decimal table as it is printed', () => {
    const rows = [{ label: 'a', amount: '1.500,25' }, { label: 'b', amount: '2.500' }]
    expect(reconcile({ rows, total: '4.000,25' }, { decimalMark: ',' })).toMatchObject({ ok: true, sum: '4000.25' })
    expect(reconcile({ rows: [{ label: 'a', amount: '1,500' }, { label: 'b', amount: '2,500' }], total: '4' }, { decimalMark: ',' })).toMatchObject({ ok: true, sum: '4.000' })
    expect(reconcile({ rows: [{ label: 'a', amount: '\u20ac 1.234,50' }, { label: 'b', amount: '(0,50)' }], total: '1.234,00' }, { decimalMark: ',' }).ok).toBe(true)
    expect(reconcile({ rows: [{ label: 'a', amount: '1 234,50' }], total: '1 234,50' }, { decimalMark: ',' }).ok).toBe(true)
    expect(() => reconcile({ rows: [{ label: 'a', amount: '1,50,0' }], total: '1' }, { decimalMark: ',' })).toThrow(TypeError)
    expect(() => reconcile({ rows: [{ label: 'a', amount: '1,5,5' }], total: '1' }, { decimalMark: ',' })).toThrow(TypeError)
    expect(reconcileComponents({ parts: { a: '1.000,5', b: '0,5' }, total: '1.001' }, { decimalMark: ',' }).ok).toBe(true)
    // The default still reads a comma as a thousands mark, and a lone decimal comma is refused.
    expect(reconcile({ rows: [{ label: 'a', amount: '1,500' }, { label: 'b', amount: '2,500' }], total: '4,000' }).ok).toBe(true)
    expect(() => reconcile({ rows: [{ label: 'a', amount: '1,5' }], total: '1.5' })).toThrow(TypeError)
    expect(() => reconcile({ rows: [{ label: 'a', amount: '1' }], total: '1' }, { decimalMark: ';' as never })).toThrow(RangeError)
  })
})

describe('triage hostile:F8 hostile:F9 docs-release:F4 input checks and messages', () => {
  it('hostile:F8 a typo in an evidence document key is a RangeError, and a missing text says so', () => {
    expect(() => traceNumbers('5', [{ id: 'a', text: 'Sales 5', scael: 'million' } as never])).toThrow(/unknown key "scael", did you mean "scale"\? Known keys: id, text, scale, currency, scaleApplies/)
    expect(() => traceNumbers('5', [{ id: 'a', text: 'Sales 5', currency: 'USD' }])).not.toThrow()
    // Other data on a document (a thenable, a database field) is not a typo.
    expect(() => traceNumbers('5', [{ id: 'a', text: 'Sales 5', source: 'db', then: 1 } as never])).not.toThrow()
    expect(() => traceNumbers('5', [{ id: 'a', text: 'Sales 5', Currency: 'USD' } as never])).toThrow(/did you mean "currency"/)
    expect(() => traceNumbers('5', [{ id: 'a', txt: 'Sales 5' } as never])).toThrow(/evidence\[0\] has an id but no text/)
    expect(() => traceNumbers('5', [{ id: 'a' } as never])).toThrow(/evidence\[0\] has an id but no text/)
  })

  it('hostile:F9 an options bag must be a plain object, not a Map', () => {
    expect(() => traceNumbers('5 and 7', '5', new Map([['preset', 'report']]) as never)).toThrow(/options must be an object, got Map/)
    expect(() => traceNumbers('5', '5', [] as never)).toThrow(/options must be an object, got array/)
    expect(() => extractNumbers('5', new Set() as never)).toThrow(TypeError)
    expect(() => reconcile({ rows: [{ label: 'a', amount: '1' }], total: '1' }, new Map() as never)).toThrow(TypeError)
    expect(() => traceNumbers('5', '5', Object.create(null) as never)).not.toThrow()
  })

  it('hostile:F9 reconcile rows are plain objects with a label and an amount and nothing else', () => {
    expect(() => reconcile({ rows: [['a', '1']] as never, total: '1' })).toThrow(/rows\[0\] must be an object with label and amount, got array/)
    expect(() => reconcile({ rows: [{ label: 'a', amount: '1', amout: '6' } as never], total: '1' })).toThrow(/rows\[0\]: unknown key "amout", did you mean "amount"\? Known keys: label, amount/)
    expect(() => reconcile({ rows: [{ amount: '1' } as never], total: '1' })).toThrow(/rows\[0\].label must be a string/)
    expect(() => reconcile({ rows: [{ label: 1, amount: '1' } as never], total: '1' })).toThrow(/rows\[0\].label must be a string/)
    expect(reconcile({ rows: [{ label: '', amount: '1' }], total: '1' }).ok).toBe(true)
    expect(reconcile({ rows: [{ label: 'a', amount: '1', id: 7, date: '2026-01-01' } as never], total: '1' }).ok).toBe(true)
  })

  it('hostile:F9 messages never run a caller toString and never echo a long caller string', () => {
    let called = false
    const sneaky = { toString(): string { called = true; return 'sum' } }
    expect(() => traceNumbers('5', '5', { derivations: [sneaky] as never })).toThrow(RangeError)
    expect(called).toBe(false)
    expect(() => traceNumbers('5', '5', { derivations: [Object.create(null)] as never })).toThrow(RangeError)
    for (const bad of [() => traceNumbers('5', '5', { derivations: ['x'.repeat(100_000)] as never }), () => traceNumbers('5', '5', { ignoreKinds: ['y'.repeat(100_000)] as never }), () => traceNumbers('5', '5', { locale: 'z'.repeat(100_000) }), () => traceNumbers('5', '5', { preset: 'p'.repeat(100_000) as never })]) {
      try {
        bad()
        throw new Error('did not throw')
      } catch (e) {
        expect((e as Error).message.length).toBeLessThan(300)
      }
    }
  })

  it('docs-release:F4 evidence ids need not be unique: a result cites the id of the document it matched', () => {
    const r = traceNumbers('5', [{ id: 'a', text: '5' }, { id: 'a', text: '6' }])
    expect(r.verdict).toBe('clean')
    expect(r.numbers[0]?.evidence.map((e) => e.id)).toEqual(['a'])
  })
})

describe('triage field:F9 the documented recipe for counts about the answer itself', () => {
  it('field:F9 ignorePattern skips "106 words", and every other number followed by those words', () => {
    const pattern = /\d+ (?:words?|sentences?|characters?|paragraphs?|bullets?)\b/i
    const evidence = 'Revenue was $48.2 million in 2025.'
    const answer = 'In 3 sentences: revenue was $48.2 million in 2025. This summary is 106 words long.'
    expect(verdict(answer, evidence)).toBe('untraced')
    expect(verdict(answer, evidence, { ignorePattern: pattern })).toBe('clean')
    expect(verdict('Revenue was $48.3 million.', evidence, { ignorePattern: pattern })).toBe('untraced')
    // The cost, as the README says: a wrong count of words in the evidence is skipped too.
    expect(verdict('There were 7 words in the headline.', 'The headline had 9 words.', { ignorePattern: pattern })).toBe('clean')
  })
})

describe('L1 false-pass:F13 a number rounded to trailing zeros is unknown, not untraced', () => {
  it('L1 false-pass:F13 About 1,200 from 1,234 and Nearly 80% from 78.4%', () => {
    const a = traceNumbers('About 1,200 employees', 'The company has 1,234 employees.')
    expect(a.numbers[0]).toMatchObject({ status: 'unknown', reason: 'coarse-rounding' })
    expect(traceNumbers('Nearly 80% of users', '78.4% of users').numbers[0]).toMatchObject({ status: 'unknown', reason: 'coarse-rounding' })
    expect(traceNumbers('Over 10,000 visits', '10,432 visits').numbers[0]).toMatchObject({ status: 'unknown', reason: 'coarse-rounding' })
    expect(traceNumbers('About $1,200', 'Cost $1,234.50').numbers[0]).toMatchObject({ status: 'unknown', reason: 'coarse-rounding' })
    expect(traceNumbers('Down about -1,200', 'Change -1,234').numbers[0]).toMatchObject({ status: 'unknown', reason: 'coarse-rounding' })
  })

  it('L1 false-pass:F13 a number that is no rounding of the evidence is still untraced', () => {
    expect(verdict('About 1,300 employees', 'The company has 1,234 employees.')).toBe('untraced')
    expect(verdict('About 1,200 employees', 'The company has 1,264 employees.')).toBe('untraced')
    expect(verdict('Nearly 90% of users', '78.4% of users')).toBe('untraced')
    // The rounding place must be below the leading digit of the evidence: 90 is not "about 100".
    expect(verdict('About 100 days', 'The first 90 days matter.')).toBe('untraced')
    expect(verdict('About 1,000 users', 'There are 940 users.')).toBe('untraced')
    expect(verdict('About 1,000 users', 'There are 950 users.')).toBe('unknown')
    expect(verdict('About 1,000 users', 'There are 1,049 users.')).toBe('unknown')
    // A different kind is not a rounding of it; a unit on one side only is unknown, as for an exact match.
    expect(verdict('About 1,200 kg', 'The company has 1,234 employees.')).toBe('unknown')
    expect(verdict('About 1,200 kg', 'The company weighs 1,234 lb.')).toBe('untraced')
    expect(verdict('About 1,200%', 'The company has 1,234 employees.')).toBe('untraced')
    // Precision that is written stays precision.
    expect(verdict('Exactly 1,200.0 employees', 'The company has 1,234 employees.')).toBe('untraced')
    // A year is a label, not a rounding.
    expect(verdict('In 2000', 'In 2013')).toBe('untraced')
  })

  it('L1 false-pass:F13 the spelled-out rounding is still rounded, and an exact match is still traced', () => {
    expect(traceNumbers('About 1.2K employees', 'The company has 1,234 employees.').numbers[0]?.status).toBe('rounded')
    expect(traceNumbers('About 1.2 thousand employees', 'The company has 1,234 employees.').numbers[0]?.status).toBe('rounded')
    expect(traceNumbers('There are 1,200 employees.', 'There are 1,200 employees.').numbers[0]?.status).toBe('traced')
  })
})
