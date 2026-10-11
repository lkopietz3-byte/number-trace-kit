import { describe, expect, it } from 'vitest'
import { extractNumbers, traceNumbers } from '../src/index.js'
import type { NumberToken, TraceResult } from '../src/index.js'

// A seeded combinatorial sweep. Numbers are generated from a grammar of forms
// (integers, decimals, locale-printed numbers, percents, currencies, magnitudes,
// scientific notation, units, ranges, dimensions, dates, signs) inside varied
// contexts, and four invariants are checked:
//   (a) a number whose value, kind and unit appear in the evidence, written
//       another way, is never untraced (and is traced unless a documented
//       ambiguity says unknown);
//   (b) a number whose value or unit does not appear in the evidence is never
//       traced, rounded or derived;
//   (c) exact equivalents trace in both directions;
//   (d) NFC and NFD text, and full-width and ASCII text, give the same statuses.

interface Variant {
  readonly text: string
  readonly locale?: string
}

type Rng = () => number

// SWEEP_SEED shifts every seed, to hunt with fresh draws; the committed run uses 0.
const SEED_SHIFT = Number(process.env['SWEEP_SEED'] ?? 0)

function lcg(seed: number): Rng {
  let s = (seed + SEED_SHIFT * 7919) >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function pick<T>(rnd: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rnd() * items.length)]
  if (item === undefined) throw new Error('empty pick')
  return item
}

function group(n: string): string {
  const [int = '', frac] = n.split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return frac === undefined ? grouped : `${grouped}.${frac}`
}

const INTS = ['3', '7', '12', '45', '99', '250', '1234', '5678', '45000', '1250000']
const DECS = ['0.5', '2.5', '12.5', '99.99', '1234.5', '0.07', '12.50', '3.14']

