import { describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'
import type { TraceOptions } from '../src/index.js'
import { GROWTH_LIMIT, growthRatio } from './growth.js'

// Regression rows for the three P2 findings of the independent review of the compound-unit rule (head 874d1a4). Each
// row names its finding and was seen failing before its fix: run10:P2a (a magnitude or exponent before a compound),
// run10:P2b (an adjective before a hyphenated unit) and run10:P2c (a currency symbol before a currency compound).

type Evidence = Parameters<typeof traceNumbers>[1]
type Output = Parameters<typeof traceNumbers>[0]
const trace = (output: Output, evidence: Evidence, options?: TraceOptions): ReturnType<typeof traceNumbers> =>
  traceNumbers(output, evidence, options)
const verdict = (output: string, evidence: string, options?: TraceOptions): string => trace(output, evidence, options).verdict

describe('run10:P2a a magnitude or exponent before a compound unit keeps both', () => {
  it.each([
    ['Used 25 million kilowatt-hours.', 'Used 25,000,000 kilowatt-hours.'],
    ['Used 25,000,000 kilowatt-hours.', 'Used 25 million kilowatt-hours.'],
    ['Used 2e3 kilowatt-hours.', 'Used 2000 kilowatt-hours.'],
    ['Used 2000 kilowatt-hours.', 'Used 2e3 kilowatt-hours.'],
    ['Used 25 million kilowatt-hours.', 'Used 25 million kWh.'],
    ['Used 2.5 billion kW-h.', 'Used 2,500,000,000 kilowatt-hours.'],
    ['Moved 3 million ton-miles.', 'Moved 3,000,000 ton-miles.'],
    ['Logged 4 million person-days.', 'Logged 4,000,000 person-days.'],
    ['Cost 2.5 million dollar-days.', 'Cost 2,500,000 dollar-days.'],
    ['Used 1.5 thousand megawatt-hours.', 'Used 1,500 megawatt-hours.'],
  ])('run10:P2a %s against %s is clean', (output, evidence) => {
    expect(verdict(output, evidence)).toBe('clean')
  })

  it.each([
    ['Used 25 million kilowatt-hours.', 'Used 25 million kilowatts.'],
    ['Used 25 million kilowatts.', 'Used 25 million kilowatt-hours.'],
    ['Used 2e3 kilowatt-hours.', 'Used 2000 kilowatts.'],
    ['Used 25 million kilowatt-hours.', 'Used 25,000,000 kilowatt-minutes.'],
    ['Used 25 million kilowatt-hours.', 'Used 26,000,000 kilowatt-hours.'],
    ['Moved 3 million ton-miles.', 'Moved 3,000,000 tons.'],
    ['Cost 2.5 billion dollar-days.', 'Cost 2.5 billion dollars.'],
    ['Cost 2.5 billion dollar-days.', 'Cost 2.5 billion euro-days.'],
  ])('run10:P2a %s against %s is never clean', (output, evidence) => {
    expect(verdict(output, evidence)).not.toBe('clean')
  })

  it('run10:P2a the token keeps its magnitude and carries the compound unit', () => {
    const [million] = extractNumbers('25 million kilowatt-hours')
    expect(million?.value).toBe('25000000')
    expect(million?.magnitude).toBe(6)
    expect(million?.unit).toBe('kWh')
    expect(million?.raw).toBe('25 million kilowatt-hours')
    const [sci] = extractNumbers('2e3 kilowatt-hours')
    expect(sci?.value).toBe('2000')
    expect(sci?.unit).toBe('kWh')
    expect(sci?.raw).toBe('2e3 kilowatt-hours')
  })

  it('run10:P2a a glued magnitude letter and a compound stay a guess, never a false fail', () => {
    for (const evidence of ['Used 25K kilowatt-hours.', 'Used 25,000 kilowatt-hours.', 'Used 25 kilowatt-hours.']) {
      expect(verdict('Used 25K kilowatt-hours.', evidence)).not.toBe('untraced')
    }
  })

  it('run10:P2a a range with a magnitude shares the compound', () => {
    expect(verdict('Used 2 to 3 million kilowatt-hours.', 'Used 2,000,000 to 3,000,000 kilowatt-hours.')).toBe('clean')
    expect(verdict('Used 2 to 3 million kilowatt-hours.', 'Used 2,000,000 to 3,000,000 kilowatts.')).not.toBe('clean')
  })
})

describe('run10:P2b an ordinary adjective before a hyphenated unit is not a unit', () => {
  it.each([
    ['We held 5 all-day workshops.', 'We held 5 full-day workshops.'],
    ['We held 5 full-day workshops.', 'We held 5 all-day workshops.'],
    ['We booked 3 half-day sessions.', 'We booked 3 full-day sessions.'],
    ['We booked 2 two-day trips.', 'We booked 2 week-long trips.'],
    ['It took 4 round-the-clock shifts.', 'It took 4 overnight-hour shifts.'],
    ['We ran 6 year-round programs.', 'We ran 6 all-year programs.'],
    ['We hired 7 full-time staff.', 'We hired 7 part-time staff.'],
    ['We held 5 all-day workshops.', 'We held 5 workshops.'],
  ])('run10:P2b %s against %s is not untraced', (output, evidence) => {
    expect(verdict(output, evidence)).not.toBe('untraced')
  })

  it('run10:P2b an adjective and a unit leaves the bare count, as before the compound rule', () => {
    expect(extractNumbers('5 all-day workshops')[0]?.unit).toBeUndefined()
    expect(extractNumbers('5 full-day workshops')[0]?.unit).toBeUndefined()
    expect(extractNumbers('3 half-hour talks')[0]?.unit).toBeUndefined()
    expect(extractNumbers('7 full-time staff')[0]?.unit).toBeUndefined()
  })

  it.each([
    ['Moved 25 ton-miles.', 'ton-mi'],
    ['Moved 25 tonne-km.', 'tonne-km'],
    ['Logged 20 person-days.', 'person-day'],
    ['Logged 20 man-hours.', 'man-hour'],
    ['Logged 20 staff-hours.', 'staff-hour'],
    ['Flew 8 passenger-miles.', 'passenger-mi'],
    ['Counted 30 patient-days.', 'patient-day'],
    ['Used 25 kilowatt-hours.', 'kWh'],
    ['Used 3 foot-pounds.', 'ft-lb'],
  ])('run10:P2b the measurement compound %s is still a unit of its own', (text, unit) => {
    expect(extractNumbers(text)[0]?.unit).toBe(unit)
  })

  it('run10:P2b measurement compounds are still told apart', () => {
    expect(verdict('Logged 20 person-days.', 'Logged 20 person-hours.')).not.toBe('clean')
    expect(verdict('Logged 20 person-days.', 'Logged 20 persons.')).not.toBe('clean')
    expect(verdict('Logged 20 person-days.', 'Logged 20 person-days.')).toBe('clean')
  })
})

describe('run10:P2c a currency symbol before the number keeps a currency compound', () => {
  it.each([
    ['The cost was $25 CAD-days.', 'The cost was $25 USD-days.'],
    ['The cost was $25 USD-days.', 'The cost was $25 CAD-days.'],
    ['The cost was $25 USD-days.', 'The cost was $25.'],
    ['The cost was $25.', 'The cost was $25 USD-days.'],
    ['The cost was $25 dollar-days.', 'The cost was $25.'],
    ['The cost was $25 USD-days.', 'The cost was $25 USD-hours.'],
    ['The cost was $25 USD-days.', 'The cost was $25 USD.'],
    ['The cost was C$25 CAD-days.', 'The cost was $25 USD-days.'],
  ])('run10:P2c %s against %s is never clean', (output, evidence) => {
    expect(verdict(output, evidence)).not.toBe('clean')
  })

  it.each([
    ['The cost was $25 USD-days.', 'The cost was $25 USD-days.'],
    ['The cost was $25 CAD-days.', 'The cost was $25 CAD-days.'],
    ['The cost was $25 dollar-days.', 'The cost was $25 USD-days.'],
    ['The cost was $2.5 million USD-days.', 'The cost was $2,500,000 USD-days.'],
    ['The cost was $5 to $10 CAD-days.', 'The cost was $5 to $10 CAD-days.'],
  ])('run10:P2c %s against %s is clean', (output, evidence) => {
    expect(verdict(output, evidence)).toBe('clean')
  })

  it('run10:P2c the token keeps the currency and the compound', () => {
    const [cad] = extractNumbers('$25 CAD-days')
    expect(cad?.kind).toBe('currency')
    expect(cad?.currency).toBe('CAD')
    expect(cad?.unit).toBe('CAD-day')
    expect(cad?.raw).toBe('$25 CAD-days')
    const [usd] = extractNumbers('$25 USD-days')
    expect(usd?.currency).toBe('USD')
    expect(usd?.unit).toBe('USD-day')
  })

  it('run10:P2c a compound written without a currency symbol is unchanged', () => {
    const [bare] = extractNumbers('25 USD-days')
    expect(bare?.kind).toBe('count')
    expect(bare?.currency).toBeUndefined()
    expect(bare?.unit).toBe('USD-day')
    expect(verdict('25 CAD-days', '25 USD-days')).not.toBe('clean')
  })

  it('run10:P2c a dollar sign with a conflicting code stays unknown, never a false pass', () => {
    expect(verdict('The cost was $25 EUR-days.', 'The cost was $25 EUR-days.')).not.toBe('untraced')
    expect(verdict('The cost was $25 EUR-days.', 'The cost was $25 USD-days.')).not.toBe('clean')
  })

  it('run10:P2c a symbol before a unit compound keeps the compound too', () => {
    expect(verdict('Cost $25 kilowatt-hours.', 'Cost $25 kilowatts.')).not.toBe('clean')
    expect(verdict('Cost $25 kilowatt-hours.', 'Cost $25 kilowatt-hours.')).toBe('clean')
  })
})

describe('run10 the compound rule is read in linear time', () => {
  it('run10:P2a P2b P2c scaled, adjective and currency compounds are linear', { timeout: 120_000 }, () => {
    const run = (n: number): (() => void) => {
      const text = '25 million kilowatt-hours, 5 all-day workshops, $25 CAD-days and 2e3 kW-h. '.repeat(Math.ceil(n / 75))
      return () => {
        expect(extractNumbers(text).length).toBeGreaterThan(0)
      }
    }
    expect(growthRatio(run)).toBeLessThan(GROWTH_LIMIT)
  })
})
