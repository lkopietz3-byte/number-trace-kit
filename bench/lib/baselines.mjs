// Deterministic checkers a developer would write in an afternoon, with no language model. Each returns the answer's numbers
// it flags as "not in the evidence": [{ start, end, raw }]. They share one number finder so they differ only in the comparison.
//
//   exact-string        a number is fine only if its text, as written (with $, % and commas), occurs in the evidence text
//   regex-set           a number is fine if its value (commas, $ and % dropped, trailing zeros dropped) is among the values the same
//                       regex finds in the evidence
//   regex-set+structure the same, skipping list markers and passage or step references
//   regex-set+rounding  the same, also accepting a number that equals an evidence number rounded to the digits shown (plain floats)
const NUM = /\$?\d[\d,]*(?:\.\d+)?%?/g

function value(raw) {
  let v = raw.replace(/[$,%]/g, '')
  if (v.includes('.')) v = v.replace(/0+$/, '').replace(/\.$/, '')
  return v
}

function numbersOf(text) {
  const out = []
  for (const m of text.matchAll(NUM)) out.push({ start: m.index, end: m.index + m[0].length, raw: m[0] })
  return out
}

function isStructure(answer, t) {
  const pre = answer.slice(Math.max(0, t.start - 22), t.start)
  const post = answer.slice(t.end, t.end + 12)
  if (/(^|\n)\s*[*\-•]?\s*$/.test(answer.slice(Math.max(0, t.start - 8), t.start)) && /^[.)]\s/.test(post)) return true
  return /(passages?|options?|questions?|steps?|sources?)\s*(\d+\s*(,|and|&|or|-|to)\s*)*$/i.test(pre)
}

export const BASELINES = {
  'exact-string': (answer, evidenceText) => numbersOf(answer).filter((t) => !evidenceText.includes(t.raw)),
  'regex-set': (answer, evidenceText) => {
    const have = new Set(numbersOf(evidenceText).map((t) => value(t.raw)))
    return numbersOf(answer).filter((t) => !have.has(value(t.raw)))
  },
  'regex-set+structure': (answer, evidenceText) => {
    const have = new Set(numbersOf(evidenceText).map((t) => value(t.raw)))
    return numbersOf(answer).filter((t) => !isStructure(answer, t) && !have.has(value(t.raw)))
  },
  'regex-set+rounding': (answer, evidenceText) => {
    const evNums = numbersOf(evidenceText).map((t) => value(t.raw))
    const have = new Set(evNums)
    const floats = evNums.map(Number).filter(Number.isFinite)
    return numbersOf(answer).filter((t) => {
      if (isStructure(answer, t)) return false
      const v = value(t.raw)
      if (have.has(v)) return false
      const dec = v.includes('.') ? v.split('.')[1].length : 0
      return !floats.some((f) => f.toFixed(dec) === Number(v).toFixed(dec))
    })
  },
}
