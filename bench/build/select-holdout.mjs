#!/usr/bin/env node
// Developer script. Draws the fresh holdout from the RAGTruth train split, which the kit was never run on.
//   node bench/build/select-holdout.mjs --raw <dir with response.jsonl and source_info.jsonl>
// Rule (written before any kit run): train split, quality "good", the answer has a digit, not one of the response ids or
// sources used by the field corpus or the 203-item benchmark. Per task (QA, Summary, Data2txt) draw responses whose annotators
// marked a number that is absent from the source (E: 70 QA, 25 Summary, 40 Data2txt) and 25 whose annotators marked nothing at all (C),
// with seed 20261014. The first draw was 25 of each; labeling showed that most QA and many Data2txt E items were marked only on
// list markers or clock formats, so the E draws were enlarged (the first 25 stay the same). No kit run happened in between.
// The labels it writes are the annotators' (span offsets), nothing from the kit.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRagtruth, classifySpans, sourceDocs } from '../lib/ragtruth-raw.mjs'
import { stratumOf } from '../lib/ragtruth-derive.mjs'
import { sample } from '../lib/stats.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
const raw = loadRagtruth(resolve(args.raw))
const dataDir = join(here, '..', 'data')
const SEED = 20261014
const PER = { E: { QA: 70, Summary: 25, Data2txt: 40 }, C: { QA: 25, Summary: 25, Data2txt: 25 } }

const used = new Set(JSON.parse(readFileSync(join(dataDir, 'selection-field.json'), 'utf8')).ids)
const usedSources = new Set()
for (const line of readFileSync(join(dataDir, 'numbers-203.jsonl'), 'utf8').split('\n')) {
  if (!line.trim()) continue
  const id = JSON.parse(line).meta.rag_response_id
  if (id) used.add(id)
}
const byId = new Map(raw.responses.map((r) => [r.id, r]))
for (const id of used) usedSources.add(byId.get(id).source_id)

const pools = new Map()
for (const r of raw.responses) {
  if (r.split !== 'train' || r.quality !== 'good') continue
  if (used.has(r.id) || usedSources.has(r.source_id)) continue
  if (!/\d/.test(r.response)) continue
  const src = raw.sources.get(r.source_id)
  const docs = sourceDocs(src, raw.rawSource.get(r.source_id))
  const k = stratumOf(classifySpans(r, docs), r)
  if (k !== 'E' && k !== 'C') continue
  const key = `${src.task_type}|${k}`
  if (!pools.has(key)) pools.set(key, [])
  pools.get(key).push(r.id)
}
const ids = []
const counts = {}
for (const task of ['QA', 'Summary', 'Data2txt']) for (const k of ['E', 'C']) {
  const pool = (pools.get(`${task}|${k}`) ?? []).sort((a, b) => Number(a) - Number(b))
  const picked = sample(pool, PER[k][task], SEED)
  counts[`${task}|${k}`] = { pool: pool.length, picked: picked.length }
  ids.push(...picked)
}
writeFileSync(join(dataDir, 'selection-holdout.json'), JSON.stringify({
  note: 'Response ids of the fresh holdout (RAGTruth train split). Seed 20261014, drawn by the rule in bench/build/select-holdout.mjs before any kit run.',
  seed: SEED, counts, ids,
}, null, 1))
console.log(JSON.stringify(counts, null, 1), ids.length)
