import { describe, expect, it } from 'vitest'
import {
  absKey,
  add,
  cmp,
  formatDec,
  fromParts,
  isDecimalString,
  isNegativeValue,
  mantissaAt,
  parseDecimal,
  roundRat,
  sub,
  toRat,
} from '../src/decimal.js'

describe('decimal syntax', () => {
  it('accepts plain decimals and rejects everything else', () => {
    for (const ok of ['0', '12', '-12', '+12', '12.50', '-0.001', '000123']) expect(isDecimalString(ok)).toBe(true)
    for (const bad of ['', '.5', '5.', '1e3', '1,234', ' 1', '1 ', '--1', '1.2.3', 'NaN', 'Infinity', '０']) {
      expect(isDecimalString(bad)).toBe(false)
    }
    expect(isDecimalString('1'.repeat(401))).toBe(false)
    expect(isDecimalString('1'.repeat(401), Infinity)).toBe(true)
  })
})

describe('exact arithmetic', () => {
  it('adds and subtracts without float error', () => {
    const sum = add(parseDecimal('0.1'), parseDecimal('0.2'))
    expect(formatDec(sum)).toBe('0.3')
    expect(cmp(sum, parseDecimal('0.30'))).toBe(0)
    expect(formatDec(sub(parseDecimal('10.10'), parseDecimal('10.11')))).toBe('-0.01')
  })

  it('builds from parts with a power-of-ten shift', () => {
    expect(formatDec(fromParts(false, '1', '2', 6))).toBe('1200000')
    expect(formatDec(fromParts(true, '5', '25', 0))).toBe('-5.25')
    expect(fromParts(false, '1', '2', 6).s).toBe(0)
  })

  it('formats with a fixed number of places and prints zero as 0', () => {
    expect(formatDec(parseDecimal('1.5'), 3)).toBe('1.500')
    expect(formatDec(parseDecimal('0.00'))).toBe('0')
    expect(formatDec(parseDecimal('-0.05'))).toBe('-0.05')
  })

  it('keys ignore sign, leading zeros and trailing fraction zeros', () => {
    expect(absKey('-007.5000')).toBe('7.5')
    expect(absKey('0.000')).toBe('0')
    expect(absKey('100')).toBe('100')
    expect(absKey('+0.10')).toBe('0.1')
    expect(isNegativeValue('-0.00')).toBe(false)
    expect(isNegativeValue('-0.01')).toBe(true)
  })
})

describe('rounding', () => {
  const r = (v: string, scale: number, mode: 'half-up' | 'half-even'): string =>
    roundRat(toRat(parseDecimal(v)), scale, mode).mantissa.toString()

  it('rounds ties by mode', () => {
    expect(r('12.5', 0, 'half-up')).toBe('13')
    expect(r('12.5', 0, 'half-even')).toBe('12')
    expect(r('13.5', 0, 'half-even')).toBe('14')
    expect(r('0.125', 2, 'half-up')).toBe('13')
    expect(r('0.125', 2, 'half-even')).toBe('12')
  })

  it('rounds non-ties the same in both modes', () => {
    for (const mode of ['half-up', 'half-even'] as const) {
      expect(r('12.34', 1, mode)).toBe('123')
      expect(r('12.36', 1, mode)).toBe('124')
    }
  })

  it('rounds to negative scales', () => {
    expect(r('1234567', -5, 'half-up')).toBe('12')
    expect(r('1250000', -5, 'half-up')).toBe('13')
    expect(r('1250000', -5, 'half-even')).toBe('12')
  })

  it('reports exactness', () => {
    expect(roundRat(toRat(parseDecimal('12.30')), 1, 'half-up').exact).toBe(true)
    expect(roundRat(toRat(parseDecimal('12.34')), 1, 'half-up').exact).toBe(false)
  })

  it('finds the mantissa of a value at a scale, or null when it does not divide', () => {
    expect(mantissaAt(parseDecimal('12.50'), 2)).toBe(1250n)
    expect(mantissaAt(parseDecimal('12.50'), 1)).toBe(125n)
    expect(mantissaAt(parseDecimal('12.55'), 1)).toBeNull()
    expect(mantissaAt(parseDecimal('1200000'), -5)).toBe(12n)
    expect(mantissaAt(parseDecimal('1250000'), -6)).toBeNull()
  })
})
