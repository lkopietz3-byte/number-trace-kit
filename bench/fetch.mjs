#!/usr/bin/env node
// Downloads the raw third-party data that bench/ cannot commit, checks every file against the pinned SHA-256 in SOURCES.json,
// and writes it into the cache folder (default bench/.cache, git-ignored). Downloaded data is untrusted: this script only
// reads bytes and parses JSON later; nothing from the downloads is ever executed.
//
//   node bench/fetch.mjs                      show what would be downloaded, with sizes and licenses (no network)
//   node bench/fetch.mjs --yes                download everything (about 37 MB RAGTruth + 4 MB FinanceBench)
//   node bench/fetch.mjs --yes --only ragtruth | financebench
//   node bench/fetch.mjs --yes --dir <folder>      use another cache folder
//   node bench/fetch.mjs --from <folder> --yes     copy from a local mirror with the same layout instead of the network
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from './lib/jsonl.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []))
const dir = resolve(args.dir ?? process.env.BENCH_CACHE ?? join(here, '.cache'))
const sources = JSON.parse(readFileSync(join(here, 'SOURCES.json'), 'utf8')).sources.filter((s) => s.fetched)
const wanted = sources.filter((s) => !args.only || s.name.toLowerCase().startsWith(String(args.only).toLowerCase()))
if (wanted.length === 0) { console.error(`no source matches --only ${args.only}`); process.exit(2) }

let total = 0
for (const s of wanted) {
  const bytes = s.fetched.reduce((a, f) => a + f.bytes, 0)
  total += bytes
  console.log(`${s.name}: ${s.fetched.length} files, ${(bytes / 1e6).toFixed(1)} MB, pinned commit ${s.pinnedCommit.slice(0, 12)}`)
  console.log(`  license: ${s.license}`)
}
console.log(`cache folder: ${dir}`)
if (args.yes !== 'true') { console.log(`\nNothing was downloaded (${(total / 1e6).toFixed(1)} MB in all). Re-run with --yes to fetch and verify.`); process.exit(0) }

let failed = 0
for (const s of wanted) for (const f of s.fetched) {
  const dest = join(dir, f.dest)
  if (existsSync(dest) && sha256(readFileSync(dest)) === f.sha256) { console.log(`ok (already there)  ${f.dest}`); continue }
  let data
  try {
    if (args.from) data = readFileSync(join(resolve(args.from), f.dest))
    else {
      const res = await fetch(f.url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      data = Buffer.from(await res.arrayBuffer())
    }
  } catch (e) {
    console.error(`FAILED   ${f.dest}: ${String(e?.message ?? e)}`)
    failed++
    continue
  }
  if (data.length !== f.bytes || sha256(data) !== f.sha256) {
    console.error(`FAILED   ${f.dest}: the bytes are not the pinned file (got ${data.length} bytes, sha256 ${sha256(data).slice(0, 16)}...). Nothing was written for it.`)
    failed++
    continue
  }
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  if (args.from) copyFileSync(join(resolve(args.from), f.dest), tmp)
  else writeFileSync(tmp, data)
  renameSync(tmp, dest)
  console.log(`verified ${f.dest}`)
}
process.exit(failed ? 1 : 0)
