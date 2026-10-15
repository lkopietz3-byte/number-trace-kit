#!/usr/bin/env node
// npm run bench  (builds the package first, then runs this)
//
// Prints false-fail, catch and false-pass rates with denominators and 95% intervals, on four bodies of data:
//   1. the labeled number benchmark (203 items, committed)
//   2. the RAGTruth field corpus (289 real model answers; the committed excerpts cover question answering and summaries,
//      the raw download adds data-to-text and the full evidence)
//   3. FinanceBench (10-K questions; CC BY-NC, so it needs `npm run bench:fetch` and nothing of it is committed)
//   4. the fresh holdout (150 labeled RAGTruth answers the kit had never seen) with the head-to-head against plain checkers
// A section that cannot run says NOT_RUN and why. Nothing is hidden when a number is bad.
//
//   node bench/run.mjs [--only labeled,field,financebench,holdout] [--cache <dir>] [--evidence auto|excerpts]
//                      [--verbose] [--json <file>]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readJsonl } from './lib/jsonl.mjs'
import { BENCH203_CONFIGS, printBench203, runBench203, summarizeBench203 } from './lib/bench203.mjs'
import { evidenceFor, openRagtruthCache } from './lib/evidence.mjs'
import { RAGTRUTH_CONFIGS, printRagtruth, runRagtruthConfig, summarizeRagtruth } from './lib/ragtruth-run.mjs'
import { FB_CONFIGS, buildFinanceBenchItems, calibrateScales, openFinanceBenchCache, runFinanceBench, summarizeFinanceBench } from './lib/financebench.mjs'
import { BASELINES } from './lib/baselines.mjs'
import { baselineOutcome, kitOutcome, printHoldout, scoreHoldout, verifyFrozen } from './lib/holdout.mjs'
import { fmt } from './lib/stats.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []))
const only = args.only ? String(args.only).split(',') : ['labeled', 'field', 'financebench', 'holdout']
const verbose = args.verbose === 'true'
const cache = resolve(args.cache ?? process.env.BENCH_CACHE ?? join(here, '.cache'))
const evidenceMode = args.evidence ?? 'auto'

const distPath = join(here, '..', 'dist', 'index.js')
if (!existsSync(distPath)) { console.error('dist/ is missing. Run `npm run build` first (or use `npm run bench`, which builds).'); process.exit(2) }
const kit = await import(pathToFileURL(distPath).href)
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

const result = { kit: `${pkg.name} ${pkg.version}`, node: process.version, icu: process.versions.icu, sections: {} }
console.log(`${pkg.name} ${pkg.version} | node ${process.version} (ICU ${process.versions.icu}) | cache ${cache}`)
const raw = openRagtruthCache(join(cache, 'ragtruth'))
const fbCache = openFinanceBenchCache(join(cache, 'financebench'))
console.log(`raw RAGTruth download: ${raw ? 'present (full evidence)' : 'not present (committed excerpts only; run `npm run bench:fetch` for the rest)'}`)
console.log(`raw FinanceBench download: ${fbCache ? 'present' : 'not present'}`)

const manual = JSON.parse(readFileSync(join(here, 'data', 'adjudication-manual.json'), 'utf8'))
const evidenceOf = (item) => evidenceFor(item, evidenceMode === 'excerpts' ? null : raw, evidenceMode === 'excerpts' ? 'excerpts' : 'auto')

// ------------------------------------------------------------------ 1. labeled benchmark
if (only.includes('labeled')) {
  console.log('\n==================== 1. Labeled number benchmark (203 items; 103 honest, 100 with one error) ====================')
  console.log('Built for this kit from TAT-QA and FinQA tables and RAGTruth answers; the planted errors are programmatic edits, so it flatters the kit.')
  const items = readJsonl(join(here, 'data', 'numbers-203.jsonl'))
  const section = {}
  for (const [name, options] of Object.entries(BENCH203_CONFIGS)) {
    const { rows, cpuMs } = runBench203(kit, items, options)
    const s = summarizeBench203(rows)
    printBench203(name, s, cpuMs, '38 RAGTruth items use number-centered excerpts')
    if (verbose) for (const r of rows.filter((x) => (x.planted ? !x.flagged : x.flagged))) console.log(`     ${r.planted ? 'NOT FLAGGED' : 'FALSE FAIL'} ${r.id} ${r.planted ?? 'honest'} ${r.family} verdict ${r.verdict}`)
    section[name] = s
  }
  result.sections.labeled = section
}

