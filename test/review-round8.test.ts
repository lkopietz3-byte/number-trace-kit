import { afterEach, describe, expect, it } from 'vitest'
import { extractNumbers, reconcile, traceNumbers } from '../src/index.js'
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
