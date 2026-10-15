/**
 * Shared harness for the "linear time" tests: how much more CPU does 4x the input cost?
 *
 * Linear code grows by about 4x and quadratic code by about 16x, so GROWTH_LIMIT sits between
 * them. test/growth-harness.test.ts proves this harness still fails a quadratic function at that
 * limit, so the limit cannot be loosened into a pass-everything check without that test failing.
 *
 * Why each measurement repeats the work: process.cpuUsage() counts CPU in scheduler ticks of
 * about 1 to 4 ms on a Linux runner. The 40k-character runs of most shapes take 3 to 5 ms, so a
 * single call was mostly tick rounding. On the GitHub Actions runners (Node 22.12.0 and Node 22)
 * that read a linear function as 10.57 ("grouped thousands") and 10.08 ("dotted two-digit-year
 * dates") against a limit of 10; the same shapes measured 4 to 9 on a quiet laptop. Repeating the
 * call until the smaller input costs at least MIN_SECONDS of CPU makes the rounding error small
 * (a few percent) and leaves the ratio itself unchanged, because both sizes repeat equally.
 */
/** Growth ratios at or above this fail. Linear is about 4, quadratic about 16. */
export const GROWTH_LIMIT = 10

/** Wall-clock target for the repeated small run, in seconds. */
const MIN_SECONDS = 0.06
const MAX_REPEATS = 2_000
const RUNS = 5
/** Guards the division when the smaller input is almost free. */
const FLOOR_SECONDS = 0.01

/** Best-of-RUNS CPU seconds (user + system) for `repeats` calls of `fn`. */
export function cpuSeconds(fn: () => void, repeats = 1, runs = RUNS): number {
  let best = Infinity
  for (let i = 0; i < runs; i++) {
    const before = process.cpuUsage()
    for (let k = 0; k < repeats; k++) fn()
    const used = process.cpuUsage(before)
    best = Math.min(best, (used.user + used.system) / 1e6)
  }
  return best
}

/**
 * CPU time for the large input divided by CPU time for the small one (4x the size by default).
 * Both are run once first, so the measurement is of warmed-up code.
 */
export function growthRatio(make: (n: number) => () => void, sizes: { small: number; large: number } = { small: 40_000, large: 160_000 }): number {
  const small = make(sizes.small)
  const large = make(sizes.large)
  small()
  large()
  // The fastest of a few warm calls, in wall-clock time: a pause from another process only ever
  // makes a call look slower, so the minimum is the honest cost and the repeat count stays stable.
  let wall = Infinity
  for (let i = 0; i < 5; i++) {
    const started = performance.now()
    small()
    wall = Math.min(wall, (performance.now() - started) / 1000)
  }
  const repeats = Math.min(MAX_REPEATS, Math.max(1, Math.ceil(MIN_SECONDS / Math.max(wall, 1e-6))))
  return cpuSeconds(large, repeats) / Math.max(cpuSeconds(small, repeats), FLOOR_SECONDS)
}
