import { describe, expect, it } from 'vitest'
import { extractNumbers, reconcile, traceNumbers } from '../src/index.js'
import { resolveLocale } from '../src/locale.js'
import type { TraceOptions } from '../src/index.js'

// Regression rows from the release-gate review of 0.1.0 (head 464d7ec). Each row names its finding id
// (gate-review, gate-false-pass or gate-hostile) and was seen failing before its fix.

type Evidence = Parameters<typeof traceNumbers>[1]
type Output = Parameters<typeof traceNumbers>[0]
const resolveLocaleFor = (value: unknown): unknown => resolveLocale(value)
const verdict = (output: Output, evidence: Evidence, options?: TraceOptions): string => traceNumbers(output, evidence, options).verdict
const trace = (output: Output, evidence: Evidence, options?: TraceOptions): ReturnType<typeof traceNumbers> =>
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

describe('gate-review:F02 gate-hostile:G03 gate-false-pass:G5-F06 a currency code or local abbreviation glued to an amount', () => {
  const codes = ['AED', 'THB', 'PKR', 'NGN', 'SAR', 'CZK', 'HUF', 'RON', 'BGN', 'RMB', 'EGP', 'ILS', 'KES', 'GHS', 'BTC', 'ETH', 'USDT', 'USDC', 'IDR', 'VND', 'MYR', 'QAR', 'KWD', 'ARS', 'CLP']

  it.each(codes)('gate-review:F02 %s glued to an amount is read as that currency and a wrong amount is untraced', (code) => {
    expect(extractNumbers(`Fee ${code}1,500 due`)[0]).toMatchObject({ kind: 'currency', currency: code, value: '1500' })
    expect(verdict(`Fee ${code}1,500 due`, 'Fee 9 due')).toBe('untraced')
    expect(verdict(`Fee ${code}1,500 due`, `Fee ${code}99 due`)).toBe('untraced')
    expect(verdict(`Fee ${code}1,500 due`, `Fee ${code}1,500 due`)).toBe('clean')
    expect(verdict(`Fee ${code}1,500 due`, `Fee ${code} 1,500 due`)).toBe('clean')
    expect(verdict(`Fee ${code} 1,500 due`, `Fee ${code}1,500 due`)).toBe('clean')
    expect(verdict(`Fee 1,500 ${code} due`, `Fee ${code}1,500 due`)).toBe('clean')
  })

  it('gate-review:F02 the finding examples', () => {
    expect(verdict('Plan costs AED199 per month.', 'Plan costs AED99 per month.')).toBe('untraced')
    expect(verdict('Fee: AED1,500 due', 'Fee: 9 due')).toBe('untraced')
    expect(verdict('Pro plan: AED199/month', 'AED99/month')).toBe('untraced')
    expect(verdict('Price SAR1,500', 'Price 9')).toBe('untraced')
  })

  it('gate-hostile:G03 AED500 against a different code or the same code with another amount', () => {
    expect(verdict('The fee is AED500.', 'The fee is EUR 9.')).toBe('untraced')
    expect(verdict('The fee is AED500.', 'The fee is AED900.')).toBe('untraced')
    expect(verdict('The fee is AED500.', 'The fee is EUR 500.')).toBe('untraced')
  })

  it('gate-false-pass:G5-F06 EGP5,000 against EGP 50 and CZK9999 against CZK 5', () => {
    expect(verdict('Cost EGP5,000', 'Cost EGP 50')).toBe('untraced')
    expect(verdict('Cost CZK9999', 'Cost CZK 5')).toBe('untraced')
    expect(verdict('The fee is AED1,200.', 'The fee is AED 12.')).toBe('untraced')
  })

  it.each([['KSh'], ['Ksh'], ['Sh'], ['TL'], ['Dh'], ['Kz']])('gate-review:F02 a local abbreviation %s before three digits is an unread form, never clean', (prefix) => {
    const r = trace(`Fee ${prefix}1500 due`, 'Fee 9 due')
    expect(r.verdict).toBe('unknown')
    expect(r.skipped.map((s) => s.reason)).toEqual(['unread-glued-form'])
  })

  it('gate-false-pass:G5-F06 a lower-case code before an amount with a separator is an unread form', () => {
    expect(trace('The fee is usd1,200.', 'The fee is 9.').verdict).toBe('unknown')
    expect(trace('The fee is aed1,200.', 'The fee is 9.').verdict).toBe('unknown')
  })

  it('gate-review:F02 words and names that are ISO codes stay what they were', () => {
    expect(extractNumbers('TOP 10 reasons and ALL 5 items')).toMatchObject([{ kind: 'count', value: '10' }, { kind: 'count', value: '5' }])
    expect(trace('COP26 and TOP10 and PEN5', 'x').skipped.map((s) => s.reason)).toEqual(['identifier', 'identifier', 'identifier'])
    expect(trace('The P100 and Q3 and N95', 'x').verdict).toBe('clean')
    expect(extractNumbers('AMD 5 chips')[0]).toMatchObject({ kind: 'count' })
  })
})

describe('gate-false-pass:G5-F02 a currency code glued to the low end of a range', () => {
  const tails: [string, string, string][] = [
    ['USD100-200k', 'USD100-300k', 'USD100-200k'],
    ['USD100-200K', 'USD100-300K', 'USD100-200K'],
    ['CHF100-200k', 'CHF100-300k', 'CHF100-200k'],
    ['EUR5-7m', 'EUR5-9m', 'EUR5-7m'],
    ['GBP5-7m', 'GBP5-9m', 'GBP5-7m'],
    ['AUD5-7m', 'AUD5-9m', 'AUD5-7m'],
    ['CAD5-7m', 'CAD5-9m', 'CAD5-7m'],
    ['JPY5-7m', 'JPY5-9m', 'JPY5-7m'],
    ['USD5-7bn', 'USD5-9bn', 'USD5-7bn'],
    ['USD5-7t', 'USD5-9t', 'USD5-7t'],
    ['INR5-7cr', 'INR5-9cr', 'INR5-7cr'],
  ]
  it.each(tails)('gate-false-pass:G5-F02 %s: a wrong upper bound is untraced and the same text is clean', (honest, wrong, same) => {
    expect(verdict(`Salary ${honest}`, `Salary ${wrong}`)).toBe('untraced')
    expect(verdict(`Salary ${honest}`, `Salary ${same}`)).toBe('clean')
  })

  it('gate-false-pass:G5-F02 the spaced and symbol spellings of the same range agree with the glued one', () => {
    expect(verdict('Salary USD100-200k', 'Salary USD 100-200k')).toBe('clean')
    expect(verdict('Salary USD 100-200k', 'Salary USD100-200k')).toBe('clean')
    expect(verdict('Salary EUR100-200k', 'Salary €100,000-€200,000')).toBe('clean')
    expect(verdict('Salary $100-200k', 'Salary $100-300k')).toBe('untraced')
  })

  it('gate-false-pass:G5-F02 model names with a hyphen stay identifiers', () => {
    expect(trace('Qwen3-8B and gpt-4-turbo-2026 and Llama-3.1-70B', 'x').numbers).toEqual([])
    expect(trace('Qwen3-8B and gpt-4 here', 'x').numbers.map((n) => n.token.raw)).toEqual(['4'])
    expect(trace('The A100-80GB card', 'x').verdict).toBe('clean')
  })
})