// ------------------------------------------------------------------ 2. RAGTruth field corpus
if (only.includes('field')) {
  console.log('\n==================== 2. RAGTruth field corpus (289 real model answers, annotator labels) ====================')
  const items = readJsonl(join(here, 'data', 'ragtruth-field.jsonl'))
  const section = {}
  const skipped = items.filter((it) => !evidenceOf(it)).length
  if (skipped) console.log(`${skipped} of ${items.length} responses need the raw download for their evidence (data-to-text) and are NOT_RUN here.`)
  for (const [name, options] of Object.entries(RAGTRUTH_CONFIGS)) {
    const { rows, counters } = runRagtruthConfig(kit, items, evidenceOf, options, manual)
    const s = summarizeRagtruth(rows)
    const forms = [...new Set(rows.map((r) => r.form))].join('+')
    printRagtruth(name, s, forms)
    if (counters.unseenRun) console.log(`  note: ${counters.unseenRun} token digit runs were not in the stored run table`)
    if (verbose) for (const r of rows) for (const n of r.numbers) if ((n.cls === 'ERROR' && ['traced', 'rounded', 'derived'].includes(n.status)) || (n.cls === 'HONEST' && n.status === 'untraced')) console.log(`     ${n.cls === 'ERROR' ? 'FALSE PASS' : 'FALSE FAIL'} ${r.id} ${JSON.stringify(n.raw)} ${n.status}`)
    section[name] = { evidence: forms, ...s }
  }
  console.log('\nLabel layers: the rule layer (span offsets and the frozen digit rule) never saw the kit. Some hand judgements in data/adjudication-manual.json were written after the kit\'s verdicts were seen; they are marked post_kit.')
  result.sections.field = section
}

// ------------------------------------------------------------------ 3. FinanceBench
if (only.includes('financebench')) {
  console.log('\n==================== 3. FinanceBench (10-K questions, human-labeled model answers) ====================')
  if (!fbCache) {
    console.log('NOT_RUN: FinanceBench is CC BY-NC and is not committed. `npm run bench:fetch -- --only financebench --yes` downloads it into the cache.')
    result.sections.financebench = { notRun: 'raw download not present' }
  } else {
    const items = buildFinanceBenchItems(fbCache)
    const scales = calibrateScales(kit, items)
    const section = {}
    for (const [name, options] of Object.entries(FB_CONFIGS)) {
      const { rows, cpuMs } = runFinanceBench(kit, items, scales, options)
      const s = summarizeFinanceBench(rows)
      section[name] = s
      console.log(`\n--- FinanceBench | ${name} (each filing page read as printed and again at its statement scale) | ${s.items} answers | cpu ${Math.round(cpuMs)} ms`)
      const line = (label, t) => console.log(`  ${label.padEnd(58)} clean ${fmt(t.clean.k, t.clean.n)}; untraced ${t.untraced.k}; unknown ${t.unknown.k}`)
      line('correct answers with at most 4 numbers', s.correctConcise)
      line('correct answers that work through more than 4 numbers', s.correctWorked)
      line('answers whose headline number is wrong (false pass = clean)', s.wrongHeadline)
    }
    console.log('\nThe statement scale per filing is calibrated from the answers\' currency numbers, without labels; it is optimistic. Labels are the dataset\'s human Correct/Incorrect plus a script that checks the answer\'s headline number against the gold value.')
    result.sections.financebench = section
  }
}

