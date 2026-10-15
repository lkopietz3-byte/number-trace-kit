// FinanceBench (Patronus AI) readers and runner. The dataset is CC BY-NC 4.0, so none of it is committed:
// everything here reads the raw download from the cache folder (see bench/SOURCES.json and bench/fetch.mjs).
// Source: https://github.com/patronus-ai/financebench (data/financebench_open_source.jsonl and results/*.jsonl).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rate } from './stats.mjs'

export function openFinanceBenchCache(dir) {
  if (!dir) return null
  const base = join(dir, 'financebench_open_source.jsonl')
  const resDir = join(dir, 'results')
  if (!existsSync(base) || !existsSync(resDir)) return null
  return { base, resDir }
}

const lines = (p) => readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))

// Labeling helpers: they judge the answer's headline number against the gold answer with plain floats and a 1% tolerance.
// They are part of the label, not of the kit, and the kit never sees them.
function goldValue(g) {
  const m = /^\$?\s*(-?[\d,]*\.?\d+)\s*(%|x)?$/.exec(g.trim())
  return m ? Number(m[1].replace(/,/g, '')) : null
}
const SC = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, k: 1e3, m: 1e6, b: 1e9, bn: 1e9, mm: 1e6 }
function answerValues(a) {
  const out = []
  for (const m of a.matchAll(/(-?\$?\s?\(?-?[\d,]*\.?\d+\)?)\s*(thousand|million|billion|trillion|bn|mm|k|m|b)?\b/gi)) {
    const raw = m[1].replace(/[^\d.-]/g, '')
    if (raw === '' || raw === '-' || raw === '.') continue
    const v = Number(raw)
    if (Number.isNaN(v)) continue
    out.push(v * (SC[(m[2] ?? '').toLowerCase()] ?? 1))
  }
  return out
}
function close(a, b, tol = 0.01) {
  if (a === b) return true
  if (b === 0) return Math.abs(a) < 1e-9
  return Math.abs(a - b) / Math.abs(b) <= tol
}
function containsGold(g, vals) {
  for (const sc of [1e-9, 1e-6, 1e-3, 1, 1e3, 1e6, 1e9]) for (const f of [1, 100, 0.01]) for (const v of vals) {
    if (close(v, g * sc * f, 0.011) || close(Math.abs(v), Math.abs(g) * sc * f, 0.011)) return true
  }
  return false
}

/** All human-labeled Correct or Incorrect completions that contain a digit (refusals dropped), with the filing pages as evidence. */
export function buildFinanceBenchItems(cache) {
  const q = new Map()
  for (const d of lines(cache.base)) q.set(d.financebench_id, d)
  const files = readdirSync(cache.resDir).filter((f) => f.endsWith('.jsonl')).sort()
  const items = []
  const seen = new Set()
  for (const f of files) for (const r of lines(join(cache.resDir, f))) {
    if (r.label === 'Refusal') continue
    const a = r.model_answer || ''
    if (!/\d/.test(a)) continue
    const key = `${r.financebench_id}\u0000${a}`
    const qq = q.get(r.financebench_id)
    const pages = []
    for (const e of qq.evidence) {
      const t = e.evidence_text_full_page
      if (!pages.some((p) => p.text === t)) pages.push({ id: `p${e.evidence_page_num}-${e.doc_name}`, text: t })
    }
    const gv = goldValue(String(qq.answer))
    let numericError = null
    if (r.label === 'Incorrect Answer' && gv !== null) numericError = !containsGold(gv, answerValues(a))
    items.push({
      id: `FB-${r.financebench_id.replace('financebench_id_', '')}-${r.model_name}-${r.eval_mode}`,
      model: r.model_name, evalMode: r.eval_mode, financebenchId: r.financebench_id, doc: qq.doc_name,
      humanLabel: r.label, goldNumeric: gv !== null, headlineNumberWrong: numericError,
      reasoning: qq.question_reasoning, evidence: pages, answer: a, dupeAnswer: seen.has(key),
    })
    seen.add(key)
  }
  return items
}

const HYP = ['thousand', 'million', 'billion']

/** Per filing: the scale hypothesis that traces the most currency numbers across all answers about that filing. No labels are used. */
export function calibrateScales(kit, items) {
  const byDoc = new Map()
  for (const it of items) { if (!byDoc.has(it.doc)) byDoc.set(it.doc, []); byDoc.get(it.doc).push(it) }
  const out = {}
  for (const [doc, its] of byDoc) {
    let best = null
    let bestN = 0
    for (const h of HYP) {
      let n = 0
      for (const it of its) {
        const ds = it.evidence.map((e) => ({ id: e.id, text: e.text, scale: h, currency: 'USD' }))
        const r = kit.traceNumbers(it.answer, ds, { preset: 'strict' })
        n += r.numbers.filter((x) => (x.status === 'traced' || x.status === 'rounded') && x.token.kind === 'currency').length
      }
      if (n > bestN) { bestN = n; best = h }
    }
    out[doc] = best
  }
  return out
}

/** Each page twice: as printed, and read at the calibrated statement scale. */
export function dualDocs(item, scales) {
  const sc = scales[item.doc]
  const out = []
  for (const e of item.evidence) {
    out.push({ id: `${e.id}:raw`, text: e.text })
    if (sc) out.push({ id: `${e.id}:${sc}`, text: e.text.replace(/\$\s?/g, ''), scale: sc, currency: 'USD' })
  }
  return out
}

export const FB_CONFIGS = {
  'strict+dual': { preset: 'strict' },
  'report+dual': { preset: 'report' },
}

const countNumbers = (a) => (a.match(/\d+(?:[.,]\d+)*/g) ?? []).length

export function runFinanceBench(kit, items, scales, options) {
  const rows = []
  let cpuMs = 0
  for (const it of items) {
    const t0 = process.cpuUsage()
    const r = kit.traceNumbers(it.answer, dualDocs(it, scales), options)
    const c = process.cpuUsage(t0)
    cpuMs += (c.user + c.system) / 1000
    rows.push({ id: it.id, verdict: r.verdict, concise: countNumbers(it.answer) <= 4, humanLabel: it.humanLabel, wrongHeadline: it.humanLabel === 'Incorrect Answer' && it.headlineNumberWrong === true })
  }
  return { rows, cpuMs }
}

export function summarizeFinanceBench(rows) {
  const tally = (sel) => {
    const o = { n: sel.length, clean: 0, untraced: 0, unknown: 0 }
    for (const r of sel) o[r.verdict]++
    return { n: o.n, clean: rate(o.clean, o.n), untraced: rate(o.untraced, o.n), unknown: rate(o.unknown, o.n) }
  }
  return {
    correctConcise: tally(rows.filter((r) => r.humanLabel === 'Correct Answer' && r.concise)),
    correctWorked: tally(rows.filter((r) => r.humanLabel === 'Correct Answer' && !r.concise)),
    wrongHeadline: tally(rows.filter((r) => r.wrongHeadline)),
    items: rows.length,
  }
}