describe('gate-hostile:G10 a skipped form never overlaps a number token', () => {
  const overlaps = (text: string): string[] => {
    const r = trace(text, 'x')
    const found: string[] = []
    for (const s of r.skipped) {
      for (const n of r.numbers) {
        if (s.start < n.token.end && n.token.start < s.end) found.push(`${JSON.stringify(s.raw)} [${s.start},${s.end}) vs ${JSON.stringify(n.token.raw)} [${n.token.start},${n.token.end})`)
      }
    }
    return found
  }

  it.each(['Revenue 500CA$25', 'in250USD 1,234.56', 'Cost 5Jan 9', 'Price 12foo$5', 'Total 7xyz€9', 'x 5Oct 12', 'a 3Mar 4 b'])('gate-hostile:G10 %s', (text) => {
    expect(overlaps(text)).toEqual([])
  })

  it('gate-hostile:G10 seeded random text never overlaps', () => {
    const alphabet = '0123456789  ,.$€-%CAUSDJanOctMar_x/():kKmMbB '
    let seed = 20261014
    const next = (): number => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const bad: string[] = []
    for (let k = 0; k < 6000; k++) {
      let text = ''
      const len = 3 + Math.floor(next() * 22)
      for (let i = 0; i < len; i++) text += alphabet[Math.floor(next() * alphabet.length)]
      const found = overlaps(text)
      if (found.length > 0) bad.push(`${JSON.stringify(text)}: ${found[0]}`)
    }
    expect(bad.slice(0, 5)).toEqual([])
  })
})

describe('gate-review:F03 digit groups joined by underscores', () => {
  it.each([
    ['Revenue is $1_500_000.', 'Revenue is $900.'],
    ['Revenue is 1_500_000 dollars.', 'Revenue is 900 dollars.'],
    ['Count is 12_000.', 'Count is 900.'],
    ['Rate is 12_5%.', 'Rate is 9%.'],
  ])('gate-review:F03 %s is not clean against %s', (output, evidence) => {
    expect(verdict(output, evidence)).not.toBe('clean')
  })

  it('gate-review:F03 a clean group of three is the number, and it traces to the other writings', () => {
    expect(extractNumbers('Revenue is $1_500_000.')[0]).toMatchObject({ raw: '$1_500_000', value: '1500000', currency: 'USD' })
    expect(extractNumbers('12_000')[0]).toMatchObject({ raw: '12_000', value: '12000' })
    expect(extractNumbers('1_234_567.89')[0]).toMatchObject({ value: '1234567.89' })
    expect(verdict('Revenue is $1_500_000.', 'Revenue is $1,500,000.')).toBe('clean')
    expect(verdict('Revenue is $1,500,000.', 'Revenue is $1_500_000.')).toBe('clean')
    expect(verdict('Revenue is 1_500_000 dollars.', 'Revenue is $900.')).toBe('untraced')
  })

  it('gate-review:F03 groups that are not a thousands grouping are an unread form, never clean', () => {
    for (const text of ['12_5%', '1_5', '0_500', '1_2345', '12_34_567']) {
      const r = trace(`Value ${text} here`, 'Value 7 here')
      expect(r.verdict, text).toBe('unknown')
      expect(r.skipped.map((s) => [s.raw, s.reason]), text).toEqual([[text.replace('%', ''), 'unread-glued-form']])
    }
  })

  it('gate-review:F03 names that hold digits stay identifiers, and markup underscores stay markup', () => {
    expect(extractNumbers('foo_12 and x_1 and x86_64 and 5_foo')).toEqual([])
    expect(trace('foo_12 and x86_64 and 5_foo', 'x').skipped.map((s) => s.reason)).toEqual(['identifier', 'identifier', 'identifier'])
    expect(extractNumbers('_12.5%_ and __1,234__ and 1766____').map((t) => t.raw)).toEqual(['12.5%', '1,234', '1766'])
  })
})

describe('gate-review:F04 gate-false-pass:G5-F12 dotted two-digit-year dates, h times and ISO weeks', () => {
  it('gate-review:F04 14.10.26 against 15.10.26 with locale de-DE is not clean', () => {
    expect(verdict('Fällig am 14.10.26.', 'Fällig am 15.10.26.', { locale: 'de-DE' })).toBe('untraced')
    expect(verdict('Fällig am 14.10.26.', 'Fällig am 14.10.26.', { locale: 'de-DE' })).toBe('clean')
    expect(verdict('Due 14.10.26.', 'Due 15.10.26.')).not.toBe('clean')
  })

  it.each([
    ['Due 05.03.26.', 'Due 06.03.26.'],
    ['Due 5.3.26.', 'Due 6.3.26.'],
    ['Due 31.12.99.', 'Due 30.12.99.'],
  ])('gate-false-pass:G5-F12 %s is not clean against %s and is clean against itself', (output, evidence) => {
    expect(verdict(output, evidence)).not.toBe('clean')
    expect(verdict(output, output)).toBe('clean')
  })

  it('gate-false-pass:G5-F12 the date is read as a date: day, month and a two-digit year', () => {
    expect(extractNumbers('Due 14.10.26.', { locale: 'de-DE' }).map((t) => [t.kind, t.part, t.value])).toEqual([
      ['date-part', 'day', '14'], ['date-part', 'month', '10'], ['date-part', 'year', '26'],
    ])
  })

  it('gate-false-pass:G5-F12 versions and addresses stay identifiers', () => {
    expect(extractNumbers('v1.2.26 and 192.168.1.1 and 1.2.3 and 10.0.0.1')).toEqual([])
    expect(extractNumbers('Python 3.12.1 and 2.40.60')).toEqual([])
  })

  it('gate-false-pass:G5-F12 17h30 and 9h30 are times of day', () => {
    expect(verdict('Départ à 17h30.', 'Départ à 17h45.')).toBe('untraced')
    expect(verdict('Départ à 9h30.', 'Départ à 9h45.')).toBe('untraced')
    expect(verdict('Départ à 17h30.', 'Départ à 17h30.')).toBe('clean')
    expect(verdict('Départ à 17h30.', 'Départ à 17:30.')).toBe('clean')
    expect(verdict('Départ à 17H30.', 'Départ à 17:30.')).toBe('clean')
    expect(extractNumbers('Départ à 17h30.')[0]).toMatchObject({ kind: 'time', value: '1050', raw: '17h30' })
  })

  it('gate-false-pass:G5-F12 an hour with a unit is not a time', () => {
    expect(extractNumbers('Runs 2h and 17h and 5h30pm')[0]).toMatchObject({ kind: 'count', unit: 'hour' })
  })

  it('gate-false-pass:G5-F12 a week of the year is an unread form', () => {
    const r = trace('Shipped 2026-W10.', 'Shipped 2026-W11.')
    expect(r.verdict).not.toBe('clean')
    expect(r.skipped.map((s) => s.raw)).toEqual(['W10'])
  })
})

describe('gate-review:F07 an hour in parentheses', () => {
  it('gate-review:F07 (4am) and (5 pm) are times of day', () => {
    expect(extractNumbers('Open (4am).')[0]).toMatchObject({ kind: 'time', value: '240' })
    expect(extractNumbers('Open (5 pm).')[0]).toMatchObject({ kind: 'time', value: '1020' })
    expect(verdict('Open (4am) and (9pm).', 'Open 4am and 9pm.')).toBe('clean')
    expect(verdict('Open 4am and 9pm.', 'Open (4am) and (9pm).')).toBe('clean')
    expect(verdict('Open (4am).', 'Open 5am.')).toBe('untraced')
  })
  it('gate-review:F07 a parenthesized time never answers to a minus sign', () => {
    expect(extractNumbers('Open (4am).')[0]?.parenthesized).toBeUndefined()
  })
})

