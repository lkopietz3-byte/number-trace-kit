import { describe, expect, it } from 'vitest'
import { extractNumbers, reconcile, reconcileComponents, traceNumbers } from '../src/index.js'
import type { EvidenceInput, NumberToken, TraceOptions } from '../src/index.js'

/** CPU seconds spent running `fn` (best of a few runs, to damp scheduler noise). */
function cpu(fn: () => void, runs = 3): number {
  let best = Infinity
  for (let i = 0; i < runs; i++) {
    const before = process.cpuUsage()
    fn()
    const used = process.cpuUsage(before)
    best = Math.min(best, (used.user + used.system) / 1e6)
  }
  return best
}

/**
 * CPU time for 4x the input divided by CPU time for 1x. Linear code lands near
 * 4; a quadratic slip lands near 16. Both sizes are run once first so the
 * measurement is of warmed-up code, and the small time has a floor so timer
 * noise on a sub-millisecond run cannot inflate the ratio.
 */
function ratio(make: (n: number) => () => void): number {
  // 40k vs 160k characters: at 20k some shapes ran in a few milliseconds, where allocation
  // and garbage-collection noise alone pushed a linear function past the limit under load.
  const small = make(40_000)
  const large = make(160_000)
  small()
  large()
  return cpu(large, 5) / Math.max(cpu(small, 5), 0.005)
}

