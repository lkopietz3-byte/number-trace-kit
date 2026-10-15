// Token-level judgement of RAGTruth answers, ported from the field trial (src/adjudicate_rt.py + src/labelrt.mjs).
// The kit's verdicts are never an input to a label. Classes:
//   STRUCT  list markers and passage or step references          CONV   unit-conversion pairs
//   HONEST  supported (or outside every annotated span)          ERROR  inside an annotated span and absent from the source
//   UNCLEAR inside an annotated span but the value is in the source (a value check cannot decide)
//   plus classes from the manual layer (data/adjudication-manual.json), some of them written after the kit's verdicts were seen (post_kit)
import { digitRuns } from './ragtruth-raw.mjs'

/** The frozen automatic rule for one kit token (field trial src/labelrt.mjs), using stored run presence instead of source text. */
export function frozenLabel(item, start, end, raw, counters) {
  let inAbsent = false
  let inOther = false
  for (const s of item.spans) {
    if (start < s.end && end > s.start) {
      if (s.cls === 'ABSENT') inAbsent = true
      else inOther = true
    }
  }
  if (inAbsent) {
    return digitRuns(raw).some((r) => {
      if (!(r in item.runs)) { if (counters) counters.unseenRun++; return false }
      return item.runs[r] === false
    }) ? 'error' : 'span-present'
  }
  return inOther ? 'in-span' : 'honest'
}

function structKind(a, s, e) {
  const pre = a.slice(Math.max(0, s - 22), s)
  const post = a.slice(e, e + 12)
  if (/(^|\n)\s*[*\-•]?\s*$/.test(a.slice(Math.max(0, s - 8), s)) && /^[.)]\s/.test(post)) return 'list-marker'
  if (/(passages?|options?|questions?|steps?|sources?)\s*(\d+\s*(,|and|&|or|-|to)\s*)*$/i.test(pre)) return 'passage/step-ref'
  return null
}

function timeExprs(a) {
  const out = []
  const re = /(?<![\d:.,$/-])(\d{1,2})(?::(\d{2}))?\s?([aApP]\.?[mM]\.?)(?!\w)|(?<![\d:.,$/-])(\d{1,2}):(\d{1,2})(?!\d)(?:\s?([aApP]\.?[mM]\.?)(?!\w))?/g
  for (const m of a.matchAll(re)) {
    let h, mi, ap
    if (m[1] !== undefined) { h = Number(m[1]); mi = Number(m[2] ?? 0); ap = m[3] } else { h = Number(m[4]); mi = Number(m[5]); ap = m[6] }
    if (h > 24 || mi > 59) continue
    let mins
    if (ap) {
      const x = ap[0].toLowerCase()
      mins = h > 12 ? h * 60 + mi : (h % 12) * 60 + mi + (x === 'p' ? 720 : 0)
    } else mins = h * 60 + mi
    out.push([m.index, m.index + m[0].length, mins % 1440, m[0]])
  }
  return out
}

const CONV = /-?\d+(?:\.\d+)?\s?°\s?[FC](?:\s?(?:to|-|and)\s?-?\d+(?:\.\d+)?\s?°\s?[FC])?\s?\(\s*-?\d+(?:\.\d+)?\s?°\s?[FC](?:\s?(?:to|-|and)\s?-?\d+(?:\.\d+)?\s?°\s?[FC])?\s?\)|\d+(?:\.\d+)?\s?mph\s?\(\s*\d+(?:\.\d+)?\s?km\/h\s?\)/g

function d2tClass(item, a, s, e, raw) {
  const f = item.facts
  if (!f) return null
  const ctxAfter = a.slice(e, e + 40)
  const ctxBefore = a.slice(Math.max(0, s - 40), s)
  if (/^\d+$/.test(raw) && /^\s*(customer |yelp |user )?(reviews?|ratings)\b/i.test(ctxAfter)) {
    const n = Number(raw)
    if (/(over|more than|about|around)\s*$/i.test(ctxBefore)) return { cls: 'ERROR', why: `review count "over N" but the JSON lists ${f.reviewCount} reviews` }
    return { cls: n === f.reviewCount ? 'HONEST' : 'ERROR', sub: n === f.reviewCount ? 'COUNT_OF_ITEMS' : '', why: `review count ${n} vs ${f.reviewCount}` }
  }
  if (/^\d(?:\.\d+)?$/.test(raw) && (/^\s*(-|\s)?stars?\b/i.test(ctxAfter) || /(rating of|rated|average rating of)\s*$/i.test(ctxBefore))) {
    const v = Number(raw)
    const bs = f.businessStars
    const rs = f.reviewStars
    if (bs !== null && Math.abs(v - Number(bs)) < 1e-9) return { cls: 'HONEST', why: 'equals business_stars' }
    if (rs.length && Math.abs(v - Math.round((rs.reduce((x, y) => x + y, 0) / rs.length) * 10) / 10) < 0.051) return { cls: 'HONEST', sub: 'COMPUTED_MEAN', why: 'mean of review_stars' }
    if (rs.includes(v)) return { cls: 'HONEST', why: 'equals a review_stars value' }
    return { cls: 'ERROR', why: `rating ${raw} is not business_stars nor the mean of review_stars` }
  }
  if (raw === '5' && /out of\s*$/i.test(ctxBefore)) return { cls: 'SCALE', why: '"out of 5" scale of a star rating (convention)' }
  return null
}

/** Judge one kit token. `manual` maps "id#start" to a hand judgement. */
export function adjudicate(item, token, manual, counters) {
  const a = item.answer
  const s = token.start
  const e = token.end
  const st = structKind(a, s, e)
  if (st) return { cls: 'STRUCT', why: st }
  const key = `${item.id}#${s}`
  if (manual[key]) return manual[key]
  if (item.task === 'Data2txt') {
    const j2 = d2tClass(item, a, s, e, token.raw)
    if (j2) return j2
    if (item.facts) {
      const mins = new Set(item.facts.sourceMinutes)
      for (const [ts, te, m, txt] of timeExprs(a)) {
        if (s < te && e > ts) return { cls: mins.has(m) ? 'HONEST' : 'ERROR', sub: mins.has(m) ? 'CLOCK_FORMAT' : '', why: `clock ${txt}` }
      }
    }
  }
  for (const m of a.matchAll(CONV)) if (s < m.index + m[0].length && e > m.index) return { cls: 'CONV', why: 'unit conversion pair' }
  const label = frozenLabel(item, s, e, token.raw, counters)
  if (label === 'error') return { cls: 'ERROR', why: 'default: own digits absent from the evidence and inside an annotated hallucination span' }
  if (label === 'span-present' || label === 'in-span') return { cls: 'UNCLEAR', why: 'inside an annotated span but the value occurs in the evidence' }
  return { cls: 'HONEST', why: 'default: outside every annotated span', default: true }
}