describe('gate-review:F08 British dotted clock times', () => {
  it('gate-review:F08 5.30pm is 5:30pm', () => {
    expect(verdict('Doors open at 5.30pm.', 'Doors open at 5:30pm.')).toBe('clean')
    expect(verdict('Doors open at 5:30pm.', 'Doors open at 5.30pm.')).toBe('clean')
    expect(verdict('Doors open at 5.30 pm.', 'Doors open at 17:30.', { locale: 'en-GB' })).toBe('clean')
    expect(verdict('Doors open at 5.30pm.', 'Doors open at 6.30pm.')).toBe('untraced')
    expect(verdict('Doors open at 5.30pm.', 'Doors open at 5.30am.')).toBe('untraced')
    expect(extractNumbers('Doors open at 5.30pm.')[0]).toMatchObject({ kind: 'time', value: '1050', unit: 'pm' })
  })
  it('gate-review:F08 a decimal with no meridiem, or an hour that is not on a 12-hour clock, stays a decimal', () => {
    expect(extractNumbers('Rating 5.30 and 17.30pm and 5.3pm').map((t) => [t.kind, t.value])).toEqual([['decimal', '5.30'], ['decimal', '17.30'], ['decimal', '5.3']])
  })
})

describe('gate-review:F10 a count, a period and a capitalized English month name', () => {
  it('gate-review:F10 the count stays a count outside German', () => {
    expect(verdict('Headcount is 20.', 'Headcount is 20. March hiring is pending.')).toBe('clean')
    expect(verdict('We opened 4.', 'We opened 4. May saw growth.')).toBe('clean')
    expect(verdict('We opened 4.', 'We opened 4. April saw growth.')).toBe('clean')
    expect(extractNumbers('Headcount is 20. March hiring is pending.').map((t) => t.kind)).toEqual(['count'])
  })
  it('gate-review:F10 the German form is still a date in German and for German month names', () => {
    expect(extractNumbers('Am 5. März 2026', { locale: 'de-DE' }).map((t) => t.kind)).toEqual(['date-part', 'date-part', 'date-part'])
    expect(extractNumbers('Am 5. März 2026').map((t) => t.kind)).toEqual(['date-part', 'date-part', 'date-part'])
    expect(extractNumbers('Am 5. April 2026', { locale: 'de-DE' }).map((t) => t.kind)).toEqual(['date-part', 'date-part', 'date-part'])
    expect(verdict('Am 5. März 2026', 'Am 5 März 2026', { locale: 'de-DE' })).toBe('clean')
  })
})

describe('gate-review:F06 a lone magnitude letter after a currency amount', () => {
  it.each([
    ['Revenue: $5 M\nCosts: $3 M', 'Revenue: $5 million\nCosts: $3 million'],
    ['**Revenue $5 M**', 'Revenue $5 million'],
    ['Revenue $5 M\tnet', 'Revenue $5 million'],
    ['Revenue $5 M+ net', 'Revenue $5 million'],
    ['Revenue $5 M-ish', 'Revenue $5 million'],
    ['Revenue $5 M—costs', 'Revenue $5 million'],
    ['Revenue "$5 M"', 'Revenue $5 million'],
    ['Revenue [$5 M]', 'Revenue $5 million'],
    ['Revenue |$5 M|', 'Revenue $5 million'],
    ['Revenue $5 M\r\nnet', 'Revenue $5 million'],
    ['Revenue $5 M *net*', 'Revenue $5 million'],
  ])('gate-review:F06 %j is $5 million', (output, evidence) => {
    expect(verdict(output, evidence)).toBe('clean')
    expect(verdict(output, 'Revenue $5')).toBe('untraced')
  })

  it('gate-review:F06 a letter that starts a word is still a word', () => {
    expect(extractNumbers('Revenue $5 Mx and $5 Mark')[0]).toMatchObject({ value: '5', currency: 'USD' })
    expect(extractNumbers('Revenue $5 M2')[0]).toMatchObject({ value: '5' })
  })
})

describe('gate-review:F09 lowercase m and spaced MM are not only meters and millimeters', () => {
  it('gate-review:F09 2.5m customers against 2.5 million customers is unknown, never untraced', () => {
    for (const [output, evidence] of [
      ['We have 2.5m customers.', 'We have 2.5 million customers.'],
      ['We have 1.2m units.', 'We have 1.2 million units.'],
      ['We have 48 MM units.', 'We have 48 million units.'],
    ] as const) {
      expect(verdict(output, evidence), output).toBe('unknown')
    }
    expect(verdict('We have 3.5m customers.', 'We have 2.5 million customers.')).toBe('untraced')
    expect(verdict('We have 2.5 million customers.', 'We have 2.5m customers.')).toBe('unknown')
  })

  it('gate-review:F09 the reading as meters or millimeters still traces to itself and to the words', () => {
    expect(verdict('The pool is 25m long.', 'The pool is 25m long.')).toBe('clean')
    expect(verdict('The pool is 25m long.', 'The pool is 25 meters long.')).toBe('clean')
    expect(verdict('A 48 MM lens.', 'A 48 MM lens.')).toBe('clean')
    expect(verdict('The pool is 25m long.', 'The pool is 30m long.')).toBe('untraced')
  })

  it('gate-review:F09 MM before a currency is millions', () => {
    expect(verdict('Revenue 5 MM USD.', 'Revenue 5 million USD.')).toBe('clean')
    expect(verdict('Revenue 5 MM USD.', 'Revenue 5 USD.')).toBe('untraced')
    expect(verdict('Revenue 5 MM dollars.', 'Revenue $5 million.')).toBe('clean')
    expect(verdict('Revenue $5 MM.', 'Revenue $5 million.')).toBe('clean')
  })
})

describe('gate-false-pass:G5-F05 magnitude words and letters that were dropped silently', () => {
  it.each([['trn'], ['tril'], ['bil'], ['mill'], ['thou'], ['grand']])('gate-false-pass:G5-F05 $5 %s is not $5', (word) => {
    expect(verdict(`India targets a $5 ${word} economy.`, 'India targets a $5 economy.')).toBe('untraced')
  })

  it('gate-false-pass:G5-F05 the words have the value they say', () => {
    expect(extractNumbers('$5 trn, $5 tril, $2.1 bil, $5 mill, $5 thou, $5 grand').map((t) => t.value)).toEqual([
      '5000000000000', '5000000000000', '2100000000', '5000000', '5000', '5000',
    ])
    expect(verdict('India targets a $5 trn economy.', 'India targets a $5 trillion economy.')).toBe('clean')
    expect(extractNumbers('Federer won 5 grand slams, 3 mill workers and 2 thou').map((t) => t.value)).toEqual(['5', '3', '2'])
  })

  it('gate-false-pass:G5-F05 a spaced bare K, M, B or T is a magnitude that may be a label, so it is never a silent pass', () => {
    for (const letter of ['K', 'M', 'B', 'T']) {
      expect(verdict(`Users: 5 ${letter}`, 'Users: 5'), letter).toBe('unknown')
      expect(verdict(`Users: 5 ${letter}`, `Users: 5 ${letter}`), letter).toBe('clean')
    }
    expect(verdict('Users: 5 M', 'Users: 5 million')).toBe('clean')
    expect(extractNumbers('Users: 5 M')[0]).toMatchObject({ value: '5000000', ambiguous: true, ambiguity: 'suffix' })
  })
})

describe('gate-false-pass:G5-F08 a magnitude after the closing parenthesis of an accounting negative', () => {
  it.each([
    ['The net loss was ($14.2) million.'],
    ['The net loss was $(14.2) million.'],
    ['The net loss was ($14.2)M.'],
    ['The net loss was (14.2) million.'],
  ])('gate-false-pass:G5-F08 %s is -14.2 million', (text) => {
    expect(extractNumbers(text)[0]).toMatchObject({ value: '-14200000', signStyle: 'parentheses' })
  })

  it('gate-false-pass:G5-F08 the honest restatement traces and the scale error does not', () => {
    expect(trace('The net loss was $14.2 million.', 'Net loss for the year was ($14.2) million.').counts.signDiffers).toBe(1)
    expect(verdict('The net loss was $14.2 million.', 'Net loss for the year was ($14.2) million.')).toBe('clean')
    expect(verdict('The net loss was $14.2.', 'Net loss for the year was ($14.2) million.')).toBe('untraced')
    expect(verdict('The net loss was $1.2 billion.', 'The loss was ($1.2) billion.')).toBe('clean')
    expect(verdict('The net loss was $1.2.', 'The loss was ($1.2) billion.')).toBe('untraced')
    expect(verdict('The net loss was ($14.2 million).', 'Net loss for the year was ($14.2) million.')).toBe('clean')
  })

  it('gate-false-pass:G5-F08 a word after the parenthesis that is not a magnitude changes nothing', () => {
    expect(extractNumbers('Loss ($14.2) and ($3.5) total')[0]).toMatchObject({ value: '-14.2', raw: '($14.2)' })
  })
})