// ------------------------------------------------------------------ 4. fresh holdout and head-to-head
if (only.includes('holdout')) {
  console.log('\n==================== 4. Fresh holdout and head-to-head (RAGTruth train split, labeled before the kit ran) ====================')
  const frozen = verifyFrozen(here)
  console.log(frozen.changed.length ? `WARNING: frozen files changed since the labels were frozen: ${frozen.changed.join(', ')}` : `Frozen label files unchanged (${frozen.files} hashes in data/FROZEN-holdout.sha256 match).`)
  const items = new Map(readJsonl(join(here, 'data', 'ragtruth-holdout.jsonl')).map((it) => [it.id, it]))
  const labels = readJsonl(join(here, 'data', 'holdout-labels.jsonl'))
  const labeled = labels.filter((l) => l.label !== 'amb')
  console.log(`${labeled.length} labeled responses (${labeled.filter((l) => l.label === 'E').length} with an unsupported number, ${labeled.filter((l) => l.label === 'C').length} with no annotation); ${labels.length - labeled.length} drawn responses were left out as ambiguous before scoring.`)
  const KIT = { 'kit strict': { preset: 'strict' }, 'kit strict+structure': { preset: 'strict', ignoreStructure: true }, 'kit report': { preset: 'report' }, 'kit report+structure': { preset: 'report', ignoreStructure: true } }
  const subsets = [{ name: raw && evidenceMode !== 'excerpts' ? 'all tasks, full evidence' : 'question answering and summaries, committed excerpts', mode: evidenceMode, tasks: raw && evidenceMode !== 'excerpts' ? null : ['QA', 'Summary'] }]
  if (raw && evidenceMode !== 'excerpts') subsets.push({ name: 'question answering and summaries, committed excerpts only (what runs offline)', mode: 'excerpts', tasks: ['QA', 'Summary'] })
  const section = {}
  for (const sub of subsets) {
    const sel = labeled.filter((l) => !sub.tasks || sub.tasks.includes(l.task))
    console.log(`\n--- holdout: ${sub.name} | ${sel.length} labeled responses`)
    const entries = (run) => sel.map((l) => {
      const item = items.get(l.id)
      const ev = evidenceFor(item, sub.mode === 'excerpts' ? null : raw, sub.mode === 'excerpts' ? 'excerpts' : 'auto')
      return { id: l.id, task: l.task, label: l.label, errorTokens: l.errorTokens, answer: item.answer, outcome: run(item, ev.docs) }
    })
    const subsection = {}
    for (const [name, options] of Object.entries(KIT)) subsection[name] = scoreHoldout(entries((item, docs) => kitOutcome(kit, item, docs, options)))
    for (const name of Object.keys(BASELINES)) subsection[name] = scoreHoldout(entries((item, docs) => baselineOutcome(name, item, docs)))
    for (const [name, s] of Object.entries(subsection)) printHoldout(name, s)
    const lead = subsection['kit strict+structure']
    console.log(`\n  every miss of "kit strict+structure" (responses with an unsupported number that were not flagged): ${lead.misses.length}`)
    for (const m of lead.misses) console.log(`    MISS ${m.id} (${m.task}) verdict ${m.verdict}; annotated number in: ${m.errorTokens.map((t) => JSON.stringify(t)).join(' | ')}${m.unknown.length ? `; unknown: ${m.unknown.join(', ')}` : ''}`)
    console.log(`  every false flag of "kit strict+structure" (clean responses flagged): ${lead.wrongFlags.length}`)
    for (const w of lead.wrongFlags) console.log(`    FLAG ${w.id} (${w.task}) ${w.flagged.map((f) => `${JSON.stringify(f.raw)} ${f.why} in ${JSON.stringify(f.context)}`).join(' ; ')}`)
    if (verbose) for (const name of Object.keys(subsection).filter((n) => n !== 'kit strict+structure')) console.log(`  ${name}: misses ${subsection[name].misses.map((m) => m.id).join(' ')}`)
    section[sub.name] = subsection
  }
  result.sections.holdout = section
}

if (args.json) { writeFileSync(resolve(args.json), JSON.stringify(result, null, 1)); console.log(`\nwrote ${args.json}`) }
