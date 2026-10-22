import { describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'
import type { TraceOptions } from '../src/index.js'
import { GROWTH_LIMIT, growthRatio } from './growth.js'

// Regression rows from the field-trial review of the 0.1.0 release candidate (c4ea4e0). Each row names its finding and
// was seen failing before its fix. The ids are first5:Fnn (first pass) and hunt:Fn (hunt pass).

type Evidence = Parameters<typeof traceNumbers>[1]
type Output = Parameters<typeof traceNumbers>[0]
const trace = (output: Output, evidence: Evidence, options?: TraceOptions): ReturnType<typeof traceNumbers> =>
  traceNumbers(output, evidence, options)
const statuses = (output: string, evidence: string, options?: TraceOptions): string[] =>
  trace(output, evidence, options).numbers.map((n) => `${n.token.raw}:${n.status}${n.reason !== undefined ? `(${n.reason})` : ''}`)

describe('hunt:F1 a year before 1900 is a label too when only a derivation builds it', () => {
  const report: TraceOptions = { preset: 'report' }
  it.each([
    ['The company was founded in 1879.', 'The company was founded in 1876 and has 3 offices.', report],
    ['The company was founded in 1879.', 'The company was founded in 1876 and has 3 offices.', { derivations: ['sum'] } satisfies TraceOptions],
    ['The company was founded in 1879.', 'Founded in 1876. Headcount: 3.', report],
    ['The company was founded in 1779.', 'The company was founded in 1876 and has 97 offices.', report],
  ])('hunt:F1 %s against %s is never clean', (output, evidence, options) => {
    const r = trace(output, evidence, options)
    expect(r.verdict).toBe('unknown')
    expect(r.numbers[0]?.status).toBe('unknown')
    expect(r.numbers[0]?.reason).toBe('label-derivation')
  })

  it('hunt:F1 no wrong year from 1000 to 1899 comes back derived against a year and a small count', () => {
    const derived: number[] = []
    for (let y = 1000; y < 1900; y++) {
      if (y === 1876) continue
      const r = trace(`It opened in ${y}.`, 'It opened in 1876. It has 3 doors and 40 rooms.', report)
      if (r.numbers[0]?.status === 'derived') derived.push(y)
    }
    expect(derived).toEqual([])
  })

  it.each([
    ['full-width digits', 'Founded in \uff11\uff18\uff17\uff19.'],
    ['Arabic-Indic digits', 'Founded in \u0661\u0668\u0667\u0669.'],
  ])('hunt:F1 a wrong early year written in %s is held like the ASCII form', (_name, output) => {
    const evidence = 'Founded in 1876 and has 3 offices.'
    const ascii = trace('Founded in 1879.', evidence, report)
    const other = trace(output, evidence, report)
    expect(ascii.numbers[0]?.reason).toBe('label-derivation')
    expect(other.numbers[0]?.status).toBe(ascii.numbers[0]?.status)
    expect(other.numbers[0]?.reason).toBe('label-derivation')
    expect(other.verdict).toBe('unknown')
  })

  it('hunt:F1 the same year in the evidence, a separated count and a year outside the window are unchanged', () => {
    expect(statuses('Founded in 1879.', 'Founded in 1879 with 3 offices.', report)).toEqual(['1879:traced'])
    expect(statuses('It has 1,500 units.', 'It has 1,000 units and 500 units.', report)).toEqual(['1,500:derived'])
    expect(statuses('It has 999 units.', 'It has 900 units and 99 units.', report)).toEqual(['999:derived'])
    expect(statuses('It has 1999 units.', 'It has 1996 units and 3 units.', report)).toEqual(['1999:untraced'])
  })
})


describe('hunt:F2 a hyphenated compound unit is not read as its first word', () => {
  it.each([
    ['Output is 25 kilowatt-hours.', 'Output is 25 kilowatts.'],
    ['Output is 25 megawatt-hours.', 'Output is 25 megawatts.'],
    ['Output is 25 watt-hours.', 'Output is 25 watts.'],
    ['Output is 25 kW-h.', 'Output is 25 kW.'],
    ['The ride is 25 mile-per-hour.', 'The ride is 25 miles.'],
    ['Efficiency is 25 miles-per-gallon.', 'Efficiency is 25 miles.'],
    ['Cost is 25 dollar-days.', 'Cost is 25 dollars.'],
    ['Moved 25 ton-miles.', 'Moved 25 tons.'],
    ['Output is 25 kilowatts.', 'Output is 25 kilowatt-hours.'],
    ['Used 25 kilowatt-hours.', 'Used 25 kilowatt-minutes.'],
  ])('hunt:F2 %s against %s is not clean', (output, evidence) => {
    expect(trace(output, evidence).verdict).not.toBe('clean')
  })

  it.each([
    ['Output is 25 kilowatt-hours.'],
    ['Output is 25 kW-h.'],
    ['The ride is 25 mile-per-hour.'],
    ['Efficiency is 25 miles-per-gallon.'],
    ['Cost is 25 dollar-days.'],
    ['Moved 25 ton-miles.'],
    ['A 25-kilowatt-hours battery.'],
  ])('hunt:F2 %s traced against itself is clean', (text) => {
    expect(trace(text, text).verdict).toBe('clean')
  })

  it('hunt:F2 kilowatt-hours is the unit kWh, which differs from kW', () => {
    expect(statuses('Output is 25 kilowatt-hours.', 'Output is 25 kWh.')).toEqual(['25 kilowatt-hours:traced'])
    expect(statuses('Output is 25 kWh.', 'Output is 25 kilowatt-hours.')).toEqual(['25 kWh:traced'])
    expect(statuses('Output is 25 kilowatt-hours.', 'Output is 25 kW.')).toEqual(['25 kilowatt-hours:untraced'])
    expect(statuses('Output is 25 megawatt-hours.', 'Output is 25MWh.')).toEqual(['25 megawatt-hours:traced'])
  })

  it('hunt:F2 a hyphenated per is a rate, and per keeps any whitespace on either side', () => {
    expect(extractNumbers('25 miles-per-hour')[0]?.rate).toBe('/hour')
    expect(extractNumbers('25 miles per hour')[0]?.rate).toBe('/hour')
    expect(extractNumbers('25 miles per\thour')[0]?.rate).toBe('/hour')
    expect(extractNumbers('25 miles\tper hour')[0]?.rate).toBe('/hour')
    // A hyphen on one side only is not the word per between two units.
    expect(extractNumbers('25 miles per-hour')[0]?.rate).toBeUndefined()
    expect(statuses('Drove 25 miles per\thour.', 'Drove 25 miles.')).toEqual(['25 miles per\thour:untraced'])
  })

  it('hunt:F2 a hyphenated word that is not a unit still leaves the first word as the unit', () => {
    expect(extractNumbers('a 10 minute-long call')[0]?.unit).toBe('minute')
    expect(extractNumbers('about 5 year-over-year')[0]?.unit).toBe('year')
    expect(extractNumbers('the 30-day trial')[0]?.unit).toBe('day')
  })

  it('hunt:F2 hyphenated compounds are read in linear time', { timeout: 120_000 }, () => {
    const run = (n: number): (() => void) => {
      const text = '25 kilowatt-hours, 3 ton-miles, 5 kW-h and 7 mile-per-hour. '.repeat(Math.ceil(n / 60))
      return () => {
        expect(extractNumbers(text).length).toBeGreaterThan(0)
      }
    }
    expect(growthRatio(run)).toBeLessThan(GROWTH_LIMIT)
  })
})


describe('first5:F03 a quantity written 3 x Widget A is a count, like 3 × Widget A', () => {
  it.each([
    ['3 Widget A', 'Qty 3 x Widget A @ $45.00 = $135.00'],
    ['Qty 3', 'Qty 3 x Widget A'],
    ['3 Widget A', '3 × Widget A'],
    ['3 Widget A', 'Qty 3 x $45.00'],
  ])('first5:F03 %s against %s is clean', (output, evidence) => {
    expect(trace(output, evidence, { preset: 'report' }).verdict).toBe('clean')
    expect(trace(output, evidence).verdict).toBe('clean')
  })

  it('first5:F03 a multiple and a dimension are unchanged', () => {
    expect(extractNumbers('10 x faster')[0]?.unit).toBe('x')
    expect(extractNumbers('3x Widget A')[0]?.unit).toBe('x')
    expect(extractNumbers('3 x widget')[0]?.unit).toBe('x')
    expect(extractNumbers('3 x 4 cm').map((t) => t.unit)).toEqual(['cm', 'cm'])
    expect(statuses('It ran 10 faster.', 'It ran 10 x faster.')).toEqual(['10:unknown(unit-unverified)'])
  })
})


describe('first5:F04 and hunt:F5 a parenthesized percent after a word, copied from the evidence, traces to it', () => {
  const evidence = 'Subtotal $1,200.00. Tax (8.25%) $99.00. Total due $1,299.00.'
  it.each([
    [evidence],
    ['Support is high (70%) overall.'],
    ['The largest customers (35%) are retail.'],
    ['The majority of Democrats (70%) and Independents (60%) support this.'],
    ['Heavy drinking among Americans rose 17.2 percent (22 percent) in some states.'],
  ])('first5:F04 %s traced against itself is clean', (text) => {
    expect(trace(text, text).verdict).toBe('clean')
  })

  it('first5:F04 a locale guess on either side is never a trace, label or not', () => {
    // 12,5 under en-US is a guess about the locale: it can be unknown or untraced, never a pass.
    expect(statuses('Tax (12,5%)', 'Tax (12.5%)')).toEqual(['(12,5%):unknown(ambiguous-reading)'])
    expect(trace('Tax (12.5%)', 'Tax (12,5%)').verdict).toBe('unknown')
    expect(trace('Tax (12,5%)', 'Tax (12,5%)').verdict).not.toBe('clean')
    expect(trace('Tax (12.5%)', 'Tax (12.5%)').verdict).toBe('clean')
  })

  it('first5:F04 the label is the same figure only when it is written the same', () => {
    expect(statuses('Support is high (71%) overall.', 'Support is high (70%) overall.')).toEqual(['(71%):untraced'])
    // The kit does not read the sentence: an unlabeled evidence percent still leaves the parenthesized negative held.
    expect(statuses('Support is high (70%) overall.', 'Support is high at 70% overall.')).toEqual(['(70%):unknown(sign-differs)'])
    // A rounded figure is not the same text.
    expect(statuses('Tax (8.3%) was due.', evidence)).toEqual(['(8.3%):unknown(sign-differs)'])
    // A percent after a linking word is a loss on both sides and was already traced.
    expect(statuses('Margin was (12%).', 'Margin was (12%).')).toEqual(['(12%):traced'])
  })
})