describe('gate-false-pass:G5-F04 gate-hostile:G17 gate-false-pass:G5-P3 unit words that were not units', () => {
  const pairs: [string, string][] = [
    ['2 tablespoons', '2 teaspoons'], ['2 tbsp', '2 tsp'], ['25 milligrams', '25 micrograms'], ['25 megawatts', '25 gigawatts'],
    ['25 megawatts', '25 kilowatts'], ['25 millimeters', '25 centimeters'], ['25 bytes', '25 bits'], ['25 milliseconds', '25 microseconds'],
    ['25 cups', '25 quarts'], ['25 calories', '25 kilocalories'], ['25 pF', '25 nF'], ['25 square meters', '25 square kilometers'],
    ['25 sq ft', '25 sq mi'], ['25 milliliters', '25 liters'], ['25 nanoseconds', '25 milliseconds'], ['230V', '230A'], ['5 volts', '5 amps'],
  ]
  it.each(pairs)('gate-false-pass:G5-F04 %s is not %s', (a, b) => {
    expect(verdict(`Use ${a} of it.`, `Use ${b} of it.`)).toBe('untraced')
    expect(verdict(`Use ${a} of it.`, `Use ${a} of it.`)).toBe('clean')
  })

  it('gate-false-pass:G5-F04 a unit word and its abbreviation are the same unit', () => {
    expect(verdict('Dose 25 milligrams.', 'Dose 25 mg.')).toBe('clean')
    expect(verdict('Dose 25 mg.', 'Dose 25 milligrams.')).toBe('clean')
    expect(verdict('Width 5 centimeters.', 'Width 5 cm.')).toBe('clean')
    expect(verdict('Add 2 tablespoons.', 'Add 2 tbsp.')).toBe('clean')
    expect(verdict('Takes 5 milliseconds.', 'Takes 5 ms.')).toBe('clean')
  })

  it('gate-false-pass:G5-F04 milligrams against a bare number is unknown, like kilograms', () => {
    expect(verdict('Dose 25 milligrams.', 'Dose 25.')).toBe('unknown')
    expect(verdict('Dose 25 kilograms.', 'Dose 25.')).toBe('unknown')
  })

  it.each([['24MP'], ['3BR'], ['2bd'], ['25mpg'], ['5bar'], ['230V'], ['5A'], ['3.3V'], ['5pcs']])('gate-hostile:G17 gate-false-pass:G5-P3 %s is a unit, so the same text traces and another amount does not', (spec) => {
    expect(verdict(`The spec is ${spec} here.`, `The spec is ${spec} here.`)).toBe('clean')
    expect(verdict(`The spec is ${spec} here.`, `The spec is ${spec.replace(/[^\d.]/g, '')} here.`)).toBe('unknown')
    expect(verdict(`The spec is ${spec} here.`, `The spec is ${spec.replace(/\d/, '9')} here.`)).toBe('untraced')
  })

  it('gate-hostile:G17 names with a letter before the digits stay identifiers', () => {
    expect(trace('The V8 and A4 and K3', 'x').skipped.map((s) => s.reason)).toEqual(['identifier', 'identifier', 'identifier'])
  })
})

describe('gate-false-pass:G5-P3 currency symbols, per mille and the multiplication sign', () => {
  const symbols = ['₿', '₨', '₸', '₵', '₼', '₾', '֏', '₮', '₭', '៛', '₡', '₲', '﷼', '¤', '₠', '₢', '₣', '₤', '₥', '₧', '₯', '₰', '₳', '₶', '₷']
  it.each(symbols)('gate-false-pass:G5-P3 %s before an amount is a currency', (sym) => {
    expect(extractNumbers(`Cost ${sym}500 now`)[0]).toMatchObject({ kind: 'currency', value: '500' })
    expect(verdict(`Cost ${sym}500 now`, 'Cost 500 now')).toBe('untraced')
    expect(verdict(`Cost ${sym}500 now`, `Cost ${sym}900 now`)).toBe('untraced')
    expect(verdict(`Cost ${sym}500 now`, `Cost ${sym}500 now`)).toBe('clean')
  })

  it('gate-false-pass:G5-P3 per mille is its own unit, and the small percent sign is a percent', () => {
    expect(extractNumbers('Rate 12‰ and 3‱')).toMatchObject([{ value: '12', unit: '‰' }, { value: '3', unit: '‱' }])
    expect(verdict('Rate 12‰.', 'Rate 12.')).toBe('unknown')
    expect(verdict('Rate 12‰.', 'Rate 12‰.')).toBe('clean')
    expect(verdict('Rate 12‰.', 'Rate 12%.')).toBe('untraced')
    expect(extractNumbers('Rate 12﹪')[0]).toMatchObject({ kind: 'percent', value: '12' })
    expect(verdict('Rate 12﹪.', 'Rate 12%.')).toBe('clean')
  })

  it('gate-false-pass:G5-P3 10× is a multiple like 10x, and 3×4 is still a dimension', () => {
    expect(extractNumbers('It is 10× faster')[0]).toMatchObject({ value: '10', unit: 'x' })
    expect(verdict('It is 10× faster.', 'It is 10 employees.')).toBe('unknown')
    expect(verdict('It is 1.5× faster.', 'It is 1.5x faster.')).toBe('clean')
    expect(verdict('It is 11× faster.', 'It is 12x faster.')).toBe('untraced')
    expect(extractNumbers('A 3×4 cm card').map((t) => [t.value, t.unit])).toEqual([['3', 'cm'], ['4', 'cm']])
  })
})

