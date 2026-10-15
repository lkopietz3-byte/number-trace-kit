import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export function readJsonl(path) {
  const text = readFileSync(path, 'utf8')
  const out = []
  for (const line of text.split('\n')) if (line.trim() !== '') out.push(JSON.parse(line))
  return out
}

/** Write one JSON object per line. Key order is the insertion order, so the output is stable. */
export function writeJsonl(path, rows) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

export function sha256File(path) {
  return sha256(readFileSync(path))
}
