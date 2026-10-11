import { describe, expect, it } from 'vitest'
import { reconcile, reconcileComponents } from '../src/index.js'

describe('reconcile: exact decimals', () => {
  it('does not suffer float drift', () => {
    // 0.1 + 0.2 !== 0.3 in floats.
    expect(reconcile({ rows: [{ label: 'a', amount: '0.1' }, { label: 'b', amount: '0.2' }], total: '0.3' })).toMatchObject({
      ok: true, sum: '0.3', difference: '0',
    })
    const many = Array.from({ length: 1000 }, (_, i) => ({ label: `r${i}`, amount: '0.01' }))
    expect(reconcile({ rows: many, total: '10.00' })).toMatchObject({ ok: true, sum: '10.00', rows: 1000 })
  })

  it('reports the exact signed difference (sum minus total)', () => {
    expect(reconcile({ rows: [{ label: 'a', amount: '100.00' }], total: '99.99' }).difference).toBe('0.01')
    expect(reconcile({ rows: [{ label: 'a', amount: '100.00' }], total: '100.01' }).difference).toBe('-0.01')
    expect(reconcile({ rows: [{ label: 'a', amount: '-5' }, { label: 'b', amount: '5' }], total: '0' })).toMatchObject({ ok: true, sum: '0' })
  })

  it('tolerance is inclusive, exact and never negative', () => {
    const rows = [{ label: 'a', amount: '10.00' }]
    expect(reconcile({ rows, total: '10.01', tolerance: '0.01' }).ok).toBe(true)
    expect(reconcile({ rows, total: '10.02', tolerance: '0.01' }).ok).toBe(false)
    expect(reconcile({ rows, total: '10.02', tolerance: 1 }).ok).toBe(false) // 1 minor unit = 0.01
    expect(reconcile({ rows, total: '10.01', tolerance: 1 }).ok).toBe(true)
    expect(() => reconcile({ rows, total: '10', tolerance: '-0.01' })).toThrow(RangeError)
    expect(reconcile({ rows, total: '10.01', tolerance: '0.01' }).tolerance).toBe('0.01')
  })

  it('handles very large and very small amounts exactly', () => {
    const big = '123456789012345678901234567890.12'
    expect(reconcile({ rows: [{ label: 'a', amount: big }, { label: 'b', amount: '0.01' }], total: '123456789012345678901234567890.13' }).ok).toBe(true)
  })
})

describe('reconcile: amount types', () => {
  it('strings are major units, integers and bigints are minor units', () => {
    expect(reconcile({ rows: [{ label: 'a', amount: '10.50' }, { label: 'b', amount: 1050 }, { label: 'c', amount: 1050n }], total: '31.50' }).ok).toBe(true)
    expect(reconcile({ rows: [{ label: 'a', amount: 1000 }], total: 10 }, { minorUnitDigits: 2 }).ok).toBe(false) // total 10 minor = 0.10
    expect(reconcile({ rows: [{ label: 'a', amount: 1000 }], total: 1000 }, { minorUnitDigits: 0 })).toMatchObject({ ok: true, sum: '1000' })
  })

  it('rejects floats and non-finite numbers unless allowFloat', () => {
    expect(() => reconcile({ rows: [{ label: 'a', amount: 0.1 }], total: '0.1' })).toThrow(TypeError)
    expect(() => reconcile({ rows: [{ label: 'a', amount: Number.NaN }], total: '0' })).toThrow(TypeError)
    expect(() => reconcile({ rows: [{ label: 'a', amount: Infinity }], total: '0' }, { allowFloat: true })).toThrow(TypeError)
    expect(() => reconcile({ rows: [{ label: 'a', amount: 2 ** 53 }], total: '0' })).toThrow(TypeError) // not a safe integer
  })

  it('allowFloat reads every number as a major-unit decimal through its shortest text', () => {
    const r = reconcile({ rows: [{ label: 'a', amount: 0.1 }, { label: 'b', amount: 0.2 }], total: 0.3 }, { allowFloat: true })
    expect(r).toMatchObject({ ok: true, sum: '0.3' })
    expect(reconcile({ rows: [{ label: 'a', amount: 12 }], total: '12' }, { allowFloat: true }).ok).toBe(true)
    expect(reconcile({ rows: [{ label: 'a', amount: 1e-7 }], total: '0.0000001' }, { allowFloat: true }).ok).toBe(true)
    expect(reconcile({ rows: [{ label: 'a', amount: 1.5e21 }], total: '1500000000000000000000' }, { allowFloat: true }).ok).toBe(true)
  })

  it('rejects strings that are not exact decimals', () => {
    for (const bad of ['', '12.', '1e3', ' 5', '5 ', '0x10', 'NaN', '１２', '1,23', '1.234,50']) {
      expect(() => reconcile({ rows: [{ label: 'a', amount: bad }], total: '0' }), JSON.stringify(bad)).toThrow(TypeError)
    }
    expect(() => reconcile({ rows: [{ label: 'a', amount: null as never }], total: '0' })).toThrow(TypeError)
    expect(() => reconcile({ rows: [{ label: 'a', amount: {} as never }], total: '0' })).toThrow(TypeError)
    expect(() => reconcile({ rows: [{ label: 'a', amount: new Date() as never }], total: '0' })).toThrow(TypeError)
  })
})