describe('gate-false-pass:G5-F03 gate-hostile:G13 the denominator of a rate', () => {
  const different: [string, string][] = [
    ['25 mg/kg', '25 mg'], ['25 mg/kg/day', '25 mg/day'], ['25 mL/hr', '25 mL'], ['25 mg/dL', '25 mg'], ['25 km/h', '25 km'],
    ['25 MB/s', '25 MB'], ['$29/month', '$29/year'], ['$25/hour', '$25/day'], ['5%/yr', '5%/month'], ['$0.12/kWh', '$0.12/MWh'],
    ['25 mg/s', '25 mg/min'], ['5% per year', '5% per month'], ['25 mg', '25 mg/kg'],
  ]
  it.each(different)('gate-false-pass:G5-F03 %s is not %s', (a, b) => {
    expect(verdict(`It is ${a} here.`, `It is ${b} here.`)).toBe('untraced')
    expect(verdict(`It is ${a} here.`, `It is ${a} here.`)).toBe('clean')
  })

  it('gate-hostile:G13 an amount or percent whose rate only one side writes still traces (a restated figure, "a month")', () => {
    expect(verdict('EPS was $2.15.', 'Diluted EPS increased 15% to $2.15 per share.')).toBe('clean')
    expect(verdict('Plan is $29/month.', 'Plan is $29 a month.')).toBe('clean')
    expect(verdict('Plan is $29.', 'Plan is $29/month.')).toBe('clean')
    expect(verdict('Plan is $30/month.', 'Plan is $29 a month.')).toBe('untraced')
    expect(verdict('Growth is 5%/yr.', 'Growth is 5%.')).toBe('clean')
  })

  it('gate-hostile:G13 the same number as a rate against a bare number is unknown', () => {
    expect(verdict('Dose is 25 mg/kg.', 'Dose is 25.')).toBe('unknown')
    expect(verdict('Price is $29/month.', 'Price is 29.')).toBe('untraced')
  })

  it('gate-false-pass:G5-F03 a slash and the word per are the same rate', () => {
    expect(verdict('Dose is 25 mg per kg.', 'Dose is 25 mg/kg.')).toBe('clean')
    expect(verdict('Speed is 25 km per hour.', 'Speed is 25 km/h.')).toBe('clean')
    expect(verdict('Plan is $29 per month.', 'Plan is $29/month.')).toBe('clean')
    expect(verdict('Plan is $29/mo.', 'Plan is $29/month.')).toBe('clean')
    expect(verdict('Growth is 5% per year.', 'Growth is 5%/yr.')).toBe('clean')
  })

  it('gate-false-pass:G5-F03 the token carries the rate and the raw text includes it', () => {
    expect(extractNumbers('Plan $29/month')[0]).toMatchObject({ raw: '$29/month', value: '29', currency: 'USD', rate: '/month' })
    expect(extractNumbers('Dose 25 mg/kg/day')[0]).toMatchObject({ raw: '25 mg/kg/day', unit: 'mg', rate: '/kg/day' })
    expect(extractNumbers('Growth 5% per year')[0]).toMatchObject({ raw: '5% per year', rate: '/year' })
    expect(extractNumbers('Speed 25 km/h')[0]).toMatchObject({ unit: 'km', rate: '/hour' })
  })

  it('gate-false-pass:G5-F03 a range shares the rate written once', () => {
    expect(extractNumbers('Plans cost $5-10/month').map((t) => [t.value, t.currency, t.rate])).toEqual([['5', 'USD', '/month'], ['10', 'USD', '/month']])
    expect(verdict('Plans cost $5-10/month.', 'Plans cost $5-10/year.')).toBe('untraced')
  })

  it('gate-false-pass:G5-F03 a slash that is not a rate is left alone', () => {
    for (const text of ['25 km/4 and 3 kg/ and 10/12/2026 and 3/4', '1 USD/EUR and and/or 5 kg', '5 kg/bag']) {
      expect(extractNumbers(text).every((t) => t.rate === undefined), text).toBe(true)
    }
  })

  it('gate-false-pass:G5-F03 tokens you extracted keep the rate, and a malformed rate is a TypeError', () => {
    expect(verdict('Plan $29/month.', extractNumbers('Plan $29/month'))).toBe('clean')
    expect(verdict('Plan $29/year.', extractNumbers('Plan $29/month'))).toBe('untraced')
    const token = extractNumbers('Plan $29/month')[0]
    expect(() => traceNumbers('x 1', [{ ...token, rate: 'month' }] as never)).toThrow(TypeError)
    expect(() => traceNumbers('x 1', [{ ...token, rate: 5 }] as never)).toThrow(TypeError)
  })
})

describe('gate-hostile:G01 glued compound quantities', () => {
  const compounds: [string, string][] = [
    ['2h45m', '1h30m'], ['5m30s', '1m10s'], ['3d4h', '1d2h'], ['2h30min', '1h15min'], ['6ft2in', '5ft10in'], ['5lb3oz', '7lb2oz'], ['10st4lb', '7st2lb'],
  ]
  it.each(compounds)('gate-hostile:G01 %s against %s is an unread form, so never clean', (a, b) => {
    const r = trace(`Runtime is ${a}.`, `Runtime is ${b}.`)
    expect(r.verdict).toBe('unknown')
    expect(r.skipped.map((s) => [s.raw, s.reason])).toEqual([[a, 'unread-glued-form']])
  })

  it('gate-hostile:G01 1h30 against 2h15 is a wrong time of day, untraced', () => {
    expect(verdict('Runtime is 1h30.', 'Runtime is 2h15.')).toBe('untraced')
  })

  it('gate-hostile:G01 single glued units and names keep their reading', () => {
    expect(extractNumbers('250W and 45days and 5kg and 3D and 5G and 4WD and x86_64 and H2O').map((t) => t.raw)).toEqual(['250W', '45days', '5kg'])
    expect(trace('Runtime is 2h45m and 5G', 'x').skipped.map((s) => s.reason)).toEqual(['unread-glued-form', 'identifier'])
  })

  it('gate-hostile:G01 the spelled-out compound is still caught element by element', () => {
    expect(verdict('Runtime is 2 hours 45 minutes.', 'Runtime is 1 hour 30 minutes.')).toBe('untraced')
  })
})

describe('gate-review:F20 gate-hostile:G04 gate-false-pass:G5-F13 numeric characters that are not decimal digits', () => {
  it('gate-false-pass:G5-F13 circled digits are an unread form, so the verdict is unknown', () => {
    const r = trace('Revenue grew ⑤⓪% to $①② million.', 'Revenue grew 5% to $12 million.')
    expect(r.verdict).toBe('unknown')
    expect(r.skipped.map((s) => [s.raw, s.reason])).toEqual([['⑤⓪', 'unread-glued-form'], ['①②', 'unread-glued-form']])
  })

  it.each([['⑤⓪'], ['①②③'], ['❶❷'], ['➄➀'], ['㊿'], ['⑴'], ['⒈'], ['⓿'], ['Ⅻ'], ['〇'], ['\u{1F100}'], ['\u{10107}']])('gate-hostile:G04 %s is never silent', (glyph) => {
    const r = trace(`Revenue was ${glyph} dollars.`, 'Revenue was 12 dollars.')
    expect(r.verdict).toBe('unknown')
    expect(r.skipped.length).toBe(1)
  })

  it.each([['¹²⁰'], ['⁵⁰'], ['₅₀'], ['₀']])('gate-hostile:G04 %s standing alone is an unread form', (glyph) => {
    expect(trace(`The dose is ${glyph} mg.`, 'The dose is 12 mg.').verdict).toBe('unknown')
    expect(trace(`Churn was ${glyph}%.`, 'Churn was 5%.').verdict).toBe('unknown')
  })

  it('gate-review:F20 a circled digit and the digits written against it are one form (never read as 0)', () => {
    const r = trace('Revenue was ⑤00 dollars.', 'Revenue was 9 dollars.')
    expect(r.numbers).toEqual([])
    expect(r.skipped.map((s) => s.raw)).toEqual(['⑤00'])
    expect(r.verdict).toBe('unknown')
  })

  it('gate-hostile:G04 footnote marks and chemical formulas do not change a verdict', () => {
    const r = trace('Revenue grew.¹ See H₂O and the note² and CO₂.', 'x')
    expect(r.verdict).toBe('clean')
    expect(r.skipped.every((s) => s.reason === 'identifier')).toBe(true)
  })

  it('gate-false-pass:G5-F13 a number followed by a superscript is still an exponent, and a digit before a glyph is not hidden', () => {
    expect(trace('It is 10² here', 'x').numbers[0]).toMatchObject({ status: 'unknown', reason: 'ambiguous-superscript' })
    expect(trace('It is 5⑤ here', 'x').verdict).toBe('untraced')
    expect(trace('It is 5⑤ here', '5').verdict).toBe('unknown')
  })

  it('gate-false-pass:G5-F13 every BMP and astral character of category No or Nl standing alone leaves a trace', () => {
    const bad: string[] = []
    for (let cp = 0xb2; cp <= 0x1ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const ch = String.fromCodePoint(cp)
      if (!/^[\p{No}\p{Nl}]$/u.test(ch)) continue
      const r = trace(`x ${ch} y`, 'x')
      if (r.numbers.length === 0 && r.skipped.length === 0) bad.push(cp.toString(16))
    }
    expect(bad).toEqual([])
  })
})

