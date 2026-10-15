// A plain number finder that does not use the kit. It labels holdout answers and drives the baselines a developer would write.
// A token is a run of digits with comma groups and one decimal part, optionally followed by a percent sign.
// Colons, dashes and slashes end a token, so "8:00" is "8" and "00" and "1-2" is "1" and "2".
export function findNumbers(text) {
  const out = []
  const re = /\d+(?:,\d{3})*(?:\.\d+)?%?/g
  for (const m of text.matchAll(re)) out.push({ start: m.index, end: m.index + m[0].length, raw: m[0] })
  return out
}
