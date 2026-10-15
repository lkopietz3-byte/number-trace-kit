// RAGTruth readers and the frozen number-label rule. Nothing here calls the kit.
// Source: https://github.com/ParticleMedia/RAGTruth (dataset/response.jsonl, dataset/source_info.jsonl), MIT.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Parse JSON but keep each number literal as written ({ num: '3.0' }), so Python-style re-printing is exact. */
export function parseKeepNumbers(text) {
  let i = 0
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++ }
  const value = () => {
    ws()
    const c = text[i]
    if (c === '{') {
      i++
      const entries = []
      ws()
      if (text[i] === '}') { i++; return { obj: entries } }
      for (;;) {
        ws()
        const key = str()
        ws()
        i++ // :
        entries.push([key, value()])
        ws()
        if (text[i] === ',') { i++; continue }
        i++ // }
        return { obj: entries }
      }
    }
    if (c === '[') {
      i++
      const items = []
      ws()
      if (text[i] === ']') { i++; return { arr: items } }
      for (;;) {
        items.push(value())
        ws()
        if (text[i] === ',') { i++; continue }
        i++ // ]
        return { arr: items }
      }
    }
    if (c === '"') return { str: str() }
    if (text.startsWith('true', i)) { i += 4; return { lit: 'true' } }
    if (text.startsWith('false', i)) { i += 5; return { lit: 'false' } }
    if (text.startsWith('null', i)) { i += 4; return { lit: 'null' } }
    const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 40))
    if (!m) throw new Error(`bad JSON at ${i}`)
    i += m[0].length
    return { num: m[0] }
  }
  const str = () => {
    const start = i
    i++
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    i++
    return JSON.parse(text.slice(start, i))
  }
  const v = value()
  return v
}

/** Print like Python's json.dumps(value, indent=1, ensure_ascii=False). */
export function dumpsIndent1(node, depth = 0) {
  const pad = ' '.repeat(depth + 1)
  const end = ' '.repeat(depth)
  if ('obj' in node) {
    if (node.obj.length === 0) return '{}'
    return '{\n' + node.obj.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${dumpsIndent1(v, depth + 1)}`).join(',\n') + `\n${end}}`
  }
  if ('arr' in node) {
    if (node.arr.length === 0) return '[]'
    return '[\n' + node.arr.map((v) => `${pad}${dumpsIndent1(v, depth + 1)}`).join(',\n') + `\n${end}]`
  }
  if ('str' in node) return JSON.stringify(node.str)
  if ('num' in node) return node.num
  return node.lit
}

export function loadRagtruth(dir) {
  const sources = new Map()
  const rawSource = new Map()
  for (const line of readFileSync(join(dir, 'source_info.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue
    const d = JSON.parse(line)
    sources.set(d.source_id, d)
    if (d.task_type === 'Data2txt') rawSource.set(d.source_id, line)
  }
  const responses = []
  for (const line of readFileSync(join(dir, 'response.jsonl'), 'utf8').split('\n')) if (line.trim()) responses.push(JSON.parse(line))
  return { sources, rawSource, responses }
}

/** The evidence documents for one source, as the field trial presented them to the kit. */
export function sourceDocs(src, rawLine) {
  const si = src.source_info
  if (src.task_type === 'Summary') return [{ id: 'source', text: si }]
  if (src.task_type === 'QA') {
    const docs = [{ id: 'question', text: si.question }]
    const parts = si.passages.split(/^passage (\d+):/m)
    for (let k = 1; k < parts.length - 1; k += 2) docs.push({ id: `passage${parts[k]}`, text: parts[k + 1].trim() })
    return docs
  }
  const tree = parseKeepNumbers(rawLine)
  const node = tree.obj.find(([k]) => k === 'source_info')[1]
  return [{ id: 'json', text: dumpsIndent1(node) }]
}

// ---- the frozen number-label rule (identical to the field trial's src/labelrt.mjs) ----
export const norm = (t) => t.replace(/(?<=\d),(?=\d)/g, '')
export const digitRuns = (t) => norm(t).match(/\d+(?:\.\d+)?/g) ?? []
export function presentIn(run, srcnorm) {
  const esc = run.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('(?<![\\d.])' + esc + '(?!\\d|\\.\\d)').test(srcnorm)
}
export const evidenceNorm = (docs) => norm(docs.map((d) => d.text).join('\n'))

/** Class of each annotated span: ABSENT (a digit run of the span is not in the source), PRESENT, NONNUM (no digits). */
export function classifySpans(response, docs) {
  const full = norm(docs.map((d) => d.text).join('\n'))
  const spans = []
  for (const lb of response.labels) {
    if (lb.implicit_true) continue
    const rs = digitRuns(lb.text)
    const cls = rs.length === 0 ? 'NONNUM' : rs.some((r) => !presentIn(r, full)) ? 'ABSENT' : 'PRESENT'
    spans.push({ start: lb.start, end: lb.end, text: lb.text, label_type: lb.label_type, cls })
  }
  return spans
}

/** Every distinct normalized digit run of the answer, and whether the source has it. */
export function runPresence(answer, docs) {
  const full = norm(docs.map((d) => d.text).join('\n'))
  const out = {}
  for (const r of digitRuns(answer)) if (!(r in out)) out[r] = presentIn(r, full)
  return out
}

/**
 * Number-centered excerpts of a text: 48 characters either side of every digit, merged, widened to a
 * space within 20 characters, joined with newlines. This is the only form of third-party prose that is committed.
 */
export function windowsOf(text, width = 48) {
  const spans = []
  for (let i = 0; i < text.length; i++) {
    if (!/\p{Nd}/u.test(text[i])) continue
    const s = Math.max(0, i - width)
    const e = Math.min(text.length, i + width + 1)
    const last = spans[spans.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else spans.push([s, e])
  }
  const out = []
  for (const [s0, e0] of spans) {
    let s = s0
    let e = e0
    for (let k = 0; k < 20 && s > 0 && !/\s/.test(text[s - 1]); k++) s--
    if (s > 0 && !/\s/.test(text[s - 1])) s = s0
    for (let k = 0; k < 20 && e < text.length && !/\s/.test(text[e]); k++) e++
    if (e < text.length && !/\s/.test(text[e])) e = e0
    out.push(text.slice(s, e))
  }
  return out.join('\n')
}

/** Small structured facts of a data-to-text source (a Yelp business record), so its numbers can be judged without its text. */
export function data2txtFacts(docs) {
  const text = docs[0].text
  let js
  try { js = JSON.parse(text) } catch { return null }
  const ri = js.review_info ?? []
  const minutes = new Set()
  for (const m of text.matchAll(/(\d{1,2}):(\d{1,2})/g)) minutes.add((Number(m[1]) * 60 + Number(m[2])) % 1440)
  return {
    reviewCount: ri.length,
    businessStars: js.business_stars ?? null,
    reviewStars: ri.map((r) => r.review_stars).filter((x) => x !== undefined && x !== null),
    sourceMinutes: [...minutes].sort((a, b) => a - b),
  }
}