describe('gate-hostile:G09 typeset minus and plus look-alikes', () => {
  it.each([['‒'], ['﹣'], ['➖'], ['⁃'], ['−'], ['‐'], ['‑'], ['－']])('gate-hostile:G09 U+%s before a number is a minus', (dash) => {
    expect(extractNumbers(`The loss was ${dash}$300.`)[0]).toMatchObject({ value: '-300', signStyle: 'minus' })
    expect(verdict(`The loss was ${dash}$300.`, 'The profit was $300.')).toBe('untraced')
    expect(verdict(`The loss was ${dash}$300.`, 'The loss was -$300.')).toBe('clean')
  })
  it.each([['﹢'], ['➕'], ['＋']])('gate-hostile:G09 U+%s before a number is a plus', (plus) => {
    expect(extractNumbers(`It rose ${plus}5%.`)[0]).toMatchObject({ value: '5', signStyle: 'plus' })
  })
})

describe('gate-hostile:G02 a percent sign before the number', () => {
  it('gate-hostile:G02 %12 is 12%, in Turkish and everywhere', () => {
    expect(extractNumbers('Oran %12', { locale: 'tr' })[0]).toMatchObject({ kind: 'percent', value: '12', raw: '%12' })
    expect(extractNumbers('Rate %12')[0]).toMatchObject({ kind: 'percent', value: '12' })
    expect(verdict('Oran %12', 'Oran 12%', { locale: 'tr' })).toBe('clean')
    expect(verdict('Oran 12%', 'Oran %12', { locale: 'tr' })).toBe('clean')
    expect(verdict('Oran %12', 'Oran %13', { locale: 'tr' })).toBe('untraced')
  })
  it('gate-hostile:G02 %12 is never a bare 12 that traces to a count', () => {
    expect(verdict('Oran %12', 'Toplam 12 adet', { locale: 'tr' })).toBe('untraced')
    expect(verdict('Rate %12', 'Headcount 12')).toBe('untraced')
  })
  it('gate-hostile:G02 a percent sign that belongs to something else is left alone', () => {
    expect(extractNumbers('x%12 and 100%12 and 5%').map((t) => [t.raw, t.kind])).toEqual([['12', 'count'], ['100%', 'percent'], ['12', 'count'], ['5%', 'percent']])
    expect(extractNumbers('Oran %.5')[0]?.kind).toBe('decimal')
    expect(extractNumbers('q=a%20b and =%3D and /%20').map((t) => t.kind)).not.toContain('percent')
  })
})

describe('gate-false-pass:G5-F09 a displayed 0 or 1 that only a rounding builds (report preset)', () => {
  const report = { preset: 'report' as const }
  it('gate-false-pass:G5-F09 a claim of zero is not supported by a ratio that rounds to zero', () => {
    const r = trace('There were 0 incidents.', 'Take 1 tablet (10 mg) once daily. Do not exceed 20 mg in 24 hours.', report)
    expect(r.verdict).toBe('unknown')
    expect(r.numbers[0]).toMatchObject({ status: 'unknown', reason: 'coarse-derivation' })
  })

  it.each([
    ['There were 0 incidents.', 'It took 15 min and then 40 min.'],
    ['There were 0 incidents.', 'The plans cost $29 and $99.'],
    ['There were 1 incidents.', 'The fee is 5% on $10.'],
    ['There were 0 incidents.', 'The fee is 5% on $10.'],
  ])('gate-false-pass:G5-F09 %s is not clean against %s', (output, evidence) => {
    expect(verdict(output, evidence, report)).not.toBe('clean')
  })

  it('gate-false-pass:G5-F09 an exact derivation and a number shown with more digits are unchanged', () => {
    expect(trace('The difference is 1.', 'Counts were 10 and 9.', report).numbers[0]?.status).toBe('derived')
    expect(trace('Share is 0.5.', 'Counts were 10 and 20.', report).numbers[0]?.status).toBe('derived')
    expect(verdict('There were 0 incidents.', 'There were 0 incidents.', report)).toBe('clean')
  })
})

describe('gate-false-pass:G5-F10 gate-review:F16 ignoreStructure skips structure, not counts, figures and sections', () => {
  const o = { ignoreStructure: true }
  it.each([
    ['Under Section 230 platforms are not liable.', 'Under Section 203 platforms are not liable.'],
    ['In Section 12 it is stated.', 'In Section 13 it is stated.'],
    ['See Figure 450 for details.', 'See Figure 45 for details.'],
    ['250. Revenue was high.', 'Revenue was high.'],
    ['Sales figures 240 for the quarter.', 'Sales figures 300 for the quarter.'],
    ['Questions 15 respondents said yes.', 'Questions 20 respondents said yes.'],
    ['Options 400 customers chose it.', 'Options 300 customers chose it.'],
    ['Steps 120 were completed.', 'Steps 100 were completed.'],
  ])('gate-false-pass:G5-F10 %s is untraced against %s', (output, evidence) => {
    expect(verdict(output, evidence, o)).toBe('untraced')
  })

  it('gate-false-pass:G5-F10 the labels of the answer itself are still skipped', () => {
    for (const label of ['Step 4', 'Passage 12', 'Figure 2', 'Option 3', 'Question 7', 'Fig. 2', 'step 4']) {
      expect(verdict(`In ${label}, revenue was $5 million.`, 'Revenue $5 million.', o), label).toBe('clean')
    }
    expect(verdict('12. Revenue $5 million.', 'Revenue $5 million.', o)).toBe('clean')
    expect(verdict('Revenue was $5 million [150].', 'Revenue $5 million.', o)).toBe('clean')
  })
})

describe('gate-hostile:G17 gate-review:F02 an unread form that the evidence writes the same way', () => {
  it('gate-hostile:G17 the same unread text in the output and the evidence is vouched for, a different one is not', () => {
    const same = trace('Fee is Rs1,500.', 'The fee: Rs1,500 due.')
    expect(same.verdict).toBe('clean')
    expect(same.skipped.map((s) => [s.raw, s.reason])).toEqual([['Rs1,500', 'in-evidence']])
    expect(trace('Fee is Rs1,500.', 'The fee: Rs1,200 due.').verdict).toBe('unknown')
    expect(trace('Fee is Rs1,500.', 'The fee: 1,500 due.').verdict).toBe('unknown')
    expect(verdict('Value 12foo here', 'Value 12foo there')).toBe('clean')
    expect(verdict('Value 12foo here', 'Value 13foo there')).toBe('unknown')
  })

  it('gate-hostile:G01 gate-false-pass:G5-F12 a compound quantity and a week of the year copied from the evidence trace', () => {
    expect(verdict('Runtime is 2h45m.', 'Runtime is 2h45m.')).toBe('clean')
    expect(verdict('Runtime is 2h45m.', 'Runtime is 2h50m.')).toBe('unknown')
    expect(verdict('Shipped 2026-W10.', 'Shipped 2026-W10.')).toBe('clean')
    expect(verdict('Shipped 2026-W10.', 'Shipped 2026-W11.')).toBe('unknown')
    expect(verdict('Fee AED1,500 due', 'Fee AED1,500 due')).toBe('clean')
  })

  it('gate-hostile:G17 an ignore still works, and evidence given as tokens cannot vouch', () => {
    expect(trace('Fee is Rs1,500.', 'x', { ignore: ['Rs1,500'] }).skipped.map((s) => s.reason)).toEqual(['ignored'])
    expect(trace('Fee is Rs1,500.', extractNumbers('The fee: Rs1,500 due.')).verdict).toBe('unknown')
  })
})