/** Forms of one number, each variant meaning the same value, kind and unit. */
const FORMS: ReadonlyArray<(rnd: Rng) => Variant[]> = [
  (r) => {
    const n = pick(r, INTS)
    return [{ text: n }, { text: group(n) }, { text: `${n}.0` }]
  },
  (r) => {
    const n = pick(r, DECS)
    return [{ text: n }, { text: group(n) }, { text: n.replace(/0+$/, '').replace(/\.$/, '') }]
  },
  (r) => {
    const n = pick(r, [...INTS.slice(0, 5), ...DECS.slice(0, 4)])
    return [{ text: `${n}%` }, { text: `${n} %` }, { text: `${n} percent` }, { text: `${n} per cent` }, { text: `${n}pct` }]
  },
  (r) => {
    const n = pick(r, ['0.5', '2', '12.5'])
    return [{ text: `${n} pp` }, { text: `${n} percentage points` }, { text: `${n}pp` }]
  },
  (r) => {
    const n = pick(r, INTS.slice(0, 8))
    return [{ text: `$${group(n)}` }, { text: `USD ${n}` }, { text: `${n} USD` }, { text: `${n} dollars` }, { text: `US$${n}` }]
  },
  (r) => {
    const n = pick(r, INTS.slice(0, 8))
    return [{ text: `€${group(n)}` }, { text: `EUR ${n}` }, { text: `${n} euros` }, { text: `${n} EUR` }]
  },
  (r) => {
    const n = pick(r, ['1.2', '3.4', '5', '2.5'])
    const full = (Number(n) * 1_000_000).toString()
    return [{ text: `$${n}M` }, { text: `$${n} million` }, { text: `${n} million dollars` }, { text: `$${group(full)}` }]
  },
  (r) => {
    const n = pick(r, ['3', '7', '2.5'])
    const full = n.includes('.') ? '2500000000' : `${n}000000000`
    return n.includes('.')
      ? [{ text: `${n} billion` }, { text: `${n} bn` }, { text: group(full) }]
      : [{ text: `${n} billion` }, { text: `${n} bn` }, { text: group(full) }]
  },
  (r) => {
    const n = pick(r, ['5', '12'])
    return [{ text: `${n} thousand` }, { text: `${n},000` }, { text: `${n}000` }]
  },
  (r) => {
    const n = pick(r, ['1.5e3', '2e4', '6.25e2'])
    const plain = String(Number(n))
    return [{ text: n }, { text: plain }, { text: group(plain) }]
  },
  (r) => {
    const n = pick(r, ['5', '20', '2.5'])
    const unit = pick(r, [['kg', 'kg', 'kilograms'], ['mg', 'mg', 'mg'], ['km', 'km', 'kilometers']] as const)
    return [{ text: `${n}${unit[0]}` }, { text: `${n} ${unit[1]}` }, { text: `${n} ${unit[2]}` }]
  },
  (r) => {
    const n = pick(r, ['5', '20', '3'])
    return [{ text: `${n} days` }, { text: `${n}-day` }, { text: `${n} day` }]
  },
  (r) => {
    const n = pick(r, ['5', '20', '2.5'])
    return [{ text: `${n}µm` }, { text: `${n} μm` }, { text: `${n}μm` }, { text: `${n} µm` }]
  },
  (r) => {
    const a = pick(r, ['10', '3', '25'])
    const b = String(Number(a) + 2)
    return [{ text: `${a}-${b}` }, { text: `${a}–${b}` }, { text: `${a} to ${b}` }, { text: `${a} and ${b}` }]
  },
  (r) => {
    const a = pick(r, ['10', '3', '25'])
    const b = String(Number(a) + 2)
    return [{ text: `${a}-${b}%` }, { text: `${a}% and ${b}%` }, { text: `${a} to ${b} percent` }, { text: `${a}–${b} %` }]
  },
  (r) => {
    const a = pick(r, ['1', '2', '5'])
    const b = String(Number(a) + 1)
    return [{ text: `$${a}-${b}M` }, { text: `$${a} million and $${b} million` }, { text: `$${a}M to $${b}M` }]
  },
  (r) => {
    const a = pick(r, ['3', '12', '40'])
    const b = pick(r, ['4', '15', '60'])
    return [{ text: `${a} x ${b} cm` }, { text: `${a}x${b} cm` }, { text: `${a} cm by ${b} cm` }, { text: `${a} × ${b} cm` }]
  },
  () => [{ text: '2026-10-05' }, { text: 'October 5, 2026' }, { text: '5 October 2026' }, { text: 'Oct 5 2026' }],
  () => [{ text: '2026-10-13' }, { text: '13/10/2026' }, { text: 'October 13, 2026' }, { text: '13th of October, 2026' }],
  () => [{ text: '14:05' }, { text: '14:05' }],
  (r) => {
    const n = pick(r, ['1,234', '12,500', '99.5'])
    const plain = n.replace(/,/g, '')
    return [{ text: `(${n})` }, { text: `-${n}` }, { text: `−${plain}` }]
  },
  (r) => {
    const n = pick(r, ['5', '1,200'])
    return [{ text: `($${n})` }, { text: `-$${n}` }, { text: `$-${n.replace(/,/g, '')}` }]
  },
  (r) => {
    const n = pick(r, ['12.5', '3'])
    return [{ text: `(${n}%)` }, { text: `-${n}%` }]
  },
  () => [{ text: '3/4' }, { text: '3/4' }],
  () => [{ text: '1/2/3' }, { text: '1/2/3' }],
  (r) => {
    const n = pick(r, ['12.5', '45'])
    return [{ text: `${n}%` }, { text: n.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d))).replace('.', '．') + '％' }]
  },
  (r) => {
    const n = pick(r, ['1234', '45', '987'])
    return [
      { text: n },
      { text: n.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d))) },
      { text: n.replace(/\d/g, (d) => String.fromCharCode(0x0966 + Number(d))) },
      { text: n.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d))) },
    ]
  },
  () => [{ text: '31/12/2026' }, { text: '2026-12-31' }, { text: 'December 31, 2026' }, { text: '31 December 2026' }],
  () => [{ text: 'Sept. 5th, 2026' }, { text: '2026-09-05' }, { text: 'September 5 2026' }],
  () => [{ text: '13.10.2026', locale: 'de-DE' }, { text: '2026-10-13', locale: 'en-US' }],
  () => [{ text: '3,14', locale: 'de-DE' }, { text: '3.14', locale: 'en-US' }],
  (r) => {
    const n = pick(r, ['5', '250', '1200'])
    return [{ text: `${n} \u20ac` }, { text: `\u20ac${n}` }, { text: `${n} EUR` }, { text: `EUR ${n}` }]
  },
  (r) => {
    const n = pick(r, ['5', '250'])
    return [{ text: `CA$${n}` }, { text: `${n} CAD` }, { text: `CAD ${n}` }]
  },
  (r) => {
    const n = pick(r, ['5', '250'])
    return [{ text: `A$${n}` }, { text: `${n} AUD` }, { text: `AUD ${n}` }]
  },
  () => [{ text: '\u00a31.2bn' }, { text: '\u00a31.2 billion' }, { text: '\u00a31,200,000,000' }],
  () => [{ text: '5.5 hrs' }, { text: '5.5 hours' }, { text: '5.5 hour' }],
  () => [{ text: '10 minutes' }, { text: '10 min' }, { text: '10 mins' }],
  () => [{ text: '2.5 GB' }, { text: '2.5 gb' }, { text: '2.5GB' }],
  () => [{ text: '1e-3 kg' }, { text: '0.001 kg' }, { text: '0.001kg' }],
  () => [{ text: '+5%' }, { text: '+5 %' }, { text: '5%' }],
  () => [{ text: '2 x 3 x 4 m' }, { text: '2 m by 3 m by 4 m' }, { text: '2x3x4 m' }],
  () => [{ text: '.5%' }, { text: '0.5%' }, { text: '0.5 percent' }, { text: '.5 %' }],
  () => [{ text: '$.99' }, { text: '$0.99' }, { text: 'USD 0.99' }],
  () => [{ text: '-.25' }, { text: '-0.25' }, { text: '\u2212.25' }],
  () => [{ text: '(.5%)' }, { text: '-0.5%' }, { text: '-.5%' }],
  () => [{ text: '.5 kg' }, { text: '0.5 kg' }, { text: '.5kg' }],
  () => [{ text: '-0.00%' }, { text: '-0.00 %' }],
  () => [{ text: '.5\u2013.7%' }, { text: '.5-.7%' }, { text: '.5 to .7%' }, { text: '0.5% and 0.7%' }],
  () => [{ text: '5 $.99' }, { text: '5 $0.99' }],
  () => [{ text: '.5 x .7 cm' }, { text: '0.5 x 0.7 cm' }, { text: '.5x.7 cm' }, { text: '0.5 cm by 0.7 cm' }],
  () => [{ text: '$.5-.7M' }, { text: '$0.5 million and $0.7 million' }, { text: '$500,000 to $700,000' }],
  () => [{ text: 'June 30, 2026' }, { text: '2026-06-30' }, { text: '30 June 2026' }, { text: '06/30/2026' }, { text: 'Jun 30 2026' }],
  () => [{ text: 'March 2026' }, { text: 'March 2026' }],
  (r) => {
    const n = pick(r, ['1.9', '0.5', '12'])
    return [{ text: `${n}c` }, { text: `${n} cents` }, { text: `${n}\u00a2` }]
  },
  () => [{ text: '(557)' }, { text: '-557' }],
  () => [{ text: '$(557)' }, { text: '-$557' }, { text: '($557)' }],
  () => [{ text: '10mo' }, { text: '10 months' }, { text: '10 month' }],
  () => [{ text: '2.4pts' }, { text: '2.4 pts' }, { text: '2.4pt' }],
  // Identifiers, versions and other things that are not claims.
  (r) => {
    const id = pick(r, ['v1.2.3', 'v1.2.3+4', '1.2.3-rc.1', '2.0.0-beta.2+build.5', '1.234.567-rc.1', 'X3', 'COVID-19', 'GPT-4', 'FY2025', 'Q3', 'H2O', 'iPhone15', '5G', 'A4', 'x86_64', '0x1F', '192.168.1.1'])
    return [{ text: id }, { text: id }]
  },
  // Things the kit must flag rather than trace.
  (r) => {
    const f = pick(r, ['10\u00b2', '5^2', '4K', '12,5', '1.234', '1.000/2.000', '3/4', '10/12/2026', 'Oct 5\u00b2', '2026-10-05\u00b2', '12,5K', '1.234\u20132M'])
    return [{ text: f }, { text: f }]
  },
  () => [{ text: 'in 2026' }, { text: 'for 2026' }, { text: 'by 2026' }],
  () => [{ text: 'FY2026' }, { text: 'FY2026' }],
  (r) => {
    const n = pick(r, ['1.2', '4', '2.5'])
    const full = String(Number(n) * 1_000_000)
    return [{ text: `${n} million kg` }, { text: `${group(full)} kg` }, { text: `${full}kg` }]
  },
  (r) => {
    const n = pick(r, ['1', '2.5'])
    const full = String(Number(n) * 1_000_000)
    return [{ text: `${n} million %` }, { text: `${full}%` }, { text: `${group(full)} %` }]
  },
  () => [{ text: '1.2e3 kg' }, { text: '1200 kg' }, { text: '1,200 kg' }],
  () => [{ text: 'Oct 5-7, 2026' }, { text: '5-7 October 2026' }, { text: 'Oct 5 to 7 2026' }],
  () => [{ text: '-5\u2013-3%' }, { text: '-5% and -3%' }],
  () => [{ text: '12,34,567', locale: 'en-IN' }, { text: '1234567', locale: 'en-US' }],
  () => [{ text: '1 234,50', locale: 'fr-FR' }, { text: '1234.50', locale: 'en-US' }, { text: '1\u00a0234,50', locale: 'fr-FR' }],
  () => [{ text: '1\'234\'567', locale: 'de-CH' }, { text: '1234567', locale: 'en-US' }],
  (r) => {
    const n = pick(r, ['3', '1st', '2nd'])
    return [{ text: n }, { text: n }]
  },
  () => [{ text: '5\u00b5m' }, { text: '5 \u03bcm' }, { text: '5\u03bcm' }],
  // Numbers as the platform prints them in other locales, against plain ASCII evidence.
  (r) => {
    const locale = pick(r, ['de-DE', 'fr-FR', 'en-IN', 'de-CH', 'es-ES', 'pt-BR', 'it-IT', 'en-GB'])
    const n = pick(r, ['1234567.5', '1234.56', '98765.4', '12.5'])
    const decimals = n.split('.')[1]?.length ?? 0
    const printed = new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n as unknown as number)
    return [{ text: printed, locale }, { text: n, locale: 'en-US' }]
  },
  (r) => {
    const locale = pick(r, ['de-DE', 'fr-FR', 'en-IN', 'en-GB', 'pt-BR'])
    const [currency, symbolOk] = pick(r, [['EUR', true], ['USD', true], ['GBP', true]] as const)
    const n = pick(r, ['1234567.5', '1234.56', '98765.4'])
    const printed = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: symbolOk ? 'code' : 'symbol' }).format(n as unknown as number)
    return [{ text: printed, locale }, { text: `${currency} ${n}`, locale: 'en-US' }]
  },
  (r) => {
    const locale = pick(r, ['de-DE', 'fr-FR', 'en-IN', 'en-GB', 'pt-BR', 'es-ES'])
    const printed = new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(0.125)
    return [{ text: printed, locale }, { text: '12.5%', locale: 'en-US' }]
  },
]

