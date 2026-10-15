#!/usr/bin/env node
// Developer script. Rebuilds the committed RAGTruth-derived files from the raw download, or checks that they match it.
//   node bench/build/derive.mjs --raw <dir with response.jsonl and source_info.jsonl> --out bench/data   (write)
//   node bench/build/derive.mjs --raw <dir> --check                                                    (compare only)
// The selections are the id lists in bench/data/selection-*.json. Labels come from the dataset's own annotations and the source text.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRagtruth } from '../lib/ragtruth-raw.mjs'
import { deriveItem } from '../lib/ragtruth-derive.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []))
if (!args.raw) { console.error('usage: node bench/build/derive.mjs --raw <dir> [--out <dir> | --check]'); process.exit(2) }
const dataDir = resolve(args.out ?? join(here, '..', 'data'))
const raw = loadRagtruth(resolve(args.raw))
raw.byId = new Map(raw.responses.map((r) => [r.id, r]))

const SETS = [
  { file: 'ragtruth-field.jsonl', selection: 'selection-field.json', set: 'field' },
  { file: 'ragtruth-holdout.jsonl', selection: 'selection-holdout.json', set: 'holdout' },
]
let bad = 0
for (const s of SETS) {
  let ids
  try { ids = JSON.parse(readFileSync(join(here, '..', 'data', s.selection), 'utf8')).ids } catch { continue }
  const lines = ids.map((id) => {
    const r = raw.byId.get(id)
    return JSON.stringify(deriveItem(r, raw.sources.get(r.source_id), raw.rawSource.get(r.source_id), s.set))
  })
  const text = lines.join('\n') + '\n'
  if (args.check) {
    const have = readFileSync(join(dataDir, s.file), 'utf8')
    const same = have === text
    console.log(`${s.file}: ${same ? 'matches the raw download' : 'DIFFERS from the raw download'} (${ids.length} items)`)
    if (!same) bad++
  } else {
    writeFileSync(join(dataDir, s.file), text)
    console.log(`wrote ${s.file}: ${ids.length} items`)
  }
}
process.exit(bad ? 1 : 0)
