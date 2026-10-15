// Shared by scripts/crosscheck.mjs (runs against dist/) and test/*-crosscheck.test.ts (runs against src/).
// Dev-only: nothing here is part of the package. Two reference points:
//   - Node's own Intl (ICU/CLDR): how every locale prints a number and in which order it writes a numeric date;
//   - Python's decimal and fractions (scripts/crosscheck-decimal.py): rounding and the derivations, exactly.

// ---------------------------------------------------------------- seeded cases
export function lcg(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const pick = (rnd, list) => list[Math.floor(rnd() * list.length)]
const between = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
function digits(rnd, n, noLeadingZero = true) {
  let s = ''
  for (let i = 0; i < n; i++) s += String(between(rnd, noLeadingZero && i === 0 ? 1 : 0, 9))
  return s
}
function decimal(rnd, intDigits, fracDigits, { negative = false, nonZero = true } = {}) {
  let s = digits(rnd, intDigits)
  if (fracDigits > 0) s += `.${digits(rnd, fracDigits, false)}`
  if (nonZero && /^[0.]+$/.test(s)) s = '1' + s.slice(1)
  return negative && rnd() < 0.5 ? `-${s}` : s
}

const DERIVATIONS = ['sum', 'difference', 'ratio', 'percent-change', 'percent-of', 'average', 'product']

/** A deterministic grid of cases. `n` is roughly the number of cases of each of the five kinds scaled by `weights`. */
export function generateCases(seed, n) {
  const rnd = lcg(seed)
  const cases = []
  const add = (c) => cases.push(c)
  for (let i = 0; i < Math.round(n * 0.2); i++) {
    // rounding of the kernel: a third of the cases sit exactly on a tie
    const s = between(rnd, -3, 8)
    let v
    if (i % 3 === 0) {
      // an exact tie: the kept digits, then a 5 one place past the rounding position
      if (s > 0) v = `${digits(rnd, between(rnd, 1, 25))}.${digits(rnd, s, false)}5`
      else if (s === 0) v = `${digits(rnd, between(rnd, 1, 25))}.5`
      else v = `${digits(rnd, between(rnd, 1, 10))}5${'0'.repeat(-s - 1)}`
    } else v = decimal(rnd, between(rnd, 1, 30), between(rnd, 0, 12), { nonZero: false })
    add({ k: 'R', v, s, m: i % 2 === 0 ? 'u' : 'e' })
  }
  for (let i = 0; i < Math.round(n * 0.1); i++) {
    add({ k: 'A', a: decimal(rnd, between(rnd, 1, 30), between(rnd, 0, 8), { negative: true }), b: decimal(rnd, between(rnd, 1, 30), between(rnd, 0, 8), { negative: true }), op: i % 2 === 0 ? '+' : '-' })
  }
  for (let i = 0; i < Math.round(n * 0.1); i++) {
    add({ k: 'Q', a: decimal(rnd, between(rnd, 1, 20), between(rnd, 0, 6), { negative: true }), b: decimal(rnd, between(rnd, 1, 20), between(rnd, 0, 6), { negative: true }), op: pick(rnd, ['/', '*', 'pct', 'pctchg']) })
  }
  for (let i = 0; i < Math.round(n * 0.2); i++) {
    const f = between(rnd, 2, 6)
    add({ k: 'T', v: decimal(rnd, between(rnd, 1, 6), f, { negative: true }), p: between(rnd, 0, Math.min(4, f - 1)) })
  }
  for (let i = 0; i < Math.round(n * 0.4); i++) {
    let a = decimal(rnd, between(rnd, 1, 4), between(rnd, 1, 3))
    let b = decimal(rnd, between(rnd, 1, 4), between(rnd, 1, 3))
    if (Number(a) === Number(b)) b = `${Math.floor(Number(b)) + 1}.5`
    if (rnd() < 0.5 && Number(a) > Number(b)) [a, b] = [b, a] // half of the cases have the later number larger
    add({ k: 'D', op: DERIVATIONS[i % DERIVATIONS.length], a, b, p: between(rnd, 1, 4) })
  }
  return cases
}

// ---------------------------------------------------------------- checking the kit against the reference answers
const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a }

/**
 * Compare the kit with the reference answer for one case. `kit.traceNumbers` is the public function; `dec` holds the
 * internal decimal helpers (src/decimal.ts or dist/decimal.js). Returns a list of mismatch descriptions (empty when all agree)
 * and the number of individual checks made.
 */
