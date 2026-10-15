// Interval and rate helpers. Plain floats are fine here: this is reporting, not number checking.

/** Wilson score interval for k successes out of n, 95% by default. Returns [lo, hi] as fractions, or [null, null] for n = 0. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [null, null]
  const p = k / n
  const d = 1 + (z * z) / n
  const c = (p + (z * z) / (2 * n)) / d
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return [Math.max(0, c - h), Math.min(1, c + h)]
}

/** "14/697 = 2.0% (95% CI 1.2 to 3.3%)". Always shows the denominator. */
export function fmt(k, n) {
  if (!n) return `${k}/0 (no denominator)`
  const [lo, hi] = wilson(k, n)
  return `${k}/${n} = ${(100 * k / n).toFixed(1)}% (95% CI ${(100 * lo).toFixed(1)} to ${(100 * hi).toFixed(1)}%)`
}

/** A rate as a plain object for JSON output. */
export function rate(k, n) {
  const [lo, hi] = wilson(k, n)
  return { k, n, rate: n ? k / n : null, ci95: [lo, hi] }
}

/** Seeded generator (mulberry32) so a sample can be redrawn. Returns floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Seeded sample without replacement (partial Fisher-Yates over a copy). */
export function sample(list, k, seed) {
  const rnd = mulberry32(seed)
  const a = list.slice()
  const n = Math.min(k, a.length)
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rnd() * (a.length - i))
    const t = a[i]
    a[i] = a[j]
    a[j] = t
  }
  return a.slice(0, n)
}
