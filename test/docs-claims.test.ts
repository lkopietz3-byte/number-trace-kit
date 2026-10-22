import { describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'
import type { TraceOptions } from '../src/index.js'
import readme from '../README.md?raw'
import method from '../METHOD.md?raw'
import engineering from '../ENGINEERING.md?raw'
import benchReadme from '../bench/README.md?raw'

// Claims in the documentation that the field-trial review of the 0.1.0 release candidate found false or missing. Each row names
// its finding (first5:Fnn from the first pass, hunt:Fn from the hunt pass) and was seen failing before the text was fixed.

type Evidence = Parameters<typeof traceNumbers>[1]
type Output = Parameters<typeof traceNumbers>[0]
const trace = (output: Output, evidence: Evidence, options?: TraceOptions): ReturnType<typeof traceNumbers> =>
  traceNumbers(output, evidence, options)

describe('first5:F01 and hunt:F3 the revision a figure was run at is the revision the documents name', () => {
  it('no document says the commits after the benchmark revision change documentation only', () => {
    for (const [name, text] of [['README.md', readme], ['METHOD.md', method]] as const) {
      expect(text, name).not.toMatch(/change documentation only/)
      // The figures that need the raw downloads were run at the release head, so no document says they were not re-run.
      expect(text, name).toMatch(/f98944a/)
      expect(text, name).not.toMatch(/b9a4713[^\n]*not re-run/)
      expect(text, name).not.toMatch(/not re-run at the release head/)
    }
  })
})

describe('first5:F08, hunt:F4 and hunt:F6 the size figures are the measured ones', () => {
  it('the candidate-count examples are the measured counts', () => {
    expect(readme).toMatch(/71,400/)
    expect(readme).toMatch(/57,200/)
    expect(readme).not.toMatch(/78,000/)
    expect(readme).not.toMatch(/about 8 microseconds/)
  })

  it('the memory figure covers amounts and percents, not only bare numbers', () => {
    expect(readme).toMatch(/1\.5 GB/)
    expect(engineering).not.toMatch(/about a kilobyte per number/)
  })
})

describe('first5:F02, F03, F05, F10, F11 and F13 the README tells a reader what the review found missing', () => {
  const lead = readme.slice(0, readme.indexOf('## Install'))
  const glance = readme.slice(0, readme.indexOf('## What it does'))

  it('first5:F02 the lead says that numbers written as words are not read', () => {
    expect(lead).toMatch(/numbers written as words/)
  })

  it('first5:F03 the README says what the invoice quantity form does', () => {
    expect(readme).toMatch(/3 x Widget A/)
  })

  it('first5:F05 a copy of the extractNumbers array has no record of what was skipped, and the README says so where it claims nothing is silent', () => {
    const text = 'Revenue $5, 12foo and 7 units'
    const evidence = 'Revenue $5 and 7 units'
    const tokens = extractNumbers(text)
    expect(trace(text, evidence).verdict).toBe('unknown')
    expect(trace(tokens, evidence).verdict).toBe('unknown')
    expect(trace(tokens.filter(() => true), evidence).verdict).toBe('clean')
    expect(readme).toMatch(/Nothing the kit passes over is silent[^\n]*copy/)
    expect(method).toMatch(/copy of the array/)
  })

  it('first5:F10 the README says that evidence must be plain text', () => {
    expect(readme).toMatch(/plain text/i)
    expect(readme).toMatch(/&nbsp;/)
  })

  it('first5:F11 the README says what a token is, and which TypeScript needs what', () => {
    expect(readme).toMatch(/hasOwnProperty/)
    expect(readme).toMatch(/TS1479/)
  })

  it('first5:F13 the lead pairs the favorable honest-number figure with the less favorable one', () => {
    expect(glance).toMatch(/7\.6%/)
  })
})

describe('first5:F09 bench/README.md matches the package README and works from a fresh clone as written', () => {
  it('names the README section as it is called and says to install first', () => {
    expect(readme).toMatch(/^## Accuracy on real data$/m)
    expect(benchReadme).not.toMatch(/Accuracy on real output/)
    expect(benchReadme).toMatch(/npm ci/)
    expect(benchReadme).not.toMatch(/lists only `dist`/)
  })
})
