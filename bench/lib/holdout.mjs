// Scoring on the fresh holdout. Labels were frozen first (data/FROZEN-holdout.sha256); the kit and the baselines are scored against them.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { BASELINES } from './baselines.mjs'
import { rate, fmt } from './stats.mjs'

export function verifyFrozen(benchDir) {
  const bad = []
  let n = 0
  for (const line of readFileSync(join(benchDir, 'data', 'FROZEN-holdout.sha256'), 'utf8').split('\n')) {
    if (!line.trim()) continue
    const [hash, file] = line.split(/\s+/)
    n++
    const have = createHash('sha256').update(readFileSync(join(benchDir, file))).digest('hex')
    if (have !== hash) bad.push(file)
  }
  return { files: n, changed: bad }
}

const overlap = (a, b) => a.start < b.end && b.start < a.end

/** One checker's outcome on one labeled item. `flagged` is untraced numbers (kit) or flagged numbers (baseline). */
export function kitOutcome(kit, item, docs, options) {
  const r = kit.traceNumbers(item.answer, docs, options)
  const flagged = r.numbers.filter((n) => n.status === 'untraced').map((n) => ({ start: n.token.start, end: n.token.end, raw: n.token.raw, why: n.reason ?? n.status }))
  const unknown = r.numbers.filter((n) => n.status === 'unknown').map((n) => ({ start: n.token.start, end: n.token.end, raw: n.token.raw, why: n.reason ?? n.status }))
  return { flagged, unknown, verdict: r.verdict }
}

export function baselineOutcome(name, item, docs) {
  const flagged = BASELINES[name](item.answer, docs.map((d) => d.text).join('\n')).map((t) => ({ ...t, why: 'not-in-evidence' }))
  return { flagged, unknown: [], verdict: flagged.length ? 'untraced' : 'clean' }
}

export function scoreHoldout(entries) {
  // entries: [{ id, task, label, errorTokens, outcome, answer }]
  const E = entries.filter((e) => e.label === 'E')
  const C = entries.filter((e) => e.label === 'C')
  const caught = E.filter((e) => e.outcome.flagged.length > 0)
  const rightSpot = E.filter((e) => e.outcome.flagged.some((f) => e.errorTokens.some((t) => overlap(f, t))))
  const falseFlag = C.filter((e) => e.outcome.flagged.length > 0)
  const tp = caught.length
  const fp = falseFlag.length
  const byTask = {}
  for (const task of [...new Set(entries.map((e) => e.task))].sort()) {
    const Et = E.filter((e) => e.task === task)
    const Ct = C.filter((e) => e.task === task)
    byTask[task] = {
      recall: rate(Et.filter((e) => e.outcome.flagged.length > 0).length, Et.length),
      falseFlag: rate(Ct.filter((e) => e.outcome.flagged.length > 0).length, Ct.length),
    }
  }
  return {
    positives: E.length, negatives: C.length,
    recall: rate(tp, E.length),
    rightSpotRecall: rate(rightSpot.length, E.length),
    precision: rate(tp, tp + fp),
    falseFlagRate: rate(fp, C.length),
    // unknown is "sent to a person": not a flag, not a pass
    positivesUnknownOnly: E.filter((e) => !e.outcome.flagged.length && e.outcome.unknown.length).length,
    positivesClean: E.filter((e) => !e.outcome.flagged.length && !e.outcome.unknown.length).length,
    negativesUnknown: C.filter((e) => !e.outcome.flagged.length && e.outcome.unknown.length).length,
    byTask,
    misses: E.filter((e) => !e.outcome.flagged.length).map((e) => ({
      id: e.id, task: e.task, verdict: e.outcome.verdict,
      errorTokens: e.errorTokens.map((t) => e.answer.slice(Math.max(0, t.start - 25), t.end + 12).replace(/\s+/g, ' ')),
      unknown: e.outcome.unknown.map((u) => `${u.raw} (${u.why})`),
    })),
    wrongFlags: falseFlag.map((e) => ({
      id: e.id, task: e.task,
      flagged: e.outcome.flagged.map((f) => ({ raw: f.raw, why: f.why, context: e.answer.slice(Math.max(0, f.start - 25), f.end + 12).replace(/\s+/g, ' ') })),
    })),
  }
}

export function printHoldout(name, s) {
  const pr = (r) => fmt(r.k, r.n)
  console.log(`  ${name.padEnd(24)} recall ${pr(s.recall)}`)
  console.log(`  ${''.padEnd(24)} precision ${pr(s.precision)}; false flags on clean responses ${pr(s.falseFlagRate)}`)
  console.log(`  ${''.padEnd(24)} flag on the annotated number itself ${pr(s.rightSpotRecall)}; unknown only ${s.positivesUnknownOnly}, clean ${s.positivesClean}; clean responses sent to a person ${s.negativesUnknown}`)
}
