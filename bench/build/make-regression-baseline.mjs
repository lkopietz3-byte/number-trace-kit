#!/usr/bin/env node
// Developer script. Records what the kit does today on the committed RAGTruth excerpts (question answering and summaries),
// so test/field-regression.test.ts can fail when a change makes any of it worse.
//   npm run build && node bench/build/make-regression-baseline.mjs
// Run it again only on purpose, after a change that is meant to move these numbers, and say so in the commit.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readJsonl } from '../lib/jsonl.mjs'
import { evidenceFor } from '../lib/evidence.mjs'
import { RAGTRUTH_CONFIGS, runRagtruthConfig } from '../lib/ragtruth-run.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const kit = await import(pathToFileURL(join(here, '..', '..', 'dist', 'index.js')).href)
const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'))
const items = readJsonl(join(here, '..', 'data', 'ragtruth-field.jsonl'))
const manual = JSON.parse(readFileSync(join(here, '..', 'data', 'adjudication-manual.json'), 'utf8'))
const PASS = new Set(['traced', 'rounded', 'derived'])

const out = { note: 'Baseline for test/field-regression.test.ts: question answering and summary responses of the RAGTruth field corpus, read from the committed excerpts. Keys are "response id#character offset" of a kit token.', kitVersion: pkg.version, configs: {} }
for (const name of ['strict+markers', 'strict+structure', 'report+markers']) {
  const { rows } = runRagtruthConfig(kit, items, (it) => evidenceFor(it, null, 'excerpts'), RAGTRUTH_CONFIGS[name], manual)
  const key = (r, n) => `${r.id}#${n.start}`
  const toks = rows.flatMap((r) => r.numbers.map((n) => ({ r, n })))
  const honest = toks.filter(({ n }) => n.cls === 'HONEST' && n.status !== 'ignored')
  const errors = toks.filter(({ n }) => n.cls === 'ERROR' && n.status !== 'ignored')
  const honestResp = rows.filter((r) => r.stratum === 'C')
  const errorResp = rows.filter((r) => r.numbers.some((n) => n.cls === 'ERROR'))
  out.configs[name] = {
    responses: rows.length,
    honestTokens: honest.length,
    honestUntraced: honest.filter(({ n }) => n.status === 'untraced').map(({ r, n }) => key(r, n)),
    honestUnknown: honest.filter(({ n }) => n.status === 'unknown').map(({ r, n }) => key(r, n)),
    errorTokens: errors.length,
    errorCaught: errors.filter(({ n }) => n.status === 'untraced').length,
    errorPassed: errors.filter(({ n }) => PASS.has(n.status)).map(({ r, n }) => key(r, n)),
    honestResponses: honestResp.length,
    honestResponsesNotClean: honestResp.filter((r) => r.verdict !== 'clean').map((r) => r.id),
    errorResponses: errorResp.length,
    errorResponsesClean: errorResp.filter((r) => r.verdict === 'clean').map((r) => r.id),
  }
}
writeFileSync(join(here, '..', 'data', 'field-regression-baseline.json'), JSON.stringify(out, null, 1) + '\n')
for (const [k, c] of Object.entries(out.configs)) console.log(k, `honest untraced ${c.honestUntraced.length}/${c.honestTokens}, unknown ${c.honestUnknown.length}; error caught ${c.errorCaught}/${c.errorTokens}, passed ${c.errorPassed.length}; honest responses not clean ${c.honestResponsesNotClean.length}/${c.honestResponses}; error responses clean ${c.errorResponsesClean.length}/${c.errorResponses}`)
