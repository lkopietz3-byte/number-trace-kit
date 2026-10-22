/**
 * Shared harness for the "linear time" tests: how much more CPU does 8x the input cost?
 *
 * The step is GROWTH_STEP (8x) and the one limit is GROWTH_LIMIT (20). Linear code grows by about 8,
 * n log n code by about 9 to 10, and quadratic code by about 64, so the limit sits well clear of
 * both honest shapes and well below the shape it exists to catch. The meta-tests in
 * test/hostile.test.ts ("the ratio harness ...") prove this harness still fails a quadratic function
 * (a ratio above 40, so twice the limit) and passes linear and n log n controls, so the limit cannot
 * be loosened into a pass-everything check without those tests failing.
 *
 * Why the design is what it is. Every earlier version compared 4x the input against a limit of 10,
 * and a linear function read 10.5 to 10.4 on GitHub Actions while it read 4 to 9 on a laptop:
 *   - 10.57 and 10.08 (Node 22.12.0 and Node 22, "grouped thousands" and "dotted two-digit-year
 *     dates"): process.cpuUsage() counts CPU in scheduler ticks of about 1 to 4 ms on a Linux
 *     runner and a single 40k-character call took 3 to 5 ms, so the number was mostly rounding.
 *     Repeating the call until the sample costs a measurable amount of CPU fixed that.
 *   - 10.09, 10.36 and 10.33 (Node 24, 2026-10-22): after that fix the ratio still landed a hair
 *     over 10. A 4x step leaves only 2.5x of room between linear (4) and the limit (10), and the
 *     small and big runs were measured in two separate blocks, so a noisy neighbor on a shared
 *     runner during one block moved the ratio by tens of percent.
 * What changed, and why each part is there:
 *   1. An 8x step with a limit of 20. Linear (8) now has 2.5x of room and quadratic (64) is still
 *      more than 3x over the limit, so a real regression is as loud as before and a noisy runner
 *      has twice as much room.
 *   2. Interleaved measurement: small, big, small, big, ... so both sizes see the same machine
 *      noise (a burst of contention hits a neighboring pair, not just one size).
 *   3. The lowest per-call CPU time for each size. Interference only ever adds time, so the
 *      minimum over many samples is the honest cost, and more samples only make it more honest.
 *      If the ratio is still at or over the limit after ROUNDS samples, up to EXTRA_ROUNDS more
 *      pairs are taken before the verdict. A quadratic function stays near 64 however long this
 *      runs, so the extra rounds cannot hide a real regression.
 *   4. Each sample repeats the call until it costs at least MIN_SAMPLE_SECONDS of CPU, which keeps
 *      tick rounding to a few percent for the cheapest shapes. The repeat count is worked out per
 *      size and the ratio is taken per call, so the repeats cancel out.
 */
/** Each big input is this many times the small one. */
export const GROWTH_STEP = 8
/** Growth ratios at or above this fail. Linear is about 8, n log n about 9 to 10, quadratic about 64. */
export const GROWTH_LIMIT = 20

/** Each sample repeats the call until it costs at least this much CPU, in seconds. */
const MIN_SAMPLE_SECONDS = 0.06
const MAX_REPEATS = 200_000
/** Small and big samples taken as interleaved pairs before the verdict. */
const ROUNDS = 9
/** More pairs taken only while the ratio is still at or over the limit. */
const EXTRA_ROUNDS = 16
/** The usual small input, in characters. The big input is GROWTH_STEP times this. */
const DEFAULT_SMALL = 40_000

/** CPU seconds (user + system) for one sample of `repeats` calls of `fn`. */
function sampleSeconds(fn: () => void, repeats: number): number {
  const before = process.cpuUsage()
  for (let k = 0; k < repeats; k++) fn()
  const used = process.cpuUsage(before)
  return (used.user + used.system) / 1e6
}

/**
 * The repeat count that makes one sample cost at least MIN_SAMPLE_SECONDS of CPU. A first guess is
 * read from the fastest of a few warm calls in wall-clock time (a pause from another process only
 * ever makes a call look slower, so the minimum is the honest cost). Code keeps getting faster as
 * it warms up, so the guess is then checked against real CPU samples and raised until a sample
 * clears the target with some margin.
 */
function repeatsFor(fn: () => void): number {
  let wall = Infinity
  for (let i = 0; i < 5; i++) {
    const started = performance.now()
    fn()
    wall = Math.min(wall, (performance.now() - started) / 1000)
  }
  let repeats = Math.min(MAX_REPEATS, Math.max(1, Math.ceil(MIN_SAMPLE_SECONDS / Math.max(wall, 1e-6))))
  for (let attempt = 0; attempt < 4 && repeats < MAX_REPEATS; attempt++) {
    const used = sampleSeconds(fn, repeats)
    if (used >= MIN_SAMPLE_SECONDS * 1.1) break
    repeats = Math.min(MAX_REPEATS, Math.ceil((repeats * MIN_SAMPLE_SECONDS * 1.25) / Math.max(used, 1e-4)))
  }
  return repeats
}

/**
 * CPU time per call for the big input (GROWTH_STEP times `small`) divided by CPU time per call for
 * the small one. `make(n)` builds the input of size n and returns the function to time. Both are
 * run first, so the measurement is of warmed-up code.
 *
 * Callers lower `small` only when an input cap forces it, and say so in a comment.
 */
export function growthRatio(make: (n: number) => () => void, small: number = DEFAULT_SMALL): number {
  const smallFn = make(small)
  const bigFn = make(small * GROWTH_STEP)
  smallFn()
  bigFn()
  const smallRepeats = repeatsFor(smallFn)
  const bigRepeats = repeatsFor(bigFn)
  let bestSmall = Infinity
  let bestBig = Infinity
  const ratio = (): number => bestBig / Math.max(bestSmall, 1e-9)
  for (let round = 0; round < ROUNDS + EXTRA_ROUNDS; round++) {
    if (round >= ROUNDS && ratio() < GROWTH_LIMIT) break
    bestSmall = Math.min(bestSmall, sampleSeconds(smallFn, smallRepeats) / smallRepeats)
    bestBig = Math.min(bestBig, sampleSeconds(bigFn, bigRepeats) / bigRepeats)
  }
  const result = ratio()
  // Set GROWTH_LOG=1 to print every ratio (vitest labels each line with the test that printed it).
  if (process.env['GROWTH_LOG']) console.log(`GROWTH_RATIO ${result.toFixed(2)} small=${small}`)
  return result
}
