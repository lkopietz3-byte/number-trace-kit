import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadRagtruth } from './ragtruth-raw.mjs'
import { fullEvidence } from './ragtruth-derive.mjs'

/** Open a raw RAGTruth download, or return null when the cache folder does not hold both files. */
export function openRagtruthCache(dir) {
  if (!dir || !existsSync(join(dir, 'response.jsonl')) || !existsSync(join(dir, 'source_info.jsonl'))) return null
  const raw = loadRagtruth(dir)
  raw.byId = new Map(raw.responses.map((r) => [r.id, r]))
  return raw
}

/**
 * Evidence for a derived item. `mode` is 'full' (rebuild from the raw download), 'excerpts' (the committed number-centered excerpts),
 * or 'auto' (full when the download is present, else excerpts). Returns { docs, form } or null when the item cannot be run in that mode.
 */
export function evidenceFor(item, raw, mode = 'auto') {
  if ((mode === 'full' || mode === 'auto') && raw) return { docs: fullEvidence(item, raw), form: 'full' }
  if (mode !== 'full' && item.evidence) return { docs: item.evidence.docs.map((d) => ({ id: d.id, text: d.text })), form: 'excerpts' }
  return null
}
