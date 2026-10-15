import { adjudicate } from './ragtruth-score.mjs'
import { fmt, rate } from './stats.mjs'

const MARKERS = /\n\s*[*\-•]?\s*\d{1,2}[.)]\s|^\d{1,2}[.)]\s|(?:[Pp]assages?|[Ss]teps?|[Oo]ptions?|[Qq]uestions?)\s\d+/

/** The settings measured on the field corpus. `markers` is the hand-written ignorePattern; `structure` is the shipped ignoreStructure option. */
export const RAGTRUTH_CONFIGS = {
  strict: { preset: 'strict' },
  'strict+markers': { preset: 'strict', ignorePattern: MARKERS },
  'strict+structure': { preset: 'strict', ignoreStructure: true },
  'strict+small10': { preset: 'strict', ignoreSmallIntegersUpTo: 10 },
  report: { preset: 'report' },
  'report+markers': { preset: 'report', ignorePattern: MARKERS },
}

const PASS = new Set(['traced', 'rounded', 'derived'])

export function runRagtruthConfig(kit, items, evidenceOf, options, manual) {
  const rows = []
  const counters = { unseenRun: 0 }
  for (const item of items) {
    const ev = evidenceOf(item)
    if (!ev) continue
    const t0 = process.cpuUsage()
    const r = kit.traceNumbers(item.answer, ev.docs, options)
    const cpu = process.cpuUsage(t0)
    const numbers = r.numbers.map((n) => {
      const j = adjudicate(item, { start: n.token.start, end: n.token.end, raw: n.token.raw }, manual, counters)
      return { raw: n.token.raw, start: n.token.start, end: n.token.end, status: n.status, reason: n.reason ?? null, cls: j.cls, sub: j.sub ?? '', why: j.why, postKit: !!j.post_kit }
    })
    rows.push({ id: item.id, task: item.task, stratum: item.stratum, form: ev.form, verdict: r.verdict, cpuMs: (cpu.user + cpu.system) / 1000, numbers })
  }
  return { rows, counters }
}

export function summarizeRagtruth(rows) {
  const tab = {}
  const byTask = {}
  for (const r of rows) for (const n of r.numbers) {
    ;(tab[n.cls] ??= {})[n.status] = (tab[n.cls][n.status] ?? 0) + 1
    const t = (byTask[r.task] ??= {})
    ;((t[n.cls] ??= {})[n.status] = (t[n.cls][n.status] ?? 0) + 1)
  }
  const get = (t, cls, s) => t?.[cls]?.[s] ?? 0
  const sum = (t, cls) => Object.values(t?.[cls] ?? {}).reduce((a, b) => a + b, 0)
  const honest = (t) => {
    const n = sum(t, 'HONEST') - get(t, 'HONEST', 'ignored')
    return { n, untraced: rate(get(t, 'HONEST', 'untraced'), n), unknown: rate(get(t, 'HONEST', 'unknown'), n) }
  }
  const errors = (t) => {
    const n = sum(t, 'ERROR') - get(t, 'ERROR', 'ignored')
    const passed = [...PASS].reduce((a, s) => a + get(t, 'ERROR', s), 0)
    return { n, caught: rate(get(t, 'ERROR', 'untraced'), n), unknown: rate(get(t, 'ERROR', 'unknown'), n), falsePass: rate(passed, n) }
  }
  const tasks = {}
  for (const task of Object.keys(byTask).sort()) tasks[task] = { honest: honest(byTask[task]), error: errors(byTask[task]) }
  // responses
  const resp = (sel) => {
    const out = { n: sel.length, clean: 0, untraced: 0, unknown: 0 }
    for (const r of sel) out[r.verdict]++
    return out
  }
  const isC = (r) => r.stratum === 'C'
  const isE = (r) => r.numbers.some((n) => n.cls === 'ERROR')
  const byTaskResp = {}
  for (const task of ['ALL', ...Object.keys(byTask).sort()]) {
    const sel = rows.filter((r) => task === 'ALL' || r.task === task)
    byTaskResp[task] = { honestResponses: resp(sel.filter(isC)), errorResponses: resp(sel.filter(isE)) }
  }
  const struct = sum(tab, 'STRUCT') - get(tab, 'STRUCT', 'ignored')
  return {
    tokens: tab,
    honest: honest(tab), error: errors(tab), byTask: tasks, responses: byTaskResp,
    structFlagged: rate(get(tab, 'STRUCT', 'untraced'), struct),
    items: rows.length,
  }
}

const pr = (r) => fmt(r.k, r.n)
export function printRagtruth(name, s, form) {
  console.log(`\n--- RAGTruth field corpus | ${name} | ${s.items} responses | evidence: ${form}`)
  console.log(`  honest numbers flagged untraced: ${pr(s.honest.untraced)}; unknown: ${pr(s.honest.unknown)}`)
  console.log(`  unsupported numbers: caught as untraced ${pr(s.error.caught)}; unknown ${pr(s.error.unknown)}; passed (false pass) ${pr(s.error.falsePass)}`)
  for (const [task, t] of Object.entries(s.byTask)) {
    console.log(`    ${task.padEnd(9)} honest flagged ${t.honest.untraced.k}/${t.honest.untraced.n}; unsupported caught ${t.error.caught.k}/${t.error.caught.n}, unknown ${t.error.unknown.k}, passed ${t.error.falsePass.k}`)
  }
  const h = s.responses.ALL.honestResponses
  const e = s.responses.ALL.errorResponses
  console.log(`  honest responses (no annotation) not clean: ${pr(rate(h.untraced + h.unknown, h.n))} (untraced ${h.untraced}, unknown ${h.unknown})`)
  console.log(`  responses with an unsupported number that came back clean: ${pr(rate(e.clean, e.n))}`)
  for (const [task, r] of Object.entries(s.responses)) {
    if (task === 'ALL') continue
    console.log(`    ${task.padEnd(9)} honest responses clean ${r.honestResponses.clean}/${r.honestResponses.n}; responses with an unsupported number clean ${r.errorResponses.clean}/${r.errorResponses.n}`)
  }
}
