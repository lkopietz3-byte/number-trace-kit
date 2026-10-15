import { describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'

// A deterministic fuzz over number-shaped fragments. The properties are the
// ones that must hold for any text: extraction never throws, tokens are
// ordered and slice back to their raw text, every value is a plain exact
// decimal, and a text traced against itself is never called untraced.

const FRAGMENTS = [
  '0', '1', '2', '5', '7', '9', '10', '12', '13', '45', '100', '1,234', '1.234', '12,5', '3.14', '1,234,567.89',
  '1.234,56', '007', '2024', '1999', '-', '+', '(', ')', '%', ' ', '  ', ',', '.', '$', '€', '£', '¥',
  'USD', 'EUR', 'K', 'M', 'B', 'k', 'm', 'million', 'thousand', 'percent', 'pp', 'days', 'kg', 'x', 'st', 'th',
  '/', '–', ':', 'Oct', 'May', 'October', 'March', 'of', 'the', 'e', 'E', '_', '²', '٣', '１',
  '．', '％', '−', ' ', ' ', '​', '\ud800', '\udc00', '😀', 'é', '́',
  'q', 'Q', 'v', 'X', 'GPT', 'FY', 'a', 'and', 'to', 'COVID', '19', '4K', '.5', '5.', '1e3', '0x1F', '\n', '"', "'",
  '#', '@', '*', '=', '^', '|', '円', '第', '3/4', '1-2', '2026-10-10', '10/12/2026', '12:30',
  // The forms of the release-gate review: currency codes, underscores, glyphs, rates, times, dates, spaces, compounds.
  'AED', 'THB1,500', '1_500', '1_5', '①', '⑤00', '₅', '¹²', '%', '%12', '14.10.26', '17h30', '5.30pm', '(4am)', '/month', ' per ', 'mg/kg', '2h45m',
  '$(', ') million', '\u202f', '\t', '\u200b', '‰', '×', '10×', '2026E', 'Q3', '2026-W10', 'USDT', 'KSh', 'x10', 'MM', 'trn', 'grand', '(', '1H26',
]

function lcg(seed: number): () => number {
  let s = seed
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function sample(rnd: () => number): string {
  const length = 1 + Math.floor(rnd() * 14)
  let text = ''
  for (let i = 0; i < length; i++) {
    text += FRAGMENTS[Math.floor(rnd() * FRAGMENTS.length)] ?? ''
    if (rnd() < 0.5) text += ' '
  }
  return text
}

describe('fuzz', () => {
  for (const locale of ['en-US', 'de-DE', 'fr-FR', 'en-IN', 'de-CH']) {
    it(`extraction invariants and self-tracing hold under ${locale}`, () => {
      const rnd = lcg(20261010)
      for (let i = 0; i < 4000; i++) {
        const text = sample(rnd)
        const tokens = extractNumbers(text, { locale })
        let end = 0
        for (const t of tokens) {
          expect(text.slice(t.start, t.end), text).toBe(t.raw)
          expect(t.start, text).toBeGreaterThanOrEqual(end)
          expect(t.end, text).toBeGreaterThan(t.start)
          expect(/^-?\d+(\.\d+)?$/.test(t.value), `${text} -> ${t.value}`).toBe(true)
          if (t.ambiguous) expect(t.ambiguity, text).toBeDefined()
          end = t.end
        }
        const result = traceNumbers(text, text, { locale, evidenceLocale: locale })
        for (const n of result.numbers) expect(n.status, `${text} -> ${n.token.raw}`).not.toBe('untraced')
        // Tokens the kit made are accepted back as tokens, and a skipped form never overlaps a number.
        expect(() => traceNumbers(tokens, text, { locale, evidenceLocale: locale }), text).not.toThrow()
        for (const s of result.skipped) {
          for (const n of result.numbers) expect(s.start < n.token.end && n.token.start < s.end, `${text}: ${s.raw} overlaps ${n.token.raw}`).toBe(false)
        }
      }
    }, 120_000)
  }

  it('tracing the same text with derivations on never throws and stays consistent', () => {
    const rnd = lcg(7)
    for (let i = 0; i < 1500; i++) {
      const a = sample(rnd)
      const b = sample(rnd)
      const r = traceNumbers(a, [{ id: 'a', text: b }, { id: 'b', text: a }], {
        derivations: ['sum', 'difference', 'ratio', 'percent-change', 'percent-of'],
        maxCandidates: 400,
      })
      const { skipped, ...byStatus } = r.counts
      expect(skipped, a).toBe(r.skipped.length)
      const total = Object.values(byStatus).reduce((x, y) => x + y, 0)
      expect(total, a).toBe(r.numbers.length)
      expect(['clean', 'untraced', 'unknown']).toContain(r.verdict)
      // The same text is always among the evidence, so nothing can be untraced.
      for (const n of r.numbers) expect(n.status, `${a} | ${b} -> ${n.token.raw}`).not.toBe('untraced')
    }
  }, 120_000)
})