/**
 * Writings that share digits with one another but are not equivalent: the cases where a
 * careless matcher would call a number traced (or a careful one untraced). Used where the
 * oracle, not a promise of equivalence, decides what is allowed.
 */
const TEMPTING: ReadonlyArray<readonly string[]> = [
  ['12,5K', '12500', '12.5', '12,5K', '125'],
  ['12,5', '12.5', '12,5', '125', '12.50'],
  ['1.234', '1234', '1.234', '1,234', '1.2'],
  ['4K', '4000', '4', '4K', '4 thousand'],
  ['1.000/2.000', '1.000;2.000', '1000 and 2000', '1.000/2.000'],
  ['1/2/3', '1/2 and 2/3', '1 2 3', '1/2/3', '2/3'],
  ['1/2/3/45', '1 2 3 45; 2/3/45', '1/2/3/45'],
  ['10\u00b2', '10', '100', '10\u00b2', '10^2'],
  ['Oct 5\u00b2', 'Oct 5', 'October 5', '5'],
  ['2026-10-05\u00b2', '2026-10-05', 'October 5, 2026', '2026'],
  ['10/12/2026', '2026-10-12', 'Oct 12 2026', '10 and 12', 'Year 2026; month 10; day 12.', '10/12/2026', '12/10/2026'],
  ['2026-10-05', 'October 5;2026 kg', 'October 5;FY2026', 'October 5; in 2026', '2026-10-05', '2026'],
  ['5 kg', '5', '5 days', '5kg', '5 g', '5 kilograms'],
  ['45%', '45', '45 pp', '$45', '45 percent', '\u20ac45', '45 kg'],
  ['$45', 'USD 45', '45', '45 EUR', '45%', '45 dollars', 'CA$45'],
  ['5\u00b5m', '5 mm', '5 m', '5 \u03bcm', '5\u00b5', '5'],
  ['1 million kg', '1000000 days', '1,000,000 kg', '1 million', '1000000'],
  ['1 million %', '1000000', '1000000%', '1 million percent'],
  ['$1-2M', '$1000000 and $2000000', '1-2M', '$1M', '$1 and $2', '1000000'],
  ['1e3\u20132000 kg', '1000 kg; 2000 kg', '2000000 kg', '1000 kg'],
  ['1.234\u20132M', '1.234;2000000', '1234000000; 2000000', '1234; 2000000'],
  ['3 x 4 cm', '3 cm', '4 cm', '3 x 4', '3 cm by 4 cm', '3 days by 4 cm'],
  ['10x', '10 days', '10', '10x faster'],
  ['v1.2.3+4', '4', '1.2.3+4', 'v1.2.3+4'],
  ['4', 'v1.2.3+4', '1.2.3-rc.1', '4', 'build 4'],
  ['1.234.567-rc.1', '1234567', '1', '1.234.567-rc.1'],
  ['-5\u2013-3%', '-5% and -3%', '5% and 3%', '-5 and -3'],
  ['(1,234)', '-1,234', '1,234', '(1,234)'],
  ['($2024)', '-$2024', '$2024', '(2024)', '2024'],
  ['FY2025', '2025', 'FY2025'],
  ['\u212A3', 'K3', '3', '\u212B3'],
  ['12.3', '12.34', '12.3', '13', '12'],
  ['.5%', '5%', '0.5%', '.5', '5', '.55%', '0.05%'],
  ['$.99', '$99', '99', '$0.99', '.99'],
  ['-.25', '.25', '-25', '-0.25', '25'],
  ['-0.00%', '-0.004%', '0.004%', '0%', '-0%', '0.00%', '-0.00%'],
  ['1950-2200 kg', '2200 kg', '1950 kg', '1950-2200'],
  ['35%', '-30%', '-40%', '-35%', '70%'],
  ['.5', '0.5', '5', 'a .5', 'x.5', 'wait...5'],
  ['2000 x 3000 cm', '3000 cm', '2000 cm', '2000'],
  ['.5\u2013.7%', '0.5 and 7%', '0.5% and 0.7%', '.5 and .7', '5-7%'],
  ['5 $.99', '$5 and 0.99', '5 and 0.99', '5 and $0.99'],
  ['.5 x .7 cm', '.5 cm', '.7 cm', '5 x 7 cm', '0.5 x 0.7'],
  ['June 30, 2025', 'June 30, 2026', '2025-06-30', 'Sept 2025', '30 June 2026', 'June 30', '2025'],
  ['March 2026', 'March 2025', '2026', 'March 5, 2026'],
  ['1.9c', '1.7c', '1.9', '1.9 cents', '19c', '1.9\u00a2'],
  ['Llama-3.3-70B-Instruct', '70', '3.3', 'gpt-5.4-nano-2026-03-17', '2026', 'Qwen3-8B', '8'],
  ['(557)', '-557', '557', '$(557)', '-$557', '(558)'],
  ['10mo', '10 months', '10', '10 days', '10 mos'],
  ['7', '3 and 4', '7', '3 + 4'],
  ['5 g', '5 kg', '5 mg', '5', '5 grams'],
  ['3 months', '3 min', '3 mins', '3 minutes', '3'],
  ['1,2,3', '1.2.3', '1 2 3', '1,2'],
  ['A$5', '$5', '5 AUD', 'CA$5', '5 CAD'],
  ['31/12/26', '2026-12-31', '12/31/26', '31 Dec 2026'],
  ['2 x 3 x 4 m', '2 m', '3 m', '4 m', '2x3x4', '2 3 4'],
  ['5 \u2013 10%', '5%', '10%', '5 to 10', '5 and 10%'],
  ['1e3', '1000', '1e3 kg', '1e3%', '1.0e3'],
]

