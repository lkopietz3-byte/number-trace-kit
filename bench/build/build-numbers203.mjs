#!/usr/bin/env node
// One-time conversion of the earlier 203-item number benchmark into the committed data file.
//   node bench/build/build-numbers203.mjs --items <items.jsonl of the earlier benchmark> --out bench/data/numbers-203.jsonl
// TAT-QA (CC BY 4.0) and FinQA (MIT) items are copied as they are. RAGTruth items keep the model's answer and labels,
// and their evidence becomes number-centered excerpts.
import { readFileSync, writeFileSync } from 'node:fs'
import { windowsOf } from '../lib/ragtruth-raw.mjs'
import { evidenceHash } from '../lib/ragtruth-derive.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
const out = []
for (const line of readFileSync(args.items, 'utf8').split('\n')) {
  if (!line.trim()) continue
  const it = JSON.parse(line)
  if (it.meta.half !== 'numbers') continue
  if (it.source === 'RAGTruth') {
    const full = it.evidence
    it.meta = { ...it.meta, evidenceForm: 'excerpts', evidenceSha256: evidenceHash(full) }
    it.evidence = full.map((d) => ({ id: d.id, text: windowsOf(d.text) }))
  }
  out.push(it)
}
writeFileSync(args.out, out.map((o) => JSON.stringify(o)).join('\n') + '\n')
console.log(`wrote ${out.length} items to ${args.out}`)