export function checkCase(kit, dec, c, expected) {
  const bad = []
  let checks = 0
  const status = (output, evidence, options) => {
    const r = kit.traceNumbers(output, evidence, options)
    const nums = r.numbers
    return nums.length === 1 ? `${nums[0].status}${nums[0].reason ? `/${nums[0].reason}` : ''}` : `numbers=${nums.length}`
  }
  if (c.k === 'R') {
    checks++
    const got = dec.roundRat(dec.toRat(dec.parseDecimal(c.v.replace(/^-/, ''))), c.s, c.m === 'u' ? 'half-up' : 'half-even').mantissa.toString()
    if (got !== expected.e) bad.push(`R ${c.v} s=${c.s} ${c.m}: kit ${got}, reference ${expected.e}`)
  } else if (c.k === 'A') {
    checks++
    const a = dec.parseDecimal(c.a)
    const b = dec.parseDecimal(c.b)
    const got = dec.formatDec(c.op === '+' ? dec.add(a, b) : dec.sub(a, b))
    if (got !== expected.e) bad.push(`A ${c.a} ${c.op} ${c.b}: kit ${got}, reference ${expected.e}`)
  } else if (c.k === 'Q') {
    checks++
    const A = dec.toRat(dec.parseDecimal(c.a))
    const B = dec.toRat(dec.parseDecimal(c.b))
    const hundred = { p: 100n, q: 1n }
    let r
    if (c.op === '/') r = dec.ratDiv(A, B)
    else if (c.op === '*') r = dec.ratMul(A, B)
    else if (c.op === 'pct') { const d = dec.ratDiv(A, B); r = d && dec.ratMul(d, hundred) }
    else { const d = dec.ratDiv(dec.ratSub(B, A), A); r = d && dec.ratMul(d, hundred) }
    let got = 'null'
    if (r) { const g = gcd(r.p, r.q); const q = r.q / g; got = `${r.p / g}/${q}` }
    if (got !== expected.e) bad.push(`Q ${c.a} ${c.op} ${c.b}: kit ${got}, reference ${expected.e}`)
  } else if (c.k === 'T') {
    for (const { y, expect } of expected.ys) {
      checks++
      const got = status(`Value: ${y}`, `Value: ${c.v}`, {})
      const ok = expect === 'unknown' ? got.startsWith('unknown') : got === expect
      if (!ok) bad.push(`T value ${c.v} written as ${y}: kit ${got}, reference ${expect}`)
    }
  } else if (c.k === 'D') {
    for (const { y, expect } of expected.ys) {
      checks++
      const got = status(`Gamma is ${y}.`, `Alpha is ${c.a}. Beta is ${c.b}.`, { derivations: [c.op] })
      const ok = expect === 'unknown' ? got.startsWith('unknown') : got === expect
      if (!ok) bad.push(`D ${c.op} of ${c.a} and ${c.b}, ${y}: kit ${got}, reference ${expect}`)
    }
  }
  return { bad, checks }
}

// ---------------------------------------------------------------- ICU
const REGION_CODES = (() => { const out = []; for (let i = 65; i <= 90; i++) for (let j = 65; j <= 90; j++) out.push(String.fromCharCode(i, j)); return out })()
const EXTRA_TAGS = ['sr-Latn', 'sr-Cyrl', 'sr-Latn-RS', 'sr-Cyrl-RS', 'zh-Hans', 'zh-Hant', 'zh-Hans-CN', 'zh-Hant-TW', 'zh-Hant-HK', 'hi-Latn', 'uk-UA', 'nb-NO', 'nn-NO', 'es-419', 'en-150', 'en-001']

/** Every locale tag for the given languages that this ICU has its own data for (the tag resolves to itself). */
export function icuLocales(languages) {
  const tags = []
  const ok = (tag) => { try { return new Intl.NumberFormat(tag).resolvedOptions().locale === tag } catch { return false } }
  for (const lang of languages) {
    if (ok(lang)) tags.push(lang)
    for (const r of REGION_CODES) if (ok(`${lang}-${r}`)) tags.push(`${lang}-${r}`)
  }
  for (const t of EXTRA_TAGS) if (!tags.includes(t) && languages.includes(t.split('-')[0]) && ok(t)) tags.push(t)
  return [...new Set(tags)]
}

const GRID_INTS = ['0', '7', '42', '999', '1000', '1234', '9999', '12345', '100000', '1234567', '12345678', '123456789', '1000000000']
const GRID_DECS = ['0.5', '1.5', '12.25', '123.456', '1234.5', '1234.56', '12345.678', '1234567.891', '0.001', '0.0001', '100.00', '1000.10', '999999.99']
const GROUPING = [undefined, 'always', 'min2', false]

/** The numbers every locale is asked to print: exact decimal strings, so no float is involved. */
export function icuGrid() {
  const out = []
  for (const t of [...GRID_INTS, ...GRID_DECS]) { out.push(t); if (t !== '0') out.push(`-${t}`) }
  return out
}

/**
 * Print the grid in one locale with ICU and read it back with the kit. Also compares the kit's decimal mark and numeric-date order
 * with ICU's. Returns { mismatches, prints, ambiguous }.
 */
