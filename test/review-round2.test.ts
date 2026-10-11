import { describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'
import type { NumberToken, TraceOptions, TraceResult } from '../src/index.js'

// Regression rows from the second independent review (edc9c99), plus the
// self-hunt pass for modifiers that must reach every member of a range, a
// chain or a dimension, scans that must not restart, and options that must
// apply on every matching path.

function t(output: string, evidence: Parameters<typeof traceNumbers>[1], options?: TraceOptions): TraceResult {
  return traceNumbers(output, evidence, options)
}

function cpuMs(fn: () => void): number {
  fn() // warm up
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const before = process.cpuUsage()
    fn()
    const used = process.cpuUsage(before)
    best = Math.min(best, (used.user + used.system) / 1e3)
  }
  return best
}

// Quadratic code on these inputs takes tens of seconds; linear code takes well under
// a second. The bounds are absolute and generous so that a loaded machine does not flake.
describe('scans that restart', { timeout: 300_000 }, () => {
  it('a long slash chain is finalized once', () => {
    const text = Array(32000).fill('1').join('/')
    expect(cpuMs(() => extractNumbers(text))).toBeLessThan(2000)
  })

  it('tracing a long slash chain is linear too', () => {
    const text = Array(16000).fill('1').join('/')
    expect(cpuMs(() => traceNumbers(text, text))).toBeLessThan(3000)
  })

  it('incomplete Indian grouping is scanned once', () => {
    const text = Array(100000).fill('11').join(',')
    expect(cpuMs(() => extractNumbers(text, { locale: 'en-IN' }))).toBeLessThan(1500)
    // And it still reads real Indian grouping.
    expect(extractNumbers('12,34,567', { locale: 'en-IN' })[0]).toMatchObject({ value: '1234567' })
    expect(extractNumbers('11,11,11,11,111', { locale: 'en-IN' })[0]).toMatchObject({ value: '11111111111' })
  })
})

describe('units survive magnitudes', () => {
  it('a magnitude word or letter followed by a unit keeps the unit', () => {
    expect(t('1 million kg', '1000000 days').verdict).toBe('untraced')
    expect(t('1 million kg', '1,000,000 kg').verdict).toBe('clean')
    expect(extractNumbers('1 million kg')[0]).toMatchObject({ value: '1000000', unit: 'kg' })
    expect(extractNumbers('2.5 bn m')[0]).toMatchObject({ value: '2500000000', unit: 'm' })
    expect(extractNumbers('3 thousand hours')[0]).toMatchObject({ unit: 'hour' })
    expect(extractNumbers('5 million users')[0]).not.toHaveProperty('unit')
  })
})

describe('slash chains are classified whole', () => {
  it('a date-shaped tail does not escape the chain', () => {
    const r = t('1/2/3/45', '1 2 3 45; 2/3/45')
    expect(r.verdict).toBe('unknown')
    expect(extractNumbers('1/2/3/45').every((x) => x.ambiguity === 'fraction' && x.groupRaw === '1/2/3/45')).toBe(true)
    expect(t('1/2/3/45', 'ratio 1/2/3/45').verdict).toBe('clean')
    // A real date is still a date.
    expect(extractNumbers('on 3/4/26 ok').every((x) => x.kind === 'date-part')).toBe(true)
    expect(extractNumbers('10/12/2026/5').every((x) => x.ambiguity === 'fraction')).toBe(true)
  })
})

