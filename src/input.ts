// Helpers that read caller-supplied values safely: once, without coercion,
// and with documented errors.

/** Longest text the kit will scan (UTF-16 code units). */
export const MAX_TEXT_LENGTH = 5_000_000

/** Longest array the kit will walk. */
export const MAX_ITEMS = 1_000_000

export function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') {
    // "Map", "Set", "Date" and so on say more than "object" when someone passes the wrong thing.
    const tag = Object.prototype.toString.call(value).slice(8, -1)
    return tag === 'Object' ? 'object' : tag
  }
  return typeof value
}

/**
 * A caller value as an error message may show it: a string is quoted and cut at 40 characters, a number or
 * boolean is printed, anything else is only named. It never calls the value's own `toString`.
 */
export function show(value: unknown, max = 40): string {
  if (typeof value === 'string') return JSON.stringify(value.length > max ? `${value.slice(0, max)}...` : value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || value === undefined || value === null) return String(value)
  return describe(value)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * Read an options bag: every allowed key exactly once, unknown keys rejected
 * (a typo must not silently turn a check off). `undefined` and `null` mean "no options".
 */
export function readOptions<K extends string>(
  options: unknown,
  allowed: readonly K[],
  where: string,
): Partial<Record<K, unknown>> {
  // No prototype: a key the caller did not set must read as absent, not as something planted on Object.prototype.
  const out = noProto({}) as Partial<Record<K, unknown>>
  if (options === undefined || options === null) return out
  // A plain object only: a Map or a Set has no own keys, so its settings would be dropped without a word.
  if (typeof options !== 'object' || describe(options) !== 'object') {
    throw new TypeError(`${where}: options must be an object, got ${describe(options)}.`)
  }
  const bag = options as Record<string, unknown>
  for (const key of Object.keys(bag)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new RangeError(`${where}: unknown option ${show(key)}. Known options: ${allowed.join(', ')}.`)
    }
  }
  for (const key of allowed) {
    const value = getOwn(bag, key)
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * A copy with no prototype. Objects the kit builds with optional fields (tokens, groups, suffix records) read a
 * missing field as undefined, never as something planted on `Object.prototype`.
 */
export function noProto<T extends object>(value: T): T {
  return Object.assign(new NoProtoRecord(), value)
}

/**
 * The instances' prototype chain ends before `Object.prototype`. Unlike `Object.create(null)` the instances keep
 * fast property access and a compact layout, which matters for the millions of tokens a large evidence text makes.
 */
class NoProtoRecord {}
Object.setPrototypeOf(NoProtoRecord.prototype, null)

/**
 * A key the caller wrote that is a near miss of one the kit knows ("scael" for "scale", "amout" for "amount", "Currency"
 * for "currency"), or undefined. An object may carry other data (a database row, a thenable), so only a probable typo is
 * an error: it would otherwise silently turn a hint off. `present` lists the keys the caller wrote: next to its own `id`
 * or `text`, a key such as `uid`, `idx` or `texts` is other data, and so is a plural of any known name that is there.
 */
export function nearMiss(key: string, known: readonly string[], present: readonly string[] = []): string | undefined {
  if (known.includes(key) || key.length > 24) return undefined
  const lower = key.toLowerCase()
  for (const k of known) {
    const kl = k.toLowerCase()
    // The key it would be a typo of is there too, so this one is some other field of the caller's: a neighbor of a short
    // name ("uid", "idx", "ids" beside "id"), or a plural or underscored form ("labels", "text_") of any name. A close
    // misspelling of a longer name still is an error beside the real one ("amout" next to "amount").
    if (present.includes(k) && (k.length <= 4 || lower === `${kl}s` || lower === `${kl}_`)) continue
    if (lower === kl) return k
    const limit = k.length <= 5 ? 1 : 2
    if (Math.abs(k.length - key.length) <= limit && editDistance(lower, kl) <= limit) return k
    // A long hint name written short or differently ("scaleApply", "scaleapply" for "scaleApplies").
    if (k.length >= 8 && lower.length >= 8 && commonPrefix(lower, kl) >= 8) return k
  }
  return undefined
}

function commonPrefix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

/** Damerau-Levenshtein distance (insert, delete, replace, swap two neighbors) of two short strings. */
function editDistance(a: string, b: string): number {
  const d: number[][] = []
  for (let i = 0; i <= a.length; i++) d.push(new Array<number>(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) (d[i] as number[])[0] = i
  for (let j = 0; j <= b.length; j++) (d[0] as number[])[j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i] as number[]
      const prev = d[i - 1] as number[]
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j] as number, ((d[i - 2] as number[])[j - 2] as number) + 1)
      }
    }
  }
  return (d[a.length] as number[])[b.length] as number
}

/**
 * Read a property the caller set on this very object. An inherited property (one planted on `Object.prototype`, or
 * a getter on a class prototype) reads as absent, so nothing outside the caller's own object can change a verdict.
 */
export function getOwn(object: object, key: string): unknown {
  return Object.hasOwn(object, key) ? (object as Record<string, unknown>)[key] : undefined
}

export function readBoolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean, got ${describe(value)}.`)
  return value
}

export function readInteger(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer, got ${describe(value)}.`)
  }
  if (value < min || value > max) throw new RangeError(`${name} must be between ${min} and ${max}, got ${value}.`)
  return value
}

/** Snapshot an array once: bounded length, no holes. Items are read exactly once. */
export function snapshotArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array, got ${describe(value)}.`)
  const length = (value as { length: number }).length
  if (!Number.isSafeInteger(length) || length < 0) throw new TypeError(`${name} has an invalid length.`)
  if (length > MAX_ITEMS) throw new RangeError(`${name} has ${length} items; the limit is ${MAX_ITEMS}.`)
  const out: unknown[] = new Array<unknown>(length)
  const source = value as unknown[]
  for (let i = 0; i < length; i++) {
    // An absent index must stay absent: a hole may not read an item inherited from the prototype.
    if (!Object.hasOwn(source, i)) throw new TypeError(`${name}[${i}] is missing (sparse arrays and undefined items are rejected).`)
    const item = source[i]
    if (item === undefined) throw new TypeError(`${name}[${i}] is missing (sparse arrays and undefined items are rejected).`)
    out[i] = item
  }
  return out
}
