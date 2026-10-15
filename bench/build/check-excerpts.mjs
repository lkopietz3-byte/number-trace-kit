#!/usr/bin/env node
// Developer script. Shows that the committed number-centered excerpts give the kit the same verdicts as the full source text.
//   npm run build && node bench/build/check-excerpts.mjs --raw <dir with response.jsonl and source_info.jsonl>
// For every question answering and summary response of the field corpus and the holdout, and for every setting of the field corpus,
// it runs the kit once on the full evidence and once on the excerpts and counts the numbers whose status, or the answers whose
// verdict, differ. Exit code 1 when any differ.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readJsonl } from '../lib/jsonl.mjs'
import { evidenceFor, openRagtruthCache } from '../lib/evidence.mjs'
import { RAGTRUTH_CONFIGS, runRagtruthConfig } from '../lib/ragtruth-run.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
const raw = openRagtruthCache(args.raw ? resolve(args.raw) : null)
if (!raw) { console.error('usage: node bench/build/check-excerpts.mjs --raw <dir with response.jsonl and source_info.jsonl>'); process.exit(2) }
const kit = await import(pathToFileURL(join(here, '..', '..', 'dist', 'index.js')).href)
const manual = JSON.parse(readFileSync(join(here, '..', 'data', 'adjudication-manual.json'), 'utf8'))

let bad = 0
for (const file of ['ragtruth-field.jsonl', 'ragtruth-holdout.jsonl']) {
  const items = readJsonl(join(here, '..', 'data', file)).filter((it) => it.evidence)
  for (const [name, options] of Object.entries(RAGTRUTH_CONFIGS)) {
    const full = runRagtruthConfig(kit, items, (it) => evidenceFor(it, raw, 'full'), options, manual).rows
    const part = runRagtruthConfig(kit, items, (it) => evidenceFor(it, null, 'excerpts'), options, manual).rows
    let tokens = 0
    let statusDiffs = 0
    let verdictDiffs = 0
    full.forEach((r, i) => {
      if (r.verdict !== part[i].verdict) verdictDiffs++
      if (r.numbers.length !== part[i].numbers.length) statusDiffs++
      r.numbers.forEach((n, j) => {
        tokens++
        const m = part[i].numbers[j]
        if (!m || m.status !== n.status || m.start !== n.start) statusDiffs++
      })
    })
    console.log(`${file} ${name}: ${full.length} answers, ${tokens} numbers, ${statusDiffs} status differences, ${verdictDiffs} verdict differences`)
    bad += statusDiffs + verdictDiffs
  }
}
process.exit(bad ? 1 : 0)