describe('reconcile: input validation', () => {
  it('rejects empty, sparse and malformed inputs', () => {
    expect(() => reconcile({ rows: [], total: '0' })).toThrow(RangeError)
    expect(() => reconcile({ rows: new Array(2) as never, total: '0' })).toThrow(TypeError)
    expect(() => reconcile({ rows: 'abc' as never, total: '0' })).toThrow(TypeError)
    expect(() => reconcile({ rows: [5 as never], total: '0' })).toThrow(TypeError)
    expect(() => reconcile({ rows: [{ label: 5 as never, amount: '1' }], total: '1' })).toThrow(TypeError)
    expect(() => reconcile({ total: '0' } as never)).toThrow(TypeError)
    expect(() => reconcile({ rows: [{ label: 'a', amount: '1' }] } as never)).toThrow(TypeError)
    expect(() => reconcile(null as never)).toThrow(TypeError)
    expect(() => reconcile([] as never)).toThrow(TypeError)
  })

  it('rejects unknown keys so a typo does not turn a check off', () => {
    expect(() => reconcile({ rows: [{ label: 'a', amount: '1' }], total: '1', tolerence: '1' } as never)).toThrow(RangeError)
    expect(() => reconcile({ rows: [{ label: 'a', amount: '1' }], total: '1' }, { allowFloats: true } as never)).toThrow(RangeError)
    expect(() => reconcile({ rows: [{ label: 'a', amount: '1' }], total: '1' }, { minorUnitDigits: 9 })).toThrow(RangeError)
  })
})

describe('reconcileComponents', () => {
  it('adds named parts and compares to the total', () => {
    expect(reconcileComponents({ parts: { paid: '1000.00', reserve: '250.50' }, total: '1250.50' })).toMatchObject({
      ok: true, sum: '1250.50', rows: 2,
    })
    expect(reconcileComponents({ parts: { paid: 100000, reserve: 25050 }, total: 125050 }).ok).toBe(true)
    expect(reconcileComponents({ parts: { paid: '1', reserve: '2' }, total: '4', tolerance: '1' }).ok).toBe(true)
  })

  it('rejects empty or non-object parts and bad amounts', () => {
    expect(() => reconcileComponents({ parts: {}, total: '0' })).toThrow(RangeError)
    expect(() => reconcileComponents({ parts: [] as never, total: '0' })).toThrow(TypeError)
    expect(() => reconcileComponents({ parts: { a: 0.5 }, total: '0.5' })).toThrow(TypeError)
    expect(() => reconcileComponents({ parts: { a: '1' } } as never)).toThrow(TypeError)
  })

  it('reads own enumerable string keys only', () => {
    const parts = Object.create({ inherited: '99' }) as Record<string, string>
    parts['own'] = '1'
    expect(reconcileComponents({ parts, total: '1' }).ok).toBe(true)
    const withProto = JSON.parse('{"__proto__": "5", "x": "1"}') as Record<string, string>
    expect(reconcileComponents({ parts: withProto, total: '6' }).ok).toBe(true)
  })
})