describe('modifiers reach every endpoint', () => {
  it('a signed endpoint still shares the unit', () => {
    expect(t('-5–-3%', '-5% and -3%').verdict).toBe('clean')
    expect(extractNumbers('-5–-3%').map((x) => [x.value, x.kind, x.range])).toEqual([
      ['-5', 'percent', 'start'], ['-3', 'percent', 'end'],
    ])
    expect(extractNumbers('5--3 kg').map((x) => [x.value, x.unit])).toEqual([['5', 'kg'], ['-3', 'kg']])
  })

  it('a magnitude and its precision apply to both endpoints', () => {
    expect(t('$1-2M', '$1000000 and $2000000').verdict).toBe('clean')
    expect(extractNumbers('$1-2M').map((x) => [x.value, x.scale, x.currency])).toEqual([
      ['1000000', -6, 'USD'], ['2000000', -6, 'USD'],
    ])
    expect(extractNumbers('1.5-2.5 million').map((x) => [x.value, x.scale])).toEqual([['1500000', -5], ['2500000', -5]])
    // Without money, both ends carry the same ambiguity as the upper one.
    expect(extractNumbers('4-5K').map((x) => [x.value, x.ambiguity, x.alternates?.[0]?.value])).toEqual([
      ['4000', 'suffix', '4'], ['5000', 'suffix', '5'],
    ])
    // An endpoint with its own magnitude keeps it.
    expect(extractNumbers('$1K-2M').map((x) => x.value)).toEqual(['1000', '2000000'])
  })

  it('a unit or percent written on the first endpoint reaches the second, and a chain shares all of it', () => {
    expect(extractNumbers('5kg-10').map((x) => [x.value, x.unit])).toEqual([['5', 'kg'], ['10', 'kg']])
    expect(extractNumbers('5%-10').map((x) => x.kind)).toEqual(['percent', 'percent'])
    expect(extractNumbers('10-12-14%').map((x) => x.kind)).toEqual(['percent', 'percent', 'percent'])
    expect(extractNumbers('$1-2-3M').map((x) => [x.value, x.currency])).toEqual([
      ['1000000', 'USD'], ['2000000', 'USD'], ['3000000', 'USD'],
    ])
  })
})

describe('multiplication is not a unit', () => {
  it('dimensions are numbers with an operator between', () => {
    expect(t('3 x 4 cm', '3 cm by 4 cm').verdict).toBe('clean')
    expect(extractNumbers('3 x 4 cm').map((x) => [x.value, x.unit])).toEqual([['3', 'cm'], ['4', 'cm']])
    expect(extractNumbers('1920 x 1080').map((x) => [x.value, x.unit])).toEqual([['1920', undefined], ['1080', undefined]])
    expect(extractNumbers('1920x1080').map((x) => x.value)).toEqual(['1920', '1080'])
    expect(extractNumbers('3 x4').map((x) => x.value)).toEqual(['3', '4'])
    expect(extractNumbers('2 × 4').map((x) => [x.value, x.unit])).toEqual([['2', undefined], ['4', undefined]])
    expect(extractNumbers('2 X 4 m').map((x) => x.unit)).toEqual(['m', 'm'])
  })

  it('standalone multiples are still multiples', () => {
    expect(extractNumbers('10 x faster')[0]).toMatchObject({ value: '10', unit: 'x' })
    expect(extractNumbers('about 3x')[0]).toMatchObject({ value: '3', unit: 'x' })
    expect(extractNumbers('a 2.5x gain')[0]).toMatchObject({ unit: 'x' })
    expect(t('10x', '10 days').verdict).toBe('untraced')
  })

  it('a hex-like or identifier tail is still an identifier', () => {
    expect(extractNumbers('0x1F and x86 and 3xyz')).toEqual([])
  })
})

describe('allowBareEvidence on every path', () => {
  const bare = { allowBareEvidence: true } as const

  it('rounding', () => {
    const r = t('$12.3', '12.34', bare)
    expect(r.numbers[0]).toMatchObject({ status: 'rounded', unitUnverified: true })
    expect(r.verdict).toBe('clean')
    expect(t('$12.3', '12.34').numbers[0]?.status).toBe('untraced')
    expect(t('12.3%', '12.34', bare).numbers[0]).toMatchObject({ status: 'rounded', unitUnverified: true })
    expect(t('$12.3', '$12.34 USD and 12.34 kg', bare).numbers[0]?.status).toBe('rounded')
    expect(t('$12.3', '12.34 kg', bare).numbers[0]?.status).toBe('untraced')
  })

  it('weak matching', () => {
    expect(t('12,5%', '12.5', bare).numbers[0]).toMatchObject({ status: 'unknown', reason: 'ambiguous-reading' })
    expect(t('$1.2K', '1.234', bare).numbers[0]?.status).toBe('unknown')
    expect(t('12,5%', '12.5').numbers[0]?.status).toBe('untraced')
  })

  it('derivations', () => {
    const r = t('$7', '3 and 4', { ...bare, derivations: ['sum'] })
    expect(r.numbers[0]).toMatchObject({ status: 'derived', unitUnverified: true })
    expect(t('$7', '3 and 4', { derivations: ['sum'] }).numbers[0]?.status).toBe('untraced')
  })
})

