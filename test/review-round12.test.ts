import { describe, expect, it } from 'vitest'
import { traceNumbers } from '../src/index.js'
import type { TraceOptions } from '../src/index.js'

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

  it('hunt:F1 the same year in the evidence, a separated count and a year outside the window are unchanged', () => {
    expect(statuses('Founded in 1879.', 'Founded in 1879 with 3 offices.', report)).toEqual(['1879:traced'])
    expect(statuses('It has 1,500 units.', 'It has 1,000 units and 500 units.', report)).toEqual(['1,500:derived'])
    expect(statuses('It has 999 units.', 'It has 900 units and 99 units.', report)).toEqual(['999:derived'])
    expect(statuses('It has 1999 units.', 'It has 1996 units and 3 units.', report)).toEqual(['1999:untraced'])
  })
})