const SAFE_PREFIX = ['Total ', 'Result: ', 'We saw ', 'see ', 'approximately ', 'of ', '', 'The café reported ', 'Naïve estimate: ']
const SAFE_SUFFIX = ['.', ',', ' today', ' overall', ';', ' ok', ' (est)', '']

function formsFor(rnd: Rng, count: number, withTempting = false): Variant[][] {
  const out: Variant[][] = []
  for (let i = 0; i < count; i++) {
    if (withTempting && rnd() < 0.6) out.push(pick(rnd, TEMPTING).map((text) => ({ text })))
    else out.push(pick(rnd, FORMS)(rnd))
  }
  return out
}

function compose(rnd: Rng, parts: readonly string[]): string {
  return parts.map((p) => `${pick(rnd, SAFE_PREFIX)}${p}${pick(rnd, SAFE_SUFFIX)}`).join(' | ')
}

function localeOf(variants: readonly Variant[]): string {
  return variants.find((v) => v.locale !== undefined)?.locale ?? 'en-US'
}

function describeCase(output: string, evidence: string): string {
  return `output=${JSON.stringify(output)} evidence=${JSON.stringify(evidence)}`
}

function statuses(r: TraceResult): string[] {
  return r.numbers.map((n) => n.status)
}

const WEAK_REASONS = ['fraction', 'superscript', 'too-long', 'date-order', 'identifier']

