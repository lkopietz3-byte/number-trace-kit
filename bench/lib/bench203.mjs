// The labeled number benchmark (203 items): honest answers and answers with exactly one planted or source-labeled error.
// Scoring follows the harness it was written with: an item is flagged when the checker marks a number untraced.
import { rate, fmt } from './stats.mjs'

const overlap = (a, b) => a.start < b.end && b.start < a.end
// Planted types a value tracer cannot see in principle. They are reported, not scored.
export const BOUNDARY = new Set(['swapped-number', 'direction-flip'])
const DERIVATIONS = ['sum', 'difference', 'ratio', 'percent-change', 'percent-of']

/** The settings measured. `default` turns the five common derivations on and nothing else. */
export const BENCH203_CONFIGS = {
  default: { derivations: DERIVATIONS },
  report: { derivations: DERIVATIONS, preset: 'report' },
  strict: { derivations: [], preset: 'strict' },
  'allowBareEvidence': { derivations: DERIVATIONS, allowBareEvidence: true },
}

export function runBench203(kit, items, options, evidenceOf) {
  const rows = []
  const t0 = process.cpuUsage()
  for (const it of items) {
    const ev = evidenceOf ? evidenceOf(it) : it.evidence
    const r = kit.traceNumbers(it.answer, ev.map((e) => ({ id: e.id, text: e.text })), options)
    const preds = r.numbers.map((n) => ({ start: n.token.start, end: n.token.end, status: n.status }))
    const flaggedPreds = preds.filter((p) => p.status === 'untraced')
    const labeledUntraced = it.labels.numbers.filter((l) => l.status === 'untraced')
    rows.push({
      id: it.id, planted: it.plantedError, family: it.meta.family, source: it.source,
      coincidental: !!(it.meta.coincidentallyDerivable || it.meta.edit?.coincidentallyDerivable),
      verdict: r.verdict,
      flagged: flaggedPreds.length > 0,
      rightSpot: labeledUntraced.some((l) => flaggedPreds.some((p) => overlap(p, l))),
      abstained: preds.some((p) => p.status === 'unknown'),
    })
  }
  const cpu = process.cpuUsage(t0)
  return { rows, cpuMs: Math.round((cpu.user + cpu.system) / 1000) }
}

export function summarizeBench203(rows) {
  const honest = rows.filter((r) => !r.planted)
  const planted = rows.filter((r) => r.planted)
  const inScope = planted.filter((r) => !BOUNDARY.has(r.planted))
  const strictSet = inScope.filter((r) => !r.coincidental)
  const boundary = planted.filter((r) => BOUNDARY.has(r.planted))
  const byType = {}
  for (const r of planted) (byType[r.planted] ??= []).push(r)
  const types = Object.entries(byType).sort(([a], [b]) => a.localeCompare(b)).map(([type, rs]) => ({
    type, boundaryProbe: BOUNDARY.has(type),
    caught: rate(rs.filter((r) => r.flagged).length, rs.length),
    rightSpot: rate(rs.filter((r) => r.rightSpot).length, rs.length),
    abstainedOnly: rs.filter((r) => !r.flagged && r.verdict === 'unknown').length,
    cameBackClean: rs.filter((r) => r.verdict === 'clean').length,
  }))
  const fam = {}
  for (const r of honest) { const f = (fam[r.family] ??= { n: 0, flagged: 0 }); f.n++; if (r.flagged) f.flagged++ }
  return {
    items: rows.length, honestItems: honest.length, plantedItems: planted.length,
    falseFail: rate(honest.filter((r) => r.flagged).length, honest.length),
    falseFailByFamily: fam,
    catchInScope: rate(inScope.filter((r) => r.flagged).length, inScope.length),
    catchInScopeNotCoincidental: rate(strictSet.filter((r) => r.flagged).length, strictSet.length),
    // false pass: an in-scope planted item that came back clean. The rest of the misses are unknown (sent to a person).
    falsePassInScope: rate(inScope.filter((r) => r.verdict === 'clean' && !r.flagged).length, inScope.length),
    unknownOnlyInScope: rate(inScope.filter((r) => r.verdict === 'unknown' && !r.flagged).length, inScope.length),
    boundaryProbes: rate(boundary.filter((r) => r.flagged).length, boundary.length),
    types,
  }
}

const pr = (r) => fmt(r.k, r.n)
export function printBench203(name, s, cpuMs, form) {
  console.log(`\n--- Labeled number benchmark | ${name} | ${s.items} items (${s.honestItems} honest, ${s.plantedItems} with one error) | cpu ${cpuMs} ms | ${form}`)
  console.log(`  false fail: honest items flagged untraced: ${pr(s.falseFail)}`)
  console.log(`  catch: planted errors a value check can see, flagged untraced: ${pr(s.catchInScope)}`)
  console.log(`    excluding planted numbers that a pairwise derivation could also build: ${pr(s.catchInScopeNotCoincidental)}`)
  console.log(`  false pass: the same items that came back clean: ${pr(s.falsePassInScope)}; unknown only (sent to a person): ${pr(s.unknownOnlyInScope)}`)
  console.log(`  boundary probes (swapped numbers, flipped direction; a value check cannot see them): caught ${pr(s.boundaryProbes)}`)
  for (const t of s.types) console.log(`    ${t.type.padEnd(28)} caught ${t.caught.k}/${t.caught.n}, right spot ${t.rightSpot.k}, clean ${t.cameBackClean}${t.boundaryProbe ? '  (boundary probe)' : ''}`)
  console.log('  false fail by honest family: ' + Object.entries(s.falseFailByFamily).map(([k, v]) => `${k} ${v.flagged}/${v.n}`).join('; '))
}
