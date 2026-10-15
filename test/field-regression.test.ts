import { describe, expect, it } from 'vitest'
import { traceNumbers } from '../src/index.js'
import { RAGTRUTH_CONFIGS, runRagtruthConfig } from '../bench/lib/ragtruth-run.mjs'
import type { RagtruthRow } from '../bench/lib/ragtruth-run.mjs'
import fieldText from '../bench/data/ragtruth-field.jsonl?raw'
import manualText from '../bench/data/adjudication-manual.json?raw'
import baselineText from '../bench/data/field-regression-baseline.json?raw'

// Real model answers (RAGTruth, MIT) with annotator labels, read from the committed number-centered excerpts of the source
// text. This is the question answering and summary part of the field corpus; `npm run bench` runs all of it.
// Baseline: what the kit did when bench/data/field-regression-baseline.json was recorded. A change may only make it better.
// To record a better baseline on purpose: npm run build && node bench/build/make-regression-baseline.mjs, and say why in the commit.

interface FieldItem { id: string; task: string; evidence: { form: string; docs: { id: string; text: string }[] } | null }
interface Baseline {
  honestTokens: number
  honestUntraced: string[]
  honestUnknown: string[]
  errorTokens: number
  errorCaught: number
  errorPassed: string[]
  honestResponsesNotClean: string[]
  errorResponsesClean: string[]
  honestResponses: number
  errorResponses: number
}

const items = fieldText.trim().split('\n').map((line) => JSON.parse(line) as FieldItem)
const manual = JSON.parse(manualText) as Record<string, object>
const baseline = (JSON.parse(baselineText) as { configs: Record<string, Baseline> }).configs

const PASS = new Set(['traced', 'rounded', 'derived'])
const evidenceOf = (item: FieldItem) => (item.evidence ? { docs: item.evidence.docs.map((d) => ({ id: d.id, text: d.text })), form: 'excerpts' } : null)

function measure(config: string) {
  const options = RAGTRUTH_CONFIGS[config]
  if (options === undefined) throw new Error(`unknown config ${config}`)
  const { rows } = runRagtruthConfig({ traceNumbers }, items, evidenceOf, options, manual)
  const keyed = (rs: RagtruthRow[], pick: (cls: string, status: string) => boolean) =>
    rs.flatMap((r) => r.numbers.filter((n) => n.status !== 'ignored' && pick(n.cls, n.status)).map((n) => `${r.id}#${n.start}`))
  return {
    rows,
    honestUntraced: keyed(rows, (c, s) => c === 'HONEST' && s === 'untraced'),
    honestUnknown: keyed(rows, (c, s) => c === 'HONEST' && s === 'unknown'),
    errorPassed: keyed(rows, (c, s) => c === 'ERROR' && PASS.has(s)),
    errorCaught: keyed(rows, (c, s) => c === 'ERROR' && s === 'untraced').length,
    honestTokens: keyed(rows, (c) => c === 'HONEST').length,
    errorTokens: keyed(rows, (c) => c === 'ERROR').length,
    honestResponsesNotClean: rows.filter((r) => r.stratum === 'C' && r.verdict !== 'clean').map((r) => r.id),
    errorResponsesClean: rows.filter((r) => r.numbers.some((n) => n.cls === 'ERROR') && r.verdict === 'clean').map((r) => r.id),
    errorResponses: rows.filter((r) => r.numbers.some((n) => n.cls === 'ERROR')).length,
  }
}

describe('field regression: real model answers against their source text (field-regression:)', () => {
  for (const config of ['strict+markers', 'strict+structure', 'report+markers']) {
    describe(config, () => {
      const base = baseline[config]
      if (base === undefined) throw new Error(`no baseline for ${config}`)
      const now = measure(config)

      it('reads the same number of numbers as the baseline did (otherwise the baseline is stale)', () => {
        expect(now.honestTokens).toBe(base.honestTokens)
        expect(now.errorTokens).toBe(base.errorTokens)
        expect(now.errorResponses).toBe(base.errorResponses)
      })

      it('field-regression: no unsupported number passes that did not pass before', () => {
        const newPasses = now.errorPassed.filter((k) => !base.errorPassed.includes(k))
        expect(newPasses).toEqual([])
        expect(now.errorPassed.length).toBeLessThanOrEqual(base.errorPassed.length)
      })

      it('field-regression: the unsupported numbers caught do not drop', () => {
        expect(now.errorCaught).toBeGreaterThanOrEqual(base.errorCaught)
      })

      it('field-regression: no honest number is newly flagged untraced', () => {
        const newFlags = now.honestUntraced.filter((k) => !base.honestUntraced.includes(k))
        expect(newFlags).toEqual([])
      })

      it('field-regression: no honest number newly becomes unknown, and no honest response newly stops being clean', () => {
        expect(now.honestUnknown.filter((k) => !base.honestUnknown.includes(k))).toEqual([])
        expect(now.honestResponsesNotClean.filter((id) => !base.honestResponsesNotClean.includes(id))).toEqual([])
      })

      it('field-regression: no response with an unsupported number newly comes back clean', () => {
        expect(now.errorResponsesClean.filter((id) => !base.errorResponsesClean.includes(id))).toEqual([])
      })
    })
  }

  it('strict keeps the whole claim: no unsupported number passes and every one is caught (66 of 66 in this part of the corpus)', () => {
    const now = measure('strict+markers')
    expect(now.errorTokens).toBe(66)
    expect(now.errorPassed).toEqual([])
    expect(now.errorCaught).toBe(66)
  })
})