/** A token whose primary reading is a guess or part of something the kit does not evaluate. */
function isWeak(t: NumberToken): boolean {
  return t.localeGuess === true || (t.ambiguous && t.ambiguity !== undefined && WEAK_REASONS.includes(t.ambiguity))
}

function classOf(t: NumberToken): string {
  return t.kind === 'percent' ? (t.unit === 'pp' ? 'pp' : 'pct')
    : t.kind === 'currency' ? `cur:${t.currency ?? ''}`
      : t.kind === 'date-part' ? 'date' : 'plain'
}

function canon(v: string): string {
  return v.replace(/^[-+]/, '').replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

function isNeg(v: string): boolean {
  return v.startsWith('-') && /[1-9]/.test(v)
}

/** Does the strong evidence contain this token (same value, class, unit, role, compatible sign)? */
function appears(out: NumberToken, evidence: readonly NumberToken[]): boolean {
  const oc = classOf(out)
  for (const e of evidence) {
    if (canon(e.value) !== canon(out.value)) continue
    // A bare "(557)" may be an accounting negative, so it answers to a minus sign too.
    if (out.signStyle === 'minus' && isNeg(out.value) !== isNeg(e.value) && e.parenthesized !== true) continue
    if (out.signStyle === 'plus' && isNeg(e.value)) continue
    const ec = classOf(e)
    if (oc === 'date' && ec === 'date') {
      if (out.part === e.part) return true
      continue
    }
    if (oc === 'date' || ec === 'date') {
      // A date's year and a bare year vouch for each other.
      // A date output needs unit-less evidence; a plain output with a unit may take a date's year (one-sided unit).
      const date = oc === 'date' ? out : e
      const other = oc === 'date' ? e : out
      if (date.part === 'year' && classOf(other) === 'plain' && (oc !== 'date' || other.unit === undefined)) return true
      continue
    }
    if (oc !== ec) continue
    if (oc === 'plain' && out.unit !== undefined && e.unit !== undefined && out.unit !== e.unit) continue
    return true
  }
  return false
}

/** Statuses an output token must not have, given the evidence. */
function forbidden(out: NumberToken, evidence: readonly NumberToken[]): readonly string[] {
  if (isWeak(out)) {
    // Only the same group written the same way (a fraction, a date) can vouch for it.
    const same = out.groupRaw !== undefined && evidence.some((e) => e.groupRaw === out.groupRaw && canon(e.value) === canon(out.value))
    return same ? [] : ['traced', 'rounded', 'derived']
  }
  const strong = evidence.filter((e) => !isWeak(e))
  return appears(out, strong) ? ['untraced'] : ['traced']
}

describe('sweep', { timeout: 300_000 }, () => {
  it('(e) traced and untraced agree with an independent reading of the evidence', () => {
    const rnd = lcg(0x5eed05)
    let present = 0
    let absent = 0
    for (let iter = 0; iter < 6000; iter++) {
      const outV = formsFor(rnd, 1 + Math.floor(rnd() * 3), true).map((f) => pick(rnd, f))
      const evV = formsFor(rnd, 1 + Math.floor(rnd() * 4), true).map((f) => pick(rnd, f))
      const mixed = (vs: Variant[]): boolean => new Set(vs.map((v) => v.locale ?? 'en-US')).size > 1
      if (mixed(outV) || mixed(evV)) continue
      const options = { locale: localeOf(outV), evidenceLocale: localeOf(evV) }
      const output = compose(rnd, outV.map((v) => v.text))
      const evidence = compose(rnd, evV.map((v) => v.text))
      const r = traceNumbers(output, evidence, options)
      const evTokens = extractNumbers(evidence, { locale: options.evidenceLocale })
      for (const n of r.numbers) {
        const ban = forbidden(n.token, evTokens)
        const why = `${describeCase(output, evidence)} -> ${n.token.raw}:${n.status}${n.reason === undefined ? '' : `(${n.reason})`}`
        if (ban.includes('untraced')) present++
        if (ban.includes('traced')) absent++
        expect(ban, why).not.toContain(n.status)
      }
    }
    expect(present).toBeGreaterThan(500)
    expect(absent).toBeGreaterThan(500)
  })

  it('(a, c) a number written another way is never untraced, in either direction', () => {
    const rnd = lcg(0x5eed01)
    for (let iter = 0; iter < 3000; iter++) {
      const forms = formsFor(rnd, 1 + Math.floor(rnd() * 3))
      for (const direction of [0, 1]) {
        // Pick two variants per form; swap them for direction 1.
        const picks = forms.map((f) => [pick(rnd, f), pick(rnd, f)] as const)
        const outVariants = picks.map(([a, b]) => (direction === 0 ? a : b))
        const evVariants = picks.map(([a, b]) => (direction === 0 ? b : a))
        // Variants of one form share one locale per side; mixed locales in one text are skipped.
        const outLocale = localeOf(outVariants)
        const evLocale = localeOf(evVariants)
        const mixed = (vs: Variant[]): boolean => new Set(vs.map((v) => v.locale ?? 'en-US')).size > 1
        if (mixed(outVariants) || mixed(evVariants)) continue
        const output = compose(rnd, outVariants.map((v) => v.text))
        const evidence = compose(rnd, evVariants.map((v) => v.text))
        const r = traceNumbers(output, evidence, { locale: outLocale, evidenceLocale: evLocale })
        const evAmbiguous = extractNumbers(evidence, { locale: evLocale }).some((t) => t.ambiguous)
        for (const n of r.numbers) {
          const why = `${describeCase(output, evidence)} -> ${n.token.raw}:${n.status}${n.reason === undefined ? '' : `(${n.reason})`}`
          expect(n.status, why).not.toBe('untraced')
          if (n.status === 'unknown') expect(n.token.ambiguous || evAmbiguous, why).toBe(true)
          // Equivalent writings of the same value are exact matches, never rounded or derived.
          if (!n.token.ambiguous && !evAmbiguous) expect(n.status, why).toBe('traced')
        }
      }
    }
  })

  it('(g) one-character perturbations of the same forms keep every invariant', () => {
    const rnd = lcg(0x5eed07)
    const nasty = ['\u00b2', '^', '-', '+', ' ', '/', '.', ',', 'x', 'e', '\u00b5', '%', '$', '(', ')', '\u200b', '\u0301', '\u212a', '_', '\u2013', 'K', 'M', ':', 'v']
    for (let iter = 0; iter < 6000; iter++) {
      const outV = formsFor(rnd, 1 + Math.floor(rnd() * 3), true).map((f) => pick(rnd, f))
      const evV = formsFor(rnd, 1 + Math.floor(rnd() * 4), true).map((f) => pick(rnd, f))
      const mixed = (vs: Variant[]): boolean => new Set(vs.map((v) => v.locale ?? 'en-US')).size > 1
      if (mixed(outV) || mixed(evV)) continue
      const options = { locale: localeOf(outV), evidenceLocale: localeOf(evV) }
      const perturb = (text: string): string => {
        const at = Math.floor(rnd() * (text.length + 1))
        return text.slice(0, at) + pick(rnd, nasty) + text.slice(at)
      }
      const output = perturb(compose(rnd, outV.map((v) => v.text)))
      const evidence = rnd() < 0.5 ? perturb(compose(rnd, evV.map((v) => v.text))) : compose(rnd, evV.map((v) => v.text))
      const tokens = extractNumbers(output, { locale: options.locale })
      let end = 0
      for (const t of tokens) {
        expect(output.slice(t.start, t.end), output).toBe(t.raw)
        expect(t.start, output).toBeGreaterThanOrEqual(end)
        end = t.end
        expect(/^-?\d+(\.\d+)?$/.test(t.value), `${output} -> ${t.value}`).toBe(true)
        if (t.ambiguous) expect(t.ambiguity, output).toBeDefined()
      }
      const r = traceNumbers(output, evidence, options)
      const evTokens = extractNumbers(evidence, { locale: options.evidenceLocale })
      for (const n of r.numbers) {
        const why = `${describeCase(output, evidence)} -> ${n.token.raw}:${n.status}${n.reason === undefined ? '' : `(${n.reason})`}`
        expect(forbidden(n.token, evTokens), why).not.toContain(n.status)
      }
      // Self-trace: whatever the text is, it is never untraced against itself.
      const self = traceNumbers(output, output, { locale: options.locale, evidenceLocale: options.locale })
      for (const n of self.numbers) {
        if (n.status === 'untraced') {
          const selfTokens = extractNumbers(output, { locale: options.locale })
          expect(forbidden(n.token, selfTokens), `${JSON.stringify(output)} -> ${n.token.raw}`).not.toContain('untraced')
        }
      }
    }
  })

  it('(i) sums, differences and means built from the evidence are derived, and nearby values are not', () => {
    const rnd = lcg(0x5eed09)
    const fmt = (units: bigint, places: number): string => {
      const neg = units < 0n
      const digits = (neg ? -units : units).toString().padStart(places + 1, '0')
      const body = places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`
      return `${neg ? '-' : ''}${body.replace(/\B(?=(\d{3})+(?!\d))(?<!\.\d*)/g, ',')}`
    }
    const half = (num: bigint, den: bigint): bigint => (num >= 0n ? (2n * num + den) / (2n * den) : -((-2n * num + den) / (2n * den)))
    let derived = 0
    for (let iter = 0; iter < 800; iter++) {
      const k = 4 + Math.floor(rnd() * 3)
      const tenths: bigint[] = []
      while (tenths.length < k) {
        const v = BigInt(30000 + Math.floor(rnd() * 69000))
        if (!tenths.includes(v)) tenths.push(v)
      }
      const evidence = tenths.map((v, i) => `Item ${String.fromCharCode(97 + i)} was $${fmt(v, 1)}.`).join(' ')
      const size = rnd() < 0.5 ? 2 : 3
      const picked = [...tenths].sort(() => rnd() - 0.5).slice(0, size)
      const total = picked.reduce((x, y) => x + y, 0n)
      const kind = pick(rnd, ['sum', 'average', 'difference'] as const)
      let exact: bigint
      let places: number
      let value: string
      if (kind === 'sum') {
        exact = total
        places = 1
        value = fmt(total, 1)
      } else if (kind === 'average') {
        // Shown to two decimals; the exact mean may need more.
        exact = half(total * 10n, BigInt(size))
        places = 2
        value = fmt(exact, 2)
      } else {
        // The first figure less the other(s), shown as a magnitude.
        const [first = 0n, ...rest] = picked
        const diff = rest.reduce((x, y) => x - y, first)
        exact = diff < 0n ? -diff : diff
        places = 1
        value = fmt(exact, 1)
      }
      const options = { derivations: [kind], maxOperands: 3 as const, maxCandidates: 5000 }
      // Check a derived claim against arithmetic done here, from the operands the kit names.
      const checkClaim = (n: TraceResult['numbers'][number] | undefined, shown: bigint, shownPlaces: number, why: string): void => {
        const d = n?.derivation
        if (d === undefined) return
        const ops = d.operands.map((o) => BigInt(o.raw.replace(/[$,]/g, '').replace('.', '')))
        expect(d.kind, why).toBe(kind)
        let calc: bigint
        if (kind === 'sum') calc = ops.reduce((x, y) => x + y, 0n)
        else if (kind === 'average') calc = half(ops.reduce((x, y) => x + y, 0n) * 10n, BigInt(ops.length))
        else {
          // One operand less the others; any of them may be the one, and the sign is dropped.
          const sum = ops.reduce((x, y) => x + y, 0n)
          const candidates = ops.map((m) => {
            const v = 2n * m - sum
            return v < 0n ? -v : v
          })
          expect(candidates, why).toContain(shown)
          return
        }
        expect(calc, why).toBe(shown)
        expect(shownPlaces, why).toBe(kind === 'average' ? 2 : 1)
      }
      const r = traceNumbers(`The result was $${value}.`, evidence, options)
      expect(r.candidateCapHit).toBe(false)
      // The figure may equal an evidence number or another combination; it is never untraced.
      expect(r.numbers[0]?.status, `${evidence} -> ${value} (${kind})`).not.toBe('untraced')
      if (r.numbers[0]?.status === 'derived') {
        derived++
        checkClaim(r.numbers[0], exact, places, `${evidence} -> ${value} (${kind})`)
      }
      // A value shifted by 17.3 is a different number: never traced or rounded from the evidence,
      // and if derived, the arithmetic of the named operands really gives it.
      const shifted = exact + (places === 1 ? 173n : 1730n)
      const wrong = fmt(shifted, places)
      const w = traceNumbers(`The result was $${wrong}.`, evidence, options)
      expect(['traced', 'rounded'], `${evidence} -> ${wrong}`).not.toContain(w.numbers[0]?.status)
      if (w.numbers[0]?.status === 'derived') checkClaim(w.numbers[0], shifted, places, `${evidence} -> ${wrong} (${kind})`)
    }
    expect(derived).toBeGreaterThan(300)
  })

  it('(j) with ignoreYears, only a bare four-digit year or a date year is ever ignored as a year', () => {
    const rnd = lcg(0x5eed0a)
    for (let iter = 0; iter < 4000; iter++) {
      const outV = formsFor(rnd, 1 + Math.floor(rnd() * 3), true).map((f) => pick(rnd, f))
      const evV = formsFor(rnd, 1 + Math.floor(rnd() * 3), true).map((f) => pick(rnd, f))
      const mixed = (vs: Variant[]): boolean => new Set(vs.map((v) => v.locale ?? 'en-US')).size > 1
      if (mixed(outV) || mixed(evV)) continue
      const output = compose(rnd, outV.map((v) => v.text))
      const r = traceNumbers(output, compose(rnd, evV.map((v) => v.text)), {
        ignoreYears: true, locale: localeOf(outV), evidenceLocale: localeOf(evV),
      })
      for (const n of r.numbers) {
        if (n.status !== 'ignored' || n.reason !== 'year') continue
        const t = n.token
        const why = `${JSON.stringify(output)} -> ${t.raw}`
        const bareYear = t.kind === 'year' && t.unit === undefined && t.currency === undefined && t.scale === 0
        const dateYear = t.kind === 'date-part' && t.part === 'year'
        expect(bareYear || dateYear, why).toBe(true)
        expect(t.ambiguous, why).toBe(false)
      }
    }
  })

  it('(k) a count times a price is derived, and nearby values are not', () => {
    const rnd = lcg(0x5eed0b)
    let derived = 0
    for (let iter = 0; iter < 600; iter++) {
      const count = 2 + Math.floor(rnd() * 998)
      const price = 100 + Math.floor(rnd() * 9900) // cents
      const product = BigInt(count) * BigInt(price)
      const fmt = (cents: bigint): string => `${(cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(cents % 100n).toString().padStart(2, '0')}`
      const evidence = `Usage was ${count} events at $${fmt(BigInt(price))} each.`
      const options = { derivations: ['product' as const], maxCandidates: 5000 }
      const r = traceNumbers(`That costs $${fmt(product)}.`, evidence, options)
      expect(r.numbers[0]?.status, `${evidence} -> ${fmt(product)}`).not.toBe('untraced')
      if (r.numbers[0]?.status === 'derived') {
        derived++
        const ops = r.numbers[0].derivation?.operands.map((o) => o.raw.replace(/[$,]/g, '')) ?? []
        expect(ops.map(Number).sort((x, y) => x - y)).toEqual([count, price / 100].sort((x, y) => x - y))
      }
      const wrong = traceNumbers(`That costs $${fmt(product + 1730n)}.`, evidence, options)
      expect(['traced', 'rounded'], `${evidence} -> ${fmt(product + 1730n)}`).not.toContain(wrong.numbers[0]?.status)
      if (wrong.numbers[0]?.status === 'derived') {
        // A coincidence with the other reading; the operands named must really give it.
        const ops = wrong.numbers[0].derivation?.operands.map((o) => Number(o.raw.replace(/[$,]/g, ''))) ?? []
        expect(Math.abs(ops.reduce((x, y) => x * y, 1) - Number(product + 1730n) / 100)).toBeLessThan(0.006)
      }
    }
    expect(derived).toBeGreaterThan(500)
  })

  it('(b) a different value, or the same value in an incompatible unit, is never traced', () => {
    const rnd = lcg(0x5eed02)
    const A = ['37', '88', '250', '1234']
    const B = ['6007', '913.7', '0.0071', '31337', '7919.5']
    const shapes: ReadonlyArray<(n: string) => string> = [
      (n) => n,
      (n) => `${n} percent`,
      (n) => `$${n}`,
      (n) => `${n} kg`,
      (n) => `${n} million`,
      (n) => `€${n}`,
      (n) => `${n} days`,
    ]
    for (let iter = 0; iter < 3000; iter++) {
      const a = pick(rnd, A)
      const b = pick(rnd, B)
      const out = pick(rnd, shapes)(a)
      const ev = pick(rnd, shapes)(b)
      const r = traceNumbers(compose(rnd, [out]), compose(rnd, [ev, `plain ${pick(rnd, B)}`]))
      for (const n of r.numbers) {
        expect(['untraced', 'unknown'], `${out} vs ${ev}: ${n.token.raw}:${n.status}`).toContain(n.status)
      }
    }
    // Same value, incompatible unit: the value is there, the unit is not.
    const kinds: ReadonlyArray<readonly [string, (n: string) => string]> = [
      ['plain', (n) => n], ['pct', (n) => `${n}%`], ['pp', (n) => `${n} pp`], ['usd', (n) => `$${n}`],
      ['eur', (n) => `€${n}`], ['kg', (n) => `${n} kg`], ['days', (n) => `${n} days`],
    ]
    const oneSided = new Set(['plain/kg', 'plain/days', 'kg/plain', 'days/plain'])
    for (let iter = 0; iter < 2000; iter++) {
      const v = pick(rnd, [...A, ...B])
      const [ka, fa] = pick(rnd, kinds)
      const [kb, fb] = pick(rnd, kinds)
      if (ka === kb || oneSided.has(`${ka}/${kb}`)) continue
      const r = traceNumbers(compose(rnd, [fa(v)]), compose(rnd, [fb(v)]))
      for (const n of r.numbers) expect(n.status, `${fa(v)} vs ${fb(v)}`).toBe('untraced')
    }
    // An explicit sign that contradicts the evidence.
    for (const v of A) expect(traceNumbers(`-${v}%`, `${v}%`).numbers[0]?.status).toBe('untraced')
  })

  it('(b) derivations are never used when they are not asked for', () => {
    const rnd = lcg(0x5eed03)
    for (let iter = 0; iter < 1500; iter++) {
      const a = pick(rnd, ['3', '4', '10', '25'])
      const b = pick(rnd, ['2', '5', '8', '40'])
      const r = traceNumbers(`total ${Number(a) + Number(b)}, diff ${Math.abs(Number(a) - Number(b))}`, `a ${a} b ${b}`)
      for (const n of r.numbers) expect(n.status).not.toBe('derived')
    }
  })

  it('(d) NFC and NFD, and full-width and ASCII, give the same statuses', () => {
    const rnd = lcg(0x5eed04)
    const toFullWidth = (text: string): string =>
      text.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).replace(/ /g, '　')
    let compared = 0
    for (let iter = 0; iter < 2500; iter++) {
      const outForms = formsFor(rnd, 1 + Math.floor(rnd() * 3), true)
      const evForms = formsFor(rnd, 1 + Math.floor(rnd() * 3), true)
      const outV = outForms.map((f) => pick(rnd, f))
      const evV = [...outForms.map((f) => pick(rnd, f)), ...evForms.map((f) => pick(rnd, f))]
      const mixed = (vs: Variant[]): boolean => new Set(vs.map((v) => v.locale ?? 'en-US')).size > 1
      if (mixed(outV) || mixed(evV)) continue
      const output = compose(rnd, outV.map((v) => v.text)) + (rnd() < 0.3 ? ' K3 K4 Naïve9' : '')
      const evidence = compose(rnd, evV.map((v) => v.text))
      const options = { locale: localeOf(outV), evidenceLocale: localeOf(evV) }
      const base = statuses(traceNumbers(output, evidence, options))
      const nfd = statuses(traceNumbers(output.normalize('NFD'), evidence.normalize('NFD'), options))
      const nfc = statuses(traceNumbers(output.normalize('NFC'), evidence.normalize('NFC'), options))
      expect(nfd, describeCase(output, evidence)).toEqual(base)
      expect(nfc, describeCase(output, evidence)).toEqual(base)
      // Full-width ASCII folds to the same numbers (only locale-printed text is skipped, as its marks are not ASCII).
      if (outV.every((v) => v.locale === undefined) && evV.every((v) => v.locale === undefined)) {
        const wide = statuses(traceNumbers(toFullWidth(output), toFullWidth(evidence), options))
        expect(wide, describeCase(output, evidence)).toEqual(base)
        compared++
      }
    }
    expect(compared).toBeGreaterThan(500)
  })
})
