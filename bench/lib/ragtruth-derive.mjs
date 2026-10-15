// Turn one RAGTruth response plus its source into the derived record that is committed: the model's answer
// (a model output, MIT-licensed dataset), the annotators' span offsets, the frozen number-label facts, and,
// where the source corpus allows it, number-centered excerpts of the evidence instead of the evidence itself.
import { classifySpans, data2txtFacts, runPresence, sourceDocs, windowsOf } from './ragtruth-raw.mjs'
import { sha256 } from './jsonl.mjs'

export const evidenceHash = (docs) => sha256(docs.map((d) => `${d.id}\u0000${d.text}`).join('\u0001'))

/** stratum: E numeric error span absent from the source; C no annotation at all; M only non-numeric error spans; null otherwise. */
export function stratumOf(spans, response) {
  const kinds = new Set(spans.map((s) => s.cls))
  if (kinds.has('ABSENT')) return 'E'
  if (spans.length === 0 && response.labels.length === 0) return 'C'
  if (spans.length > 0 && kinds.size === 1 && kinds.has('NONNUM')) return 'M'
  return null
}

// Yelp (Data2txt) and MS MARCO passages carry their own terms, so excerpts are committed only for these tasks.
const EXCERPT_OK = new Set(['QA', 'Summary'])

export function deriveItem(response, src, rawLine, setName) {
  const docs = sourceDocs(src, rawLine)
  const spans = classifySpans(response, docs)
  const item = {
    id: `RT-${response.id}`,
    set: setName,
    task: src.task_type,
    domain: src.source,
    model: response.model,
    stratum: stratumOf(spans, response),
    answer: response.response,
    answerSha256: sha256(response.response),
    spans: spans.map(({ start, end, label_type, cls }) => ({ start, end, label_type, cls })),
    runs: runPresence(response.response, docs),
    evidenceSha256: evidenceHash(docs),
    evidenceIds: docs.map((d) => d.id),
  }
  if (src.task_type === 'Data2txt') item.facts = data2txtFacts(docs)
  item.evidence = EXCERPT_OK.has(src.task_type)
    ? { form: 'excerpts', docs: docs.map((d) => ({ id: d.id, text: windowsOf(d.text) })) }
    : null
  return item
}

/** The full evidence of a derived item, rebuilt from the raw download. Throws when it is not the text the labels were made against. */
export function fullEvidence(item, raw) {
  const response = raw.byId.get(item.id.replace(/^RT-/, ''))
  if (!response) throw new Error(`${item.id}: response is not in the raw download`)
  if (sha256(response.response) !== item.answerSha256) throw new Error(`${item.id}: the downloaded answer differs from the one that was labeled`)
  const src = raw.sources.get(response.source_id)
  const docs = sourceDocs(src, raw.rawSource.get(response.source_id))
  if (evidenceHash(docs) !== item.evidenceSha256) throw new Error(`${item.id}: the downloaded evidence differs from the one that was labeled`)
  return docs
}