describe('linear time on hostile text', { timeout: 60_000 }, () => {
  it('the ratio harness can tell a quadratic function from a linear one', () => {
    const quadratic = ratio((n) => () => {
      let acc = 0
      for (let i = 0; i < n; i++) for (let j = 0; j < i / 64; j++) acc = (acc + j) | 0
      expect(acc).not.toBe(-1)
    })
    expect(quadratic).toBeGreaterThan(10)
  })

  const shapes: Record<string, (n: number) => string> = {
    'one huge digit run': (n) => '9'.repeat(n),
    'digits with commas': (n) => '1,'.repeat(n / 2),
    'digits with dots': (n) => '1.'.repeat(n / 2),
    'grouped thousands': (n) => '1,234'.repeat(n / 5).replace(/(\d{3})(?=\d)/g, '$1,'),
    'many small numbers': (n) => '1 '.repeat(n / 2),
    'numbers glued to letters': (n) => '5a'.repeat(n / 2),
    'a long letter run after a number': (n) => '5' + 'a'.repeat(n),
    'underscores': (n) => '5' + '_'.repeat(n),
    'minus signs': (n) => '-'.repeat(n) + '5',
    'currency and parentheses': (n) => '($5)'.repeat(n / 4),
    'dates': (n) => '2026-10-10 '.repeat(n / 11),
    'month names': (n) => 'May 5 '.repeat(n / 6),
    'percent words': (n) => '5 per '.repeat(n / 6),
    'spaced words': (n) => '5 million '.repeat(n / 10),
    'superscripts': (n) => '5²'.repeat(n / 2),
    'lone surrogates': (n) => '\ud800 5 '.repeat(n / 4),
    'non-ASCII letters': (n) => '5é́'.repeat(n / 3),
    'full-width digits': (n) => '５'.repeat(n),
    'ranges': (n) => '1-'.repeat(n / 2),
    'plain text with no digits': (n) => 'abc '.repeat(n / 4),
    'magnitude abbreviations with a dot': (n) => '5 Mio. '.repeat(n / 7),
    'two magnitude words in a row': (n) => '5 hundred thousand '.repeat(n / 19),
    'vulgar fractions': (n) => '1\u00bd '.repeat(n / 3),
    'bare vulgar fractions': (n) => '\u00bd'.repeat(n),
    'vulgar fractions with no exact decimal': (n) => '2\u2154 '.repeat(n / 3),
    'CJK magnitude words': (n) => '5\u4e07\u5186'.repeat(n / 3),
    'a long Cyrillic run after a number': (n) => '5 ' + '\u043c'.repeat(n),
    'Cyrillic magnitude words': (n) => '5 \u043c\u043b\u043d '.repeat(n / 6),
    'astral digits': (n) => '\u{1d7d8}'.repeat(n / 2),
    'dollar prefixes': (n) => 'CAD$5 '.repeat(n / 6),
    'a code before a dollar sign': (n) => 'CAD $5 '.repeat(n / 7),
    'a long letter run before a dollar sign': (n) => 'A'.repeat(n) + '$5',
    'a code after a symbol amount': (n) => '$5 EUR '.repeat(n / 7),
    'a code glued to a dollar sign': (n) => 'EUR$5 cad$5 '.repeat(n / 12),
    'a word before dollars': (n) => '5 Canadian dollars '.repeat(n / 19),
    'a long range with one code': (n) => '$5' + '-6'.repeat(n / 2) + ' CAD',
    'a long range of conflicting currencies': (n) => '$5' + '-6'.repeat(n / 2) + ' EUR',
    'a long range that gives a bare dollar its code': (n) => '$1 to '.repeat(n / 6) + '$2 CAD',
    'meridiems with dots': (n) => '5 p.m. '.repeat(n / 7),
    'meridiem letters without the m': (n) => '5 a '.repeat(n / 4) + '5 p.',
    'degree words': (n) => '5 degrees F '.repeat(n / 12),
    'degree signs': (n) => '5\u00b0 '.repeat(n / 3),
  }

  for (const [name, make] of Object.entries(shapes)) {
    it(`extractNumbers: ${name}`, () => {
      const r = ratio((n) => {
        const text = make(n)
        return () => {
          extractNumbers(text)
        }
      })
      expect(r).toBeLessThan(10)
    })
  }

  const skipShapes: Record<string, (n: number) => string> = {
    'unread glued forms': (n) => '12foo '.repeat(n / 6),
    'comma chains after a letter prefix': (n) => 'Rs1,500 '.repeat(n / 8),
    'underscore markup': (n) => '_5.5%_ '.repeat(n / 7),
    'long letter run before a digit': (n) => 'a'.repeat(n) + '1',
    'hyphenated names': (n) => 'a-1-b-2-c-3-d-4-e-5 '.repeat(n / 20),
    'kebab quantities': (n) => 'first-100-days '.repeat(n / 15),
    'version chains': (n) => 'v1.2.3+4 '.repeat(n / 9),
    'dotted junk': (n) => '1,234.5.6 '.repeat(n / 10),
  }
  for (const [name, make] of Object.entries(skipShapes)) {
    it(`traceNumbers: skipped forms stay linear: ${name}`, () => {
      const r = ratio((n) => {
        const text = make(n)
        return () => {
          traceNumbers(text, 'x 12 5.5% 100 days')
        }
      })
      expect(r).toBeLessThan(10)
    })
  }

  it('traceNumbers: 200k characters of output against matching evidence', () => {
    const chunk = 'Revenue was $1,234.50 (up 12.5%) across 3 regions on 2026-10-10. '
    const r = ratio((n) => {
      const text = chunk.repeat(Math.ceil(n / chunk.length))
      return () => {
        traceNumbers(text, chunk)
      }
    })
    expect(r).toBeLessThan(10)
  })

  it('traceNumbers: many untraced numbers that each need a rounding lookup', () => {
    const evidence = Array.from({ length: 2000 }, (_, i) => `${i}.${String(i % 997).padStart(3, '0')}`).join(' ; ')
    const r = ratio((n) => {
      const text = '1.23456 '.repeat(n / 8) + '5 million '.repeat(n / 40)
      return () => {
        traceNumbers(text, evidence)
      }
    })
    expect(r).toBeLessThan(10)
  })

  it('a 200,000-character output finishes in well under a few seconds', () => {
    const text = ('Total $12,345.67 and 8.5% and 1,000 units, see Section 4.2 (page 17). ').repeat(3000)
    expect(text.length).toBeGreaterThan(200_000)
    const t = cpu(() => {
      const res = traceNumbers(text, 'Total $12,345.67 and 8.5% and 1,000 units', { ignorePattern: /Section \d|page \d/ })
      expect(res.verdict).toBe('clean')
    }, 1)
    expect(t).toBeLessThan(5)
  })

  it('ignorePattern is applied to a short window, so total work stays linear', () => {
    const r = ratio((n) => {
      const text = 'item 12 and '.repeat(n / 12)
      return () => {
        traceNumbers(text, 'x', { ignorePattern: /item \d+ and item \d+ and/ })
      }
    })
    expect(r).toBeLessThan(10)
  })

  it('a derivation search over many evidence numbers is capped, not quadratic', () => {
    const evidence = Array.from({ length: 3000 }, (_, i) => `n${i} ${i * 3 + 1}.5`).join('; ')
    const t = cpu(() => {
      const r = traceNumbers('The answer is 99999.5.', evidence, { derivations: ['sum', 'difference', 'ratio', 'percent-change', 'percent-of'] })
      expect(r.candidateCapHit).toBe(true)
      expect(r.derivationCandidates).toBe(0)
      expect(r.numbers[0]?.status).toBe('unknown')
    }, 1)
    expect(t).toBeLessThan(3)
  })
})