describe('gate-false-pass:G5-F07 gate-review:F05 the identifiers in the output can be checked against the evidence', () => {
  const pairs: [string, string][] = [
    ['Q3 revenue was $5M.', 'Q4 revenue was $5M.'], ['FY26 revenue was $5M.', 'FY27 revenue was $5M.'], ['FY2026 revenue was $5M.', 'FY2027 revenue was $5M.'],
    ['H1 revenue was $5M.', 'H2 revenue was $5M.'], ['Latency p99 was low.', 'Latency p95 was low.'],
    ['It supports 5G.', 'It supports 4G.'], ['It runs on V8.', 'It runs on V6.'], ['It is 1080p.', 'It is 720p.'], ['The F-150 sold.', 'The F-250 sold.'],
    ['Uses GPT-4 here.', 'Uses GPT-5 here.'], ['Uses Llama-3.1-70B here.', 'Uses Llama-3.1-8B here.'], ['See clause 4.1.2.', 'See clause 4.1.3.'],
    ['Host 10.0.0.1 is up.', 'Host 10.0.0.2 is up.'], ['See cell B7.', 'See cell B9.'], ['An iPhone15 sold.', 'An iPhone14 sold.'],
  ]
  it.each(pairs)('gate-false-pass:G5-F07 %s against %s', (output, evidence) => {
    expect(verdict(output, evidence)).toBe('clean')
    const r = trace(output, evidence, { checkIdentifiers: true })
    expect(r.verdict).toBe('unknown')
    expect(r.skipped.map((s) => s.reason)).toContain('not-in-evidence')
    expect(verdict(output, output, { checkIdentifiers: true })).toBe('clean')
    expect(trace(output, output, { checkIdentifiers: true }).skipped.map((s) => s.reason)).toContain('in-evidence')
  })

  it('gate-false-pass:G5-F07 1H26 is read as a time (1:26), so a different half-year is not clean even without the option', () => {
    expect(verdict('1H26 revenue was $5M.', '2H26 revenue was $5M.')).not.toBe('clean')
  })

  it('gate-review:F05 a wrong quarter next to a right amount is the case it exists for', () => {
    expect(verdict('In Q2 revenue was $5 million.', 'In Q3 revenue was $5 million.', { checkIdentifiers: true })).toBe('unknown')
    expect(verdict('In Q3 revenue was $5 million.', 'In Q3 revenue was $5 million.', { checkIdentifiers: true })).toBe('clean')
  })

  it('gate-false-pass:G5-F07 it is off by default, and evidence given as tokens cannot be compared, so every identifier is unknown', () => {
    expect(verdict('Q3 revenue was $5M.', 'Q4 revenue was $5M.')).toBe('clean')
    expect(verdict('Q3 revenue was $5M.', extractNumbers('Q3 revenue was $5M.'), { checkIdentifiers: true })).toBe('unknown')
  })

  it('gate-false-pass:G5-F07 the option is a boolean', () => {
    expect(() => traceNumbers('1', '1', { checkIdentifiers: 'yes' as unknown as boolean })).toThrow(TypeError)
  })
})

describe('gate-review:F11 gate-hostile:G05 gate-review:F18 tokens from extractNumbers keep their skipped forms', () => {
  it.each([['The fee is Rs1,500.'], ['The fee is 12foo.'], ['The total is 𝟓𝟎.'], ['The fee is 2h45m.']])('gate-hostile:G05 %s is unknown as a string and as tokens', (text) => {
    const asString = trace(text, 'The fee is 500 dollars.')
    const asTokens = trace(extractNumbers(text), 'The fee is 500 dollars.')
    expect(asString.verdict).toBe('unknown')
    expect(asTokens.verdict).toBe('unknown')
    expect(asTokens.counts.skipped).toBe(1)
    expect(asTokens.skipped).toEqual(asString.skipped)
  })

  it('gate-review:F11 an array that is not the one extractNumbers returned has no skipped forms to report', () => {
    const tokens = extractNumbers('The fee is Rs1,500 and 7.')
    expect(trace(tokens, 'x 7').verdict).toBe('unknown')
    expect(trace([...tokens], 'x 7').verdict).toBe('clean')
    expect(trace(tokens.filter((t) => t.value === '7'), 'x 7').verdict).toBe('clean')
  })

  it('gate-review:F11 an ignore covers the form for tokens too', () => {
    expect(trace(extractNumbers('The fee is Rs1,500.'), 'x', { ignore: ['Rs1,500'] }).verdict).toBe('clean')
  })
})

describe('gate-hostile:G20 a bound on the numbers in the output', () => {
  it('gate-hostile:G20 more numbers than maxOutputNumbers is a RangeError, thrown while reading', () => {
    expect(() => traceNumbers('1 2 3 4 5 6 7 8 9 10 11', 'x', { maxOutputNumbers: 10 })).toThrow(RangeError)
    expect(traceNumbers('1 2 3 4 5 6 7 8 9 10', '1 2 3 4 5 6 7 8 9 10', { maxOutputNumbers: 10 }).verdict).toBe('clean')
    expect(() => traceNumbers(extractNumbers('1 2 3 4 5 6 7 8 9 10 11'), 'x', { maxOutputNumbers: 10 })).toThrow(RangeError)
  })

  it('gate-hostile:G20 the default is 500,000 numbers and the scan stops there, however long the text is', () => {
    const cpu = (text: string): number => {
      const before = process.cpuUsage()
      expect(() => traceNumbers(text, '1')).toThrow(RangeError)
      const spent = process.cpuUsage(before)
      return (spent.user + spent.system) / 1000
    }
    const short = cpu('1 '.repeat(500_001))
    const long = cpu('1 '.repeat(2_400_000))
    // A scan that read all of it would cost about 4.8 times as much.
    expect(long / Math.max(short, 50)).toBeLessThan(2.5)
  }, 120_000)

  it('gate-hostile:G20 the option is an integer from 1 to 500,000', () => {
    expect(() => traceNumbers('1', '1', { maxOutputNumbers: 0 })).toThrow(RangeError)
    expect(() => traceNumbers('1', '1', { maxOutputNumbers: 500_001 })).toThrow(RangeError)
    expect(() => traceNumbers('1', '1', { maxOutputNumbers: 1.5 })).toThrow(TypeError)
  })
})