describe('ambiguous dates against ordinary values', () => {
  it('the same values written another way make the date unknown, not untraced', () => {
    const r = t('10/12/2026', 'Year 2026; month 10; day 12.')
    expect(r.numbers.map((n) => n.status)).toEqual(['unknown', 'unknown', 'traced'])
    expect(r.verdict).toBe('unknown')
    expect(t('10/12/2026', 'Year 2027; month 11; day 13.').verdict).toBe('untraced')
  })
})

describe('contradictory token flags', () => {
  it('are rejected rather than promoting weak evidence', () => {
    const [ambiguous] = extractNumbers('12,5')
    if (ambiguous === undefined) throw new Error('unreachable')
    const lie = { ...ambiguous, ambiguous: false } as NumberToken
    expect(() => t('12.5', [lie])).toThrow(TypeError)
    expect(() => traceNumbers([lie], 'x')).toThrow(TypeError)
    const noReason = { ...ambiguous, ambiguity: undefined } as unknown as NumberToken
    expect(() => t('12.5', [noReason])).toThrow(TypeError)
    const [plain] = extractNumbers('12.5')
    if (plain === undefined) throw new Error('unreachable')
    expect(() => t('12.5', [{ ...plain, alternates: [{ value: '125', scale: 0 }] }])).toThrow(TypeError)
    // The genuine token still behaves as before.
    expect(t('12.5', [ambiguous]).numbers[0]?.status).toBe('unknown')
  })
})

describe('the self-hunt pass', { timeout: 300_000 }, () => {
  it('ranges are joined by an en dash with spaces or by "to"', () => {
    expect(extractNumbers('5 – 10%').map((x) => x.kind)).toEqual(['percent', 'percent'])
    expect(extractNumbers('from 5 to 10 percent').map((x) => x.kind)).toEqual(['percent', 'percent'])
    expect(extractNumbers('$5 to 10').map((x) => x.currency)).toEqual(['USD', 'USD'])
    expect(extractNumbers('2 to 3 kg').map((x) => x.unit)).toEqual(['kg', 'kg'])
    expect(t('between 5 to 10%', '5% and 10%').verdict).toBe('clean')
    // A hyphen with spaces is arithmetic, not a range.
    expect(extractNumbers('5 - 10%').map((x) => x.kind)).toEqual(['count', 'percent'])
  })

  it('a date range shares the month and year', () => {
    expect(extractNumbers('Oct 5-7, 2026').map((x) => [x.raw, x.part])).toEqual([
      ['Oct', 'month'], ['5', 'day'], ['7', 'day'], ['2026', 'year'],
    ])
    expect(extractNumbers('5-7 October 2026').map((x) => [x.raw, x.part])).toEqual([
      ['5', 'day'], ['7', 'day'], ['October', 'month'], ['2026', 'year'],
    ])
    expect(t('Oct 5-7', 'October 5 and October 7').verdict).toBe('clean')
    expect(t('5-7 October', 'on 2026-10-05 and 2026-10-07').numbers.map((n) => n.status)).toEqual(['traced', 'traced', 'traced'])
    expect(extractNumbers('March 3 to 5').map((x) => [x.raw, x.part])).toEqual([['March', 'month'], ['3', 'day'], ['5', 'day']])
    expect(extractNumbers('3 to 5 March').map((x) => [x.raw, x.part])).toEqual([['3', 'day'], ['5', 'day'], ['March', 'month']])
    // A plain range with no month is untouched.
    expect(extractNumbers('5-7 days').map((x) => x.kind)).toEqual(['count', 'count'])
  })

  it('a long dimension chain and a long range chain stay linear', () => {
    const dims = Array(64000).fill('2').join(' x ') + ' cm'
    expect(cpuMs(() => extractNumbers(dims))).toBeLessThan(2000)
    const range = Array(64000).fill('2').join('-') + 'M'
    expect(cpuMs(() => extractNumbers(range))).toBeLessThan(2000)
    expect(extractNumbers(range).every((x) => x.value === '2000000')).toBe(true)
  })

  it('every chain member gets the chain unit', () => {
    expect(extractNumbers('2 x 3 x 4 m').map((x) => x.unit)).toEqual(['m', 'm', 'm'])
    expect(extractNumbers('1-2-3 kg').map((x) => x.unit)).toEqual(['kg', 'kg', 'kg'])
  })
})