describe('hostile values', { timeout: 60_000 }, () => {
  it('a huge digit run is flagged too-long and never reaches BigInt', () => {
    const [t] = extractNumbers('9'.repeat(300_000))
    expect(t).toMatchObject({ ambiguous: true, ambiguity: 'too-long' })
    expect(traceNumbers('9'.repeat(300_000), '9'.repeat(300_000)).numbers[0]?.reason).toBe('too-long')
  })

  it('a text over the length limit is a RangeError', () => {
    expect(() => extractNumbers('1'.repeat(5_000_001))).toThrow(RangeError)
    expect(() => traceNumbers('5', '1'.repeat(5_000_001))).toThrow(RangeError)
    expect(() => traceNumbers('1'.repeat(5_000_001), '5')).toThrow(RangeError)
  })

  it('zero-width characters split a number rather than hiding it', () => {
    expect(extractNumbers('1​234').map((t) => t.raw)).toEqual(['1', '234'])
    // Between a number and its percent sign or unit word an invisible character counts as the space it stands for
    // (gate-false-pass:G5-F01); otherwise it would hide the word.
    expect(extractNumbers('45​%')[0]).toMatchObject({ kind: 'percent' })
    expect(traceNumbers('1​234', '1234').verdict).toBe('untraced')
  })

  it('NFC and NFD text read the same numbers', () => {
    const nfc = 'café 5 crème 7%'
    const nfd = nfc.normalize('NFD')
    expect(extractNumbers(nfc).map((t) => t.value)).toEqual(extractNumbers(nfd).map((t) => t.value))
    expect(traceNumbers(nfd, nfc).verdict).toBe('clean')
  })

  it('look-alike letters of other scripts end a number instead of hiding it', () => {
    // Cyrillic "а" and Greek "ο" look like Latin letters but are not digits or units.
    // Gluing them to a number must not make it skip the check.
    expect(extractNumbers('5\u0430 and 7\u03bf').map((t) => t.raw)).toEqual(['5', '7'])
    expect(traceNumbers('Total 5\u0430', 'x').verdict).toBe('untraced')
    expect(extractNumbers('\u0430\u03bf')).toEqual([])
  })

  it('numbers in CJK text are numbers: "100円", "第3回", "1,234.50米ドル"', () => {
    expect(extractNumbers('売上は1,234円で、第3回、5%増').map((t) => [t.raw, t.value])).toEqual([
      ['1,234', '1234'], ['3', '3'], ['5%', '5'],
    ])
  })

  it('decimal digits of other scripts are folded to ASCII', () => {
    expect(extractNumbers('\u0967\u0968\u0969 and \u0e51\u0e52 and \u09e8\u09e6%').map((t) => [t.value, t.kind])).toEqual([
      ['123', 'count'], ['12', 'count'], ['20', 'percent'],
    ])
    expect(traceNumbers('\u0967\u0968\u0969', 'total 123').verdict).toBe('clean')
  })

  it('every digit block in the folding table is a block of ten decimal digits', () => {
    const zeros = [0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0]
    for (const zero of zeros) {
      for (let d = 0; d <= 9; d++) {
        const ch = String.fromCharCode(zero + d)
        expect(/^\p{Nd}$/u.test(ch), zero.toString(16)).toBe(true)
        expect(extractNumbers(`x ${ch}`)[0]?.value).toBe(String(d))
      }
    }
  })

  it('digits outside the Basic Multilingual Plane are not read (documented limit)', () => {
    expect(extractNumbers('\u{1d7d8}\u{1d7d9}')).toEqual([])
  })

  it('every token offset slices back to its raw text, on messy input', () => {
    const messy = '😀 (£1,2 345.6 k) －５％ ١٢٫٥ Oct. 5th, 2026 -$3.4M [6]'
    for (const t of extractNumbers(messy)) expect(messy.slice(t.start, t.end)).toBe(t.raw)
  })

  it('tokens are ordered and never overlap', () => {
    const text = 'May 5 2026-10-10 12:30 (3) 4K $5-12% 1.2.3 7,8 Oct 5th of July 9'
    let end = 0
    for (const t of extractNumbers(text)) {
      expect(t.start).toBeGreaterThanOrEqual(end)
      expect(t.end).toBeGreaterThan(t.start)
      end = t.end
    }
  })
})

