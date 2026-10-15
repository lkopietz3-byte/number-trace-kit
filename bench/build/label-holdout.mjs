#!/usr/bin/env node
// Developer script. Writes the holdout labels BEFORE the kit sees the holdout.
//   node bench/build/label-holdout.mjs
// Label rule (written down here, kit never consulted):
//   C   the annotators marked nothing in the response.
//   E   the annotators marked a span, and at least one number inside it is absent from the source and is not explained by the
//       structure and format rules (list marker, passage or step reference, clock time that equals a time in the source,
//       unit-conversion pair). The numbers are found by bench/lib/tokens.mjs and judged by bench/lib/ragtruth-score.mjs, rule layer only.
//   amb the annotators marked a number span but every absent number in it is explained by those rules, so the item is left out of scoring.
//   Everything else (non-numeric annotations only, annotated numbers that are present in the source) is not in the sample.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonl } from '../lib/jsonl.mjs'
import { adjudicate } from '../lib/ragtruth-score.mjs'
import { findNumbers } from '../lib/tokens.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const items = readJsonl(join(here, '..', 'data', 'ragtruth-holdout.jsonl'))
const out = []
const tally = {}
for (const it of items) {
  const toks = findNumbers(it.answer).map((t) => ({ ...t, j: adjudicate(it, t, {}, null) }))
  const errors = toks.filter((t) => t.j.cls === 'ERROR').map((t) => ({ start: t.start, end: t.end, raw: t.raw }))
  let label
  if (it.stratum === 'C') label = 'C'
  else if (errors.length) label = 'E'
  else label = 'amb'
  out.push({ id: it.id, task: it.task, label, annotatorStratum: it.stratum, errorTokens: errors })
  const k = `${it.task}|${label}`
  tally[k] = (tally[k] ?? 0) + 1
}
writeFileSync(join(here, '..', 'data', 'holdout-labels.jsonl'), out.map((o) => JSON.stringify(o)).join('\n') + '\n')
console.log(JSON.stringify(tally, null, 1))
console.log('labeled (E or C):', out.filter((o) => o.label !== 'amb').length, 'of', out.length)