describe('input hygiene from the gate review', () => {
  it('gate-review:F12 an evidence token reads its raw once', () => {
    const base = extractNumbers('Fee $5')[0] as unknown as Record<string, unknown>
    let reads = 0
    const item: Record<string, unknown> = { ...base }
    Object.defineProperty(item, 'raw', { enumerable: true, get() { reads++; return '$5' } })
    expect(traceNumbers('Fee $5', [item as never]).verdict).toBe('clean')
    expect(reads).toBe(1)
    expect(() => traceNumbers('5', [{ id: 'a' }] as never)).toThrow(/has an id but no text/)
  })

  it('gate-hostile:G11 a polluted Object.prototype does not change the ids of evidence tokens', () => {
    const proto = Object.prototype as unknown as Record<string, unknown>
    proto['evidenceId'] = 'POLLUTED'
    try {
      const r = trace('Fee $5', extractNumbers('Fee $5'))
      expect(r.numbers[0]?.evidence.map((e) => e.id)).toEqual(['token:0'])
    } finally {
      delete proto['evidenceId']
    }
  })

  it('gate-hostile:G12 a null locale is named null, and an extension after -u- is named', () => {
    expect(() => traceNumbers('1', '1', { locale: null as never })).toThrow(/got null/)
    expect(() => extractNumbers('1', { locale: null as never })).toThrow(/got null/)
    expect(() => traceNumbers('1', '1', { locale: 5 as never })).toThrow(/got number/)
    expect(() => resolveLocaleFor(null)).toThrow(/got null/)
    expect(() => extractNumbers('1', { locale: 'fr-CA-u-nu-arab-x-private' })).toThrow(/"x" extension is not supported/)
    expect(() => extractNumbers('1', { locale: 'en-US-u-nu' })).not.toThrow()
    expect(() => extractNumbers('1', { locale: 'en-US-u' })).toThrow(/keywords of two to eight characters/)
  })

  it.each([
    [{ id: 'a', text: 'Fee 5', uid: 7 }], [{ id: 'a', text: 'Fee 5', idx: 7 }], [{ id: 'a', text: 'Fee 5', ids: [1] }], [{ id: 'a', text: 'Fee 5', ID: 7 }],
    [{ id: 'a', text: 'Fee 5', Id: 7 }], [{ id: 'a', text: 'Fee 5', i: 7 }], [{ id: 'a', text: 'Fee 5', ide: 7 }], [{ id: 'a', text: 'Fee 5', texts: 7 }],
    [{ id: 'a', text: 'Fee 5', text_: 7 }],
  ])('gate-review:F13 an evidence document may carry other data: %j', (doc) => {
    expect(traceNumbers('Fee 5', [doc] as never).verdict).toBe('clean')
  })

  it.each([
    [{ id: 'a', text: 'Fee 5', scael: 'thousand' }], [{ id: 'a', text: 'Fee 5', Currency: 'USD' }], [{ id: 'a', text: 'Fee 5', scaleApply: 'bare' }],
    [{ id: 'a', text: 'Fee 5', scaleapply: 'bare' }], [{ id: 'a', text: 'Fee 5', scaleApplied: 'bare' }], [{ id: 'a', text: 'Fee 5', scaleAppliesTo: 'bare' }],
  ])('gate-hostile:G14 a probable typo of a hint is still an error: %j', (doc) => {
    expect(() => traceNumbers('Fee 5', [doc] as never)).toThrow(RangeError)
  })

  it('gate-review:F13 a reconcile row may carry other data when its own keys are there, and a typo is still an error', () => {
    expect(reconcile({ rows: [{ label: 'a', amount: '1', labels: 'x', amounts: 'y' }] as never, total: '1' }).ok).toBe(true)
    expect(() => reconcile({ rows: [{ label: 'a', amout: '1' }] as never, total: '1' })).toThrow(RangeError)
  })

  it('gate-hostile:G19 a currency on a token is a code in capitals or a symbol', () => {
    const t = extractNumbers('Fee $5')[0] as unknown as Record<string, unknown>
    expect(() => traceNumbers('Fee $5', [{ ...t, currency: 'usd' }] as never)).toThrow(TypeError)
    expect(() => traceNumbers([{ ...t, currency: 'usd' }] as never, 'Fee $5')).toThrow(TypeError)
    expect(traceNumbers([{ ...t, currency: 'USD' }] as never, 'Fee $5').verdict).toBe('clean')
    const yen = extractNumbers('Fee ¥5')[0] as unknown as Record<string, unknown>
    expect(traceNumbers([yen] as never, 'Fee ¥5').verdict).toBe('clean')
  })
})

describe('gate-hostile:G18 gate-review:F18 reconcile amounts', () => {
  it.each([['0,125'], ['00,125'], ['$0,125'], ['01,500'], ['(0,125)']])('gate-hostile:G18 %s is not read as 125 under the default mark', (amount) => {
    expect(() => reconcile({ rows: [{ label: 'a', amount }], total: '125' })).toThrow(TypeError)
  })
  it('gate-hostile:G18 the readings that were right stay right', () => {
    expect(reconcile({ rows: [{ label: 'a', amount: '0.125' }], total: '0.125' }).ok).toBe(true)
    expect(reconcile({ rows: [{ label: 'a', amount: '1,125' }], total: '1125' }).ok).toBe(true)
    expect(reconcile({ rows: [{ label: 'a', amount: '0,125' }], total: '0,125' }, { decimalMark: ',' }).ok).toBe(true)
    expect(reconcile({ rows: [{ label: 'a', amount: '10,500' }], total: '10500' }).ok).toBe(true)
  })
  it('gate-hostile:G18 the error says a decimal comma needs decimalMark', () => {
    expect(() => reconcile({ rows: [{ label: 'a', amount: '0,125' }], total: '125' })).toThrow(/decimalMark/)
  })
  it('gate-review:F18 a trailing currency sign is read under decimalMark ","', () => {
    const o = { decimalMark: ',' as const }
    expect(reconcile({ rows: [{ label: 'a', amount: '1.234,50 €' }, { label: 'b', amount: '0,50 €' }], total: '1.235,00 €' }, o).ok).toBe(true)
    expect(reconcile({ rows: [{ label: 'a', amount: '1.234,50€' }], total: '€ 1.234,50' }, o).ok).toBe(true)
    expect(() => reconcile({ rows: [{ label: 'a', amount: '€ 1.234,50 €' }], total: '1' }, o)).toThrow(TypeError)
    expect(() => reconcile({ rows: [{ label: 'a', amount: '1.234,50 €' }], total: '$1.234,50' }, o)).toThrow(/mix currency signs/)
  })
  it('gate-review:F18 a tolerance with a decimal point under decimalMark "," says to write a comma', () => {
    const o = { decimalMark: ',' as const }
    expect(() => reconcile({ rows: [{ label: 'a', amount: '1,00' }], total: '1,01', tolerance: '0.01' }, o)).toThrow(/0,01/)
    expect(reconcile({ rows: [{ label: 'a', amount: '1,00' }], total: '1,01', tolerance: '0,01' }, o).ok).toBe(true)
  })
})

describe('gate-review:F21 estimate and actual suffixes on a year', () => {
  it('gate-review:F21 2026E and 2026A are labels, listed as identifiers, and the same text traces', () => {
    for (const label of ['2026E', '2026A', '2025F', '2026P']) {
      const r = trace(`${label} revenue was $5M.`, `${label} revenue was $5M.`)
      expect(r.verdict, label).toBe('clean')
      expect(r.skipped.map((s) => [s.raw, s.reason]), label).toEqual([[label, 'identifier']])
    }
    expect(verdict('2026E revenue was $5M.', '2026A revenue was $5M.')).toBe('clean')
    expect(verdict('2026E revenue was $5M.', '2026A revenue was $5M.', { checkIdentifiers: true })).toBe('unknown')
  })
  it('gate-review:F21 a number that is not a year keeps its unit reading', () => {
    expect(extractNumbers('Draws 2025A and 5A').map((t) => [t.raw, t.unit])).toEqual([['5A', 'A']])
  })
})

describe('gate-review:F19 a parenthetical right after a figure is an aside, not an accounting negative', () => {
  it.each([
    ['The loss could be as high as £200 million ($300 million), they said.', 'The loss could be as high as £200 million, about $300 million.'],
    ['Revenue rose to $5 million (12.5%).', 'Revenue rose to $5 million, up 12.5%.'],
    ['Fees were 200 (300) in all.', 'Fees were 200 and 300 in all.'],
    ['It cost €200 ($300).', 'It cost €200 or $300.'],
  ])('gate-review:F19 %s is clean', (output, evidence) => {
    expect(verdict(output, evidence)).toBe('clean')
  })

  it('gate-review:F19 the same words with no figure before the parenthesis are still held', () => {
    expect(verdict('The loss could be as high as ($300 million), they said.', 'The loss could be about $300 million.')).toBe('unknown')
    expect(verdict('Growth was strong (12.5%).', 'Growth was 12.5%.')).toBe('unknown')
  })

  it('gate-review:F19 tokens carry no text, so a parenthesized negative from tokens is held', () => {
    expect(verdict(extractNumbers('It cost €200 ($300).'), 'It cost €200 or $300.')).toBe('unknown')
  })
})