describe('proxies, getters and single reads', { timeout: 60_000 }, () => {
  function counted<T extends object>(target: T): { proxy: T; reads: () => Record<string, number> } {
    const counts: Record<string, number> = {}
    const proxy = new Proxy(target, {
      get(t, key, receiver) {
        if (typeof key === 'string') counts[key] = (counts[key] ?? 0) + 1
        return Reflect.get(t, key, receiver) as unknown
      },
    })
    return { proxy, reads: () => counts }
  }

  it('reads every option once', () => {
    const { proxy, reads } = counted<TraceOptions>({ derivations: ['sum'], locale: 'en-US', ignoreYears: true, maxCandidates: 100 })
    traceNumbers('5 and 2026', 'x 5', proxy)
    for (const [key, n] of Object.entries(reads())) expect(n, key).toBe(1)
  })

  it('reads every evidence document field once', () => {
    const docs = [{ id: 'a', text: 'Total 5' }, { id: 'b', text: 'Total 6' }].map((d) => counted(d))
    traceNumbers('5 and 6', docs.map((d) => d.proxy))
    for (const d of docs) for (const [key, n] of Object.entries(d.reads())) expect(n, key).toBe(1)
  })

  it('a getter that changes its answer cannot change what was validated', () => {
    let text = 0
    const doc = {
      id: 'a',
      get text(): string {
        text++
        return text === 1 ? 'Total 5' : 'Total 999'
      },
    }
    const r = traceNumbers('Total 5', [doc])
    expect(text).toBe(1)
    expect(r.verdict).toBe('clean')
  })

  it('a getter on an option that changes its answer is read once', () => {
    let reads = 0
    const options = {
      get derivations(): string[] {
        reads++
        return reads === 1 ? ['sum'] : []
      },
    } as unknown as TraceOptions
    const r = traceNumbers('The total was 7.', 'a 3 b 4', options)
    expect(reads).toBe(1)
    expect(r.numbers[0]?.status).toBe('derived')
  })

  it('reconcile reads rows, amounts and options once', () => {
    let amountReads = 0
    const rows = [
      {
        label: 'a',
        get amount(): string {
          amountReads++
          return amountReads === 1 ? '1.00' : '999.00'
        },
      },
    ]
    const { proxy, reads } = counted({ rows, total: '1.00' })
    expect(reconcile(proxy).ok).toBe(true)
    expect(amountReads).toBe(1)
    for (const [key, n] of Object.entries(reads())) expect(n, key).toBe(1)
  })

  it('reconcileComponents reads every part once', () => {
    let reads = 0
    const parts = {
      get paid(): string {
        reads++
        return reads === 1 ? '1.00' : '999.00'
      },
    }
    expect(reconcileComponents({ parts, total: '1.00' }).ok).toBe(true)
    expect(reads).toBe(1)
  })

  it('a throwing getter propagates its own error and leaves nothing half done', () => {
    const boom = new Error('boom')
    const doc = { id: 'a', get text(): string { throw boom } }
    expect(() => traceNumbers('5', [doc])).toThrow(boom)
    expect(() => traceNumbers('5', 'x', { get derivations(): never { throw boom } })).toThrow(boom)
    // The next call is unaffected.
    expect(traceNumbers('5', 'x 5').verdict).toBe('clean')
  })

  it('a proxy whose traps throw is reported, not swallowed', () => {
    const hostile = new Proxy({}, { ownKeys() { throw new Error('no keys') } })
    expect(() => traceNumbers('5', 'x', hostile as TraceOptions)).toThrow('no keys')
    expect(() => reconcile(hostile as never)).toThrow('no keys')
  })

  it('a Proxy-wrapped array is read through its length and indexes once', () => {
    const docs = new Proxy([{ id: 'a', text: 'Total 5' }], {})
    expect(traceNumbers('5', docs).verdict).toBe('clean')
    const rows = new Proxy([{ label: 'a', amount: '5' }], {})
    expect(reconcile({ rows, total: '5' }).ok).toBe(true)
  })

  it('null-prototype objects and inherited toJSON/then are ordinary data', () => {
    const doc = Object.assign(Object.create(null) as Record<string, unknown>, { id: 'a', text: 'Total 5' })
    expect(traceNumbers('5', [doc as never]).verdict).toBe('clean')
    const thenable = { id: 'a', text: 'Total 5', then: () => { throw new Error('then must not be called') }, toJSON: () => { throw new Error('toJSON must not be called') } }
    expect(traceNumbers('5', [thenable]).verdict).toBe('clean')
    const options = Object.assign(Object.create(null) as Record<string, unknown>, { ignoreYears: true })
    expect(traceNumbers('2026', 'x', options as TraceOptions).numbers[0]?.status).toBe('ignored')
  })

  it('huge arrays are rejected by length without being walked or spread', () => {
    const fake = new Proxy([], { get: (t, k) => (k === 'length' ? 2 ** 32 - 1 : Reflect.get(t, k) as unknown) })
    expect(() => traceNumbers('5', fake as unknown as EvidenceInput)).toThrow(RangeError)
    expect(() => reconcile({ rows: fake, total: '0' })).toThrow(RangeError)
    // 300k real items are fine, and nothing is spread into a call.
    const many = Array.from({ length: 300_000 }, (_, i) => ({ id: String(i), text: '7' }))
    expect(traceNumbers('7', many).verdict).toBe('clean')
    const rows = Array.from({ length: 300_000 }, () => ({ label: 'r', amount: '0.01' }))
    expect(reconcile({ rows, total: '3000.00' }).ok).toBe(true)
  })

  it('rejects wrong types for output and evidence', () => {
    expect(() => traceNumbers(5 as never, 'x')).toThrow(TypeError)
    expect(() => traceNumbers(null as never, 'x')).toThrow(TypeError)
    expect(() => traceNumbers('5', 5 as never)).toThrow(TypeError)
    expect(() => traceNumbers('5', null as never)).toThrow(TypeError)
    expect(() => traceNumbers('5', { id: 'a', text: '5' } as never)).toThrow(TypeError)
    expect(() => traceNumbers('5', new Array(1) as never)).toThrow(TypeError)
    expect(() => traceNumbers('5', ['5'] as never)).toThrow(TypeError)
    expect(() => traceNumbers('5', new String('5') as never)).toThrow(TypeError)
    expect(() => traceNumbers('5', 'x', 5 as never)).toThrow(TypeError)
    expect(() => traceNumbers('5', 'x', { derivation: ['sum'] } as never)).toThrow(RangeError)
  })

  it('does not mutate its inputs', () => {
    const tokens: NumberToken[] = [...extractNumbers('Total 5')]
    const snapshot = JSON.stringify(tokens)
    const docs = [{ id: 'a', text: 'Total 5' }]
    const options = { derivations: ['sum' as const], ignore: ['1'] }
    traceNumbers('5', docs, options)
    traceNumbers(tokens, tokens)
    expect(JSON.stringify(tokens)).toBe(snapshot)
    expect(docs).toEqual([{ id: 'a', text: 'Total 5' }])
    expect(options).toEqual({ derivations: ['sum'], ignore: ['1'] })
  })
})

