import { describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'
import type { NumberToken, TraceOptions, TraceResult } from '../src/index.js'

// Regression rows from the fourth independent review (f6fad53).

function t(output: string, evidence: Parameters<typeof traceNumbers>[1], options?: TraceOptions): TraceResult {
  return traceNumbers(output, evidence, options)
}

describe('weak provenance does not depend on alternates', () => {
  it('a locale guess with a magnitude alternate is still only a guess', () => {
    expect(t('12,5K', '12500').numbers[0]).toMatchObject({ status: 'unknown' })
    expect(t('12500', '12,5K').numbers[0]).toMatchObject({ status: 'unknown' })
    expect(t('12,5K', '12,5K').numbers[0]?.status).not.toBe('untraced')
    expect(t('12,5K', '99').numbers[0]?.status).toBe('untraced')
    // The unscaled alternate of the guess is a weak link too.
    expect(t('12,5K', '12.5').numbers[0]?.status).toBe('unknown')
  })

  it('fraction membership wins over an existing separator ambiguity', () => {
    expect(t('1.000/2.000', '1.000;2.000').numbers.map((n) => n.status)).toEqual(['unknown', 'unknown'])
    expect(t('1.000/2.000', 'ratio 1.000/2.000').verdict).toBe('clean')
    expect(extractNumbers('1.000/2.000').every((x) => x.ambiguity === 'fraction' && x.groupRaw === '1.000/2.000')).toBe(true)
    // The other readings are not lost.
    expect(extractNumbers('1.000/2.000')[0]?.alternates).toEqual([{ value: '1000', scale: 0 }])
  })

  it('sharing a loose magnitude keeps the unscaled reading next to the other readings', () => {
    const [first] = extractNumbers('1.234–2M')
    expect(first?.alternates).toEqual([{ value: '1234000000', scale: -6 }, { value: '1.234', scale: 3 }])
    expect(t('1.234–2M', '1.234;2000000').numbers[0]?.status).toBe('unknown')
  })
})

describe('symbols after magnitudes', () => {
  it('a percent sign after a magnitude word or letter is kept', () => {
    expect(extractNumbers('1 million %')[0]).toMatchObject({ kind: 'percent', value: '1000000' })
    expect(extractNumbers('1 million%')[0]).toMatchObject({ kind: 'percent' })
    expect(extractNumbers('5K %')[0]).toMatchObject({ kind: 'percent', value: '5000', ambiguous: false })
    expect(extractNumbers('5M%')[0]).toMatchObject({ kind: 'percent' })
    expect(t('1 million %', '1000000').verdict).toBe('untraced')
    expect(t('1 million %', '1000000%').verdict).toBe('clean')
  })
})

describe('dates obey the superscript rule', () => {
  it('a date part followed by an exponent is not a clean date part', () => {
    expect(t('Oct 5²', 'Oct 5').numbers.map((n) => n.status)).toEqual(['traced', 'unknown'])
    expect(t('2026-10-05²', '2026-10-05').verdict).toBe('unknown')
    expect(t('Oct 5^2', 'Oct 5').verdict).toBe('unknown')
    expect(t('10/12/2026²', '10/12/2026').verdict).toBe('unknown')
    expect(t('at 12:30²', 'at 12:30').verdict).toBe('unknown')
    expect(t('Oct 5', 'Oct 5').verdict).toBe('clean')
  })
})

describe('the micro sign', () => {
  it('is a unit prefix or a boundary, never a letter that hides the number', () => {
    expect(t('5µm', '').verdict).toBe('untraced')
    expect(t('5μm', '').verdict).toBe('untraced')
    expect(extractNumbers('5µm')[0]).toMatchObject({ value: '5', unit: 'μm' })
    expect(extractNumbers('5 µg, 3 μL, 2µs').map((x) => x.unit)).toEqual(['μg', 'μl', 'μs'])
    expect(t('5µm', '5 μm').verdict).toBe('clean')
    expect(t('5µm', '5 mm').verdict).toBe('untraced')
    // A micro sign with no unit is a boundary.
    expect(extractNumbers('5µ')[0]).toMatchObject({ value: '5' })
    expect(extractNumbers('5µxyz')[0]).toMatchObject({ value: '5' })
  })
})

describe('date years and other evidence', () => {
  it('a measurement does not vouch for a year, weak identifier digits do not fail it', () => {
    expect(t('2026-10-05', 'October 5;2026 kg').numbers.map((n) => n.status)).toEqual(['untraced', 'traced', 'traced'])
    expect(t('2026-10-05', 'October 5;FY2026').numbers.map((n) => n.status)).toEqual(['unknown', 'traced', 'traced'])
    expect(t('2026-10-05', 'October 5; in 2026').verdict).toBe('clean')
    expect(t('2026-10-05', 'October 5').numbers[0]?.status).toBe('untraced')
  })
})

describe('versions with three-digit parts', () => {
  it('a prerelease or build suffix makes it a version, not a grouped integer', () => {
    expect(extractNumbers('1.234.567-rc.1')).toEqual([])
    expect(extractNumbers('1.234.567+4')).toEqual([])
    expect(t('1.234.567-rc.1', '').verdict).toBe('clean')
    // Without a suffix it is still a grouped integer under a dot-group locale.
    expect(extractNumbers('1.234.567', { locale: 'de-DE' })[0]).toMatchObject({ value: '1234567' })
    expect(extractNumbers('1.234.567 kg', { locale: 'de-DE' })[0]).toMatchObject({ value: '1234567', unit: 'kg' })
  })
})

describe('small integers', () => {
  it('only an exact whole value in range is ignored', () => {
    const neg: NumberToken = { raw: '-1', start: 0, end: 2, value: '-1', scale: 0, kind: 'count', ambiguous: false }
    expect(t([neg] as never, '', { ignoreSmallIntegersUpTo: 0 }).numbers[0]?.status).toBe('untraced')
    expect(traceNumbers([neg], '', { ignoreSmallIntegersUpTo: 5 }).numbers[0]?.status).toBe('untraced')
    const ok: NumberToken = { ...neg, raw: '3', value: '3', end: 1 }
    expect(traceNumbers([ok], '', { ignoreSmallIntegersUpTo: 5 }).numbers[0]?.status).toBe('ignored')
    const frac: NumberToken = { ...ok, value: '3.0', scale: 1 }
    expect(traceNumbers([frac], '', { ignoreSmallIntegersUpTo: 5 }).numbers[0]?.status).toBe('untraced')
  })
})
