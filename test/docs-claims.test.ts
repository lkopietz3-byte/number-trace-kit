import { describe, expect, it } from 'vitest'
import readme from '../README.md?raw'
import method from '../METHOD.md?raw'

// Claims in the documentation that the field-trial review of the 0.1.0 release candidate found false or missing. Each row names
// its finding (first5:Fnn from the first pass, hunt:Fn from the hunt pass) and was seen failing before the text was fixed.

describe('first5:F01 and hunt:F3 the revision a figure was run at is the revision the documents name', () => {
  it('no document says the commits after the benchmark revision change documentation only', () => {
    for (const [name, text] of [['README.md', readme], ['METHOD.md', method]] as const) {
      expect(text, name).not.toMatch(/change documentation only/)
      // The rows that need the raw downloads say which revision they were run at and that they were not re-run.
      expect(text, name).toMatch(/b9a4713[^\n]*not re-run/)
    }
  })
})