describe('S5 hostile:F6 options, documents and rows are read as own properties only', () => {
  const proto = Object.prototype as unknown as Record<string, unknown>
  const polluted = (name: string, value: unknown, fn: () => void): void => {
    proto[name] = value
    try {
      fn()
    } finally {
      delete proto[name]
    }
  }

  it('S5 hostile:F6 an inherited ignoreSmallIntegersUpTo never turns untraced into clean', () => {
    polluted('ignoreSmallIntegersUpTo', 100_000, () => {
      expect(traceNumbers('Revenue was 9999.', 'Revenue was 5.').verdict).toBe('untraced')
      expect(traceNumbers('Revenue was 9999.', 'Revenue was 5.', {}).verdict).toBe('untraced')
    })
  })

  it('S5 hostile:F6 an inherited option name is not an option', () => {
    for (const name of ['derivations', 'preset', 'locale', 'ignoreYears', 'ignoreStructure', 'allowBareEvidence', 'signMode', 'maxCandidates']) {
      const value: unknown = name === 'derivations' ? ['sum'] : name === 'preset' ? 'report' : name === 'locale' ? 'de-DE' : name === 'signMode' ? 'magnitude' : name === 'maxCandidates' ? 1 : true
      polluted(name, value, () => {
        expect(traceNumbers('Total was 12.', 'a 5 and 7.').verdict, name).toBe('untraced')
        expect(() => extractNumbers('1,5', {}), name).not.toThrow()
      })
    }
    polluted('locale', 'de-DE', () => {
      expect(extractNumbers('1,5')[0]?.value).toBe('1.5')
      expect(extractNumbers('1,5')[0]?.localeGuess).toBe(true)
    })
  })

  it('S5 hostile:F6 an inherited tolerance, amount, label, total or rows never changes a reconcile', () => {
    polluted('tolerance', '1000', () => {
      expect(reconcile({ rows: [{ label: 'a', amount: '1' }], total: '999' }).ok).toBe(false)
      expect(reconcile({ rows: [{ label: 'a', amount: '1' }], total: '999' }, {}).ok).toBe(false)
      expect(reconcileComponents({ parts: { a: '1' }, total: '999' }).ok).toBe(false)
    })
    polluted('amount', '999', () => {
      expect(reconcile({ rows: [{ label: 'a', amount: '1' }], total: '999' }).ok).toBe(false)
      expect(() => reconcile({ rows: [{ label: 'a' } as never], total: '999' })).toThrow(TypeError)
    })
    polluted('total', '1', () => {
      expect(() => reconcile({ rows: [{ label: 'a', amount: '1' }] } as never)).toThrow(TypeError)
    })
    polluted('rows', [{ label: 'a', amount: '1' }], () => {
      expect(() => reconcile({ total: '1' } as never)).toThrow(TypeError)
    })
  })

  it('S5 hostile:F6 an inherited text, id, scale or currency never makes a document or changes one', () => {
    polluted('text', 'Revenue was 9999.', () => {
      expect(() => traceNumbers('Revenue was 9999.', [{ id: 'a' } as never])).toThrow(TypeError)
    })
    polluted('scale', 'million', () => {
      expect(traceNumbers('Sales were $5 million.', [{ id: 'a', text: 'Sales 5', currency: 'USD' }]).verdict).toBe('untraced')
    })
    polluted('currency', 'EUR', () => {
      expect(traceNumbers('Sales were $5.', [{ id: 'a', text: 'Sales 5' }]).verdict).toBe('untraced')
    })
    polluted('id', 'x', () => {
      expect(() => traceNumbers('5', [{ text: '5' } as never])).toThrow(TypeError)
    })
  })

  it('S5 hostile:F6 an inherited token field is not read from a caller token', () => {
    const tok = extractNumbers('5')[0] as NumberToken
    polluted('part', 'month', () => {
      expect(traceNumbers([tok], '5').verdict).toBe('clean')
    })
    polluted('unit', 'kg', () => {
      expect(traceNumbers([tok], '5').verdict).toBe('clean')
    })
    polluted('currency', 'USD', () => {
      expect(traceNumbers([tok], '5').verdict).toBe('clean')
    })
  })

  it('S5 hostile:F6 a doc with no text is a TypeError that says what is missing', () => {
    expect(() => traceNumbers('5', [{ id: 'a' } as never])).toThrow(TypeError)
  })
})

