// Helpers that read caller-supplied values safely: once, without coercion,
// and with documented errors.

/** Longest text the kit will scan (UTF-16 code units). */
export const MAX_TEXT_LENGTH = 5_000_000

/** Longest array the kit will walk. */
export const MAX_ITEMS = 1_000_000

export function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
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
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError(`${where}: options must be an object, got ${describe(options)}.`)
  }
  const bag = options as Record<string, unknown>
  for (const key of Object.keys(bag)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new RangeError(`${where}: unknown option "${key}". Known options: ${allowed.join(', ')}.`)
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