export function checkLocale(extractNumbers, resolveLocale, tag) {
  const mismatches = []
  let prints = 0
  let ambiguous = 0
  let info
  try { info = resolveLocale(tag) } catch (e) { return { mismatches: [`${tag}: the kit does not accept this tag: ${String(e?.message ?? e).slice(0, 80)}`], prints, ambiguous } }
  const parts = new Intl.NumberFormat(tag, { minimumFractionDigits: 1 }).formatToParts(1.5)
  const mark = parts.find((p) => p.type === 'decimal')?.value
  if (mark !== undefined && mark.charCodeAt(0) !== info.decimal) mismatches.push(`${tag}: ICU decimal mark ${JSON.stringify(mark)}, the kit reads ${JSON.stringify(String.fromCharCode(info.decimal))}`)
  for (const text of icuGrid()) {
    const f = text.includes('.') ? text.split('.')[1].length : 0
    for (const grouping of GROUPING) {
      const printed = new Intl.NumberFormat(tag, { minimumFractionDigits: f, maximumFractionDigits: f, ...(grouping === undefined ? {} : { useGrouping: grouping }) }).format(text)
      prints++
      const tokens = extractNumbers(printed, { locale: tag })
      if (tokens.length !== 1) { mismatches.push(`${tag}: ${JSON.stringify(printed)} (${text}) reads as ${tokens.length} numbers`); continue }
      const t = tokens[0]
      if (t.ambiguous) {
        ambiguous++
        const readings = [t.value, ...(t.alternates ?? []).map((a) => a.value)]
        if (!readings.includes(text)) mismatches.push(`${tag}: ${JSON.stringify(printed)} is ambiguous but none of its readings is ${text} (${readings.join(', ')})`)
      } else if (t.value !== text) mismatches.push(`${tag}: ${JSON.stringify(printed)} read as ${t.value}, ICU printed ${text}`)
    }
  }
  // numeric date order: day or month first, for locales whose short numeric date does not start with the year
  const dateParts = new Intl.DateTimeFormat(tag, { year: 'numeric', month: 'numeric', day: 'numeric', numberingSystem: 'latn', calendar: 'gregory' }).formatToParts(new Date(Date.UTC(2026, 10, 13)))
  const order = dateParts.filter((p) => p.type === 'day' || p.type === 'month' || p.type === 'year').map((p) => p.type)
  if (order[0] !== 'year' && order.length === 3) {
    const icuOrder = order.indexOf('month') < order.indexOf('day') ? 'MDY' : 'DMY'
    if (icuOrder !== info.order) mismatches.push(`${tag}: ICU writes numeric dates ${order.join('/')} (${icuOrder}), the kit reads ${info.order}`)
  }
  return { mismatches, prints, ambiguous }
}

const STYLE_VALUES = [['1234.5', 2], ['1234567.25', 2], ['0.99', 2], ['12.00', 2]]
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'INR']

/**
 * Currency and percent styles in one locale: the amount must read back exactly (a currency word the kit does not know is read as a
 * plain number), and a percent must read as a percent. Two printings are skipped because the README says they are not read: a percent sign
 * written before the number (Turkish `%12,34`), and the Cape Verdean `1234$50`, where the cifrao is the decimal mark.
 * Returns { mismatches, prints }.
 */
export function checkLocaleStyles(extractNumbers, tag) {
  const mismatches = []
  let prints = 0
  const reads = (printed, want, kinds) => {
    const toks = extractNumbers(printed, { locale: tag })
    if (toks.length !== 1) return `${toks.length} numbers`
    const t = toks[0]
    const readings = [t.value, ...(t.alternates ?? []).map((a) => a.value)]
    if (!kinds.includes(t.kind)) return `kind ${t.kind}`
    return t.value === want || (t.ambiguous && readings.includes(want)) ? null : `value ${t.value}`
  }
  for (const currency of CURRENCIES) {
    for (const display of ['symbol', 'code']) {
      for (const [v] of STYLE_VALUES) {
        const places = currency === 'JPY' ? 0 : 2
        const text = currency === 'JPY' ? String(Math.round(Number(v))) : v
        const want = currency === 'JPY' ? text : Number(text).toFixed(2)
        const printed = new Intl.NumberFormat(tag, { style: 'currency', currency, currencyDisplay: display, minimumFractionDigits: places, maximumFractionDigits: places }).format(text)
        prints++
        if (/\d\$\d/.test(printed)) continue
        // a locale's own currency word or symbol (a Bulgarian dollar is `щ.д.`) is not in the kit's list: the amount still reads exactly, as a plain number
        const why = reads(printed, want, ['currency', 'decimal', 'count'])
        if (why) mismatches.push(`${tag}: ${currency} ${display} ${JSON.stringify(printed)} (${want}): ${why}`)
      }
    }
  }
  for (const [value, want] of [['0.1234', '12.34'], ['0.5', '50'], ['12.5', '1250'], ['0.075', '7.5']]) {
    const places = want.includes('.') ? want.split('.')[1].length : 0
    const printed = new Intl.NumberFormat(tag, { style: 'percent', minimumFractionDigits: places, maximumFractionDigits: places }).format(value)
    prints++
    if (/^[^\d]*%/.test(printed) && !/\d\s*%/.test(printed)) continue
    const why = reads(printed, want, ['percent'])
    if (why) mismatches.push(`${tag}: percent ${JSON.stringify(printed)} (${want}): ${why}`)
  }
  return { mismatches, prints }
}