describe('S6 hostile:F4 hostile:F3 false-pass:F20: resource caps', { timeout: 120_000 }, () => {
  const dense = (n: number): string => '1.5 '.repeat(n)

  it('S6 hostile:F4 evidence with too many numbers is a RangeError, thrown before the rest is read', () => {
    expect(() => traceNumbers('5', dense(1001), { maxEvidenceNumbers: 1000 })).toThrow(RangeError)
    expect(() => traceNumbers('5', dense(1000), { maxEvidenceNumbers: 1000 })).not.toThrow()
    // The limit is on the evidence as a whole, across documents and across caller tokens.
    expect(() => traceNumbers('5', [{ id: 'a', text: dense(600) }, { id: 'b', text: dense(600) }], { maxEvidenceNumbers: 1000 })).toThrow(RangeError)
    expect(() => traceNumbers('5', extractNumbers(dense(600)), { maxEvidenceNumbers: 500 })).toThrow(RangeError)
    // Stopping early: 2 million numbers with a limit of 1,000 cost about what 1,000 numbers cost.
    const huge = dense(1_200_000)
    const t = cpu(() => expect(() => traceNumbers('5', huge, { maxEvidenceNumbers: 1000 })).toThrow(RangeError), 1)
    expect(t).toBeLessThan(2)
  })

  it('S6 hostile:F4 the default limit is 500,000 numbers, and the option can only lower it', () => {
    expect(() => traceNumbers('5', '1 '.repeat(500_001))).toThrow(/500000 numbers/)
    expect(() => traceNumbers('5', '1', { maxEvidenceNumbers: 500_001 })).toThrow(RangeError)
    expect(() => traceNumbers('5', '1', { maxEvidenceNumbers: 0 })).toThrow(RangeError)
    expect(() => traceNumbers('5', '1', { maxEvidenceNumbers: 1.5 })).toThrow(TypeError)
    expect(traceNumbers('5', '1 2 3', { maxEvidenceNumbers: 3 }).evidenceNumbers).toBe(3)
  })

  const evidence84 = Array.from({ length: 84 }, (_, i) => `${(i * 7919) % 10007}.${String((i * 31) % 100).padStart(2, '0')}`).join(' ; ')
  const scales = (n: number): string => Array.from({ length: n }, (_, i) => `77.${'3'.repeat(i + 1)}`).join(' ')

  it('S6 hostile:F3 more than 12 distinct output scales: the extra derived lookups are unknown, never traced or untraced', () => {
    const r = traceNumbers(scales(20), evidence84, { preset: 'report' })
    const statuses = r.numbers.map((n) => `${n.status}:${n.reason ?? ''}`)
    // Twelve scales are answered. A form like 77.333 is also a grouped integer, and that second reading takes a scale too.
    const first = statuses.indexOf('unknown:scale-cap')
    expect(first).toBeGreaterThanOrEqual(10)
    expect(first).toBeLessThanOrEqual(12)
    expect(statuses.slice(0, first).every((s) => s === 'untraced:')).toBe(true)
    expect(statuses.slice(first).every((s) => s === 'unknown:scale-cap')).toBe(true)
    // A number that matches the evidence directly still resolves at any scale.
    const direct = traceNumbers(`${scales(14)} 0.19`, `${evidence84}; 0.19`, { preset: 'report' })
    expect(direct.numbers[14]).toMatchObject({ status: 'traced' })
  })

  it('S6 hostile:F3 59 distinct scales cost no more than 3 times one scale (CPU time)', () => {
    const run = (text: string) => (): void => {
      traceNumbers(text, evidence84, { preset: 'report' })
    }
    const one = run('77.3')
    const many = run(scales(59))
    one()
    many()
    expect(cpu(many, 3)).toBeLessThanOrEqual(3 * Math.max(cpu(one, 3), 0.05))
  })

  it('S6 false-pass:F20 the candidate cap counts what will be generated, so a page of 120 mixed numbers is still searched', () => {
    const mixed = [
      ...Array.from({ length: 40 }, (_, i) => String(1000 + i * 37)),
      ...Array.from({ length: 40 }, (_, i) => `${(i * 13) % 97 + 1}.${(i * 7) % 10}%`),
      ...Array.from({ length: 40 }, (_, i) => `$${(i * 7919) % 100003 + 11}`),
    ].join('; ')
    const r = traceNumbers('Revenue was $987,654,321.', mixed, { preset: 'report' })
    expect(r.candidateCapHit).toBe(false)
    expect(r.numbers[0]?.status).toBe('untraced')
    expect(r.derivationCandidates).toBeGreaterThan(10_000)
    expect(r.derivationCandidates).toBeLessThanOrEqual(50_000)
    // Same-class evidence still hits the cap, and then the verdict is unknown, not untraced.
    const sameClass = Array.from({ length: 120 }, (_, i) => `$${(i * 7919) % 100003 + 11}`).join('; ')
    const capped = traceNumbers('Revenue was $987,654,321.', sameClass, { preset: 'report' })
    expect(capped.candidateCapHit).toBe(true)
    expect(capped.numbers[0]).toMatchObject({ status: 'unknown', reason: 'candidate-cap' })
  })

  it('S6 false-pass:F20 with the cap hit, direct exact and rounded matches still resolve', () => {
    const sameClass = Array.from({ length: 120 }, (_, i) => `$${(i * 7919) % 100003 + 11}.25`).join('; ')
    const r = traceNumbers('One was $11.25, another about $7,930 and a third $987,654,321.', sameClass, { preset: 'report' })
    expect(r.candidateCapHit).toBe(true)
    expect(r.numbers.map((n) => n.status)).toEqual(['traced', 'rounded', 'unknown'])
  })

  it('S6 false-pass:F20 the estimate is never below what is generated', () => {
    let seed = 7
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    for (let it = 0; it < 40; it++) {
      const n = 4 + Math.floor(next() * 40)
      const parts = Array.from({ length: n }, () => {
        const v = 1 + Math.floor(next() * 900)
        const form = next()
        return form < 0.3 ? `${v}` : form < 0.55 ? `${v}%` : form < 0.8 ? `$${v}.5` : form < 0.9 ? `${v} kg` : `${v} pp`
      })
      for (const maxOperands of [2, 3] as const) {
        const cap = 3000
        const r = traceNumbers('5', parts.join('; '), { preset: 'report', maxOperands, maxCandidates: cap })
        if (!r.candidateCapHit) expect(r.derivationCandidates).toBeLessThanOrEqual(cap)
      }
    }
  })
})
