import { afterEach, describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'

// Regression rows from the release review of the whole branch.

describe('the digit limit applies after magnitude expansion', () => {
  it('gives the same verdict whether text or extracted tokens are passed', () => {
    const s = '1'.repeat(60) + 'e1'
    expect(traceNumbers(s, s).verdict).not.toBe('clean')
    const viaTokens = traceNumbers(extractNumbers(s), extractNumbers(s)).verdict
    expect(traceNumbers(s, s).verdict).toBe(viaTokens)
  })
})

describe('an inherited property on Object.prototype', () => {
  const proto = Object.prototype as unknown as Record<string, unknown>
  afterEach(() => {
    delete proto['97']
  })
  it('is never read as a currency symbol', () => {
    proto['97'] = 'USD'
    const r = traceNumbers('$5', 'a5')
    expect(r.verdict).toBe('untraced')
    expect(extractNumbers('a5')[0]?.currency).toBeUndefined()
  })
})

describe('a reversed derivation does not hide a permitted one', () => {
  it('finds the sum even when an earlier lookup only finds a reversed difference', () => {
    const r = traceNumbers('+7', '10;3;2 kg;5 kg', { derivations: ['difference', 'sum'] })
    expect(r.verdict).toBe('clean')
  })
})
