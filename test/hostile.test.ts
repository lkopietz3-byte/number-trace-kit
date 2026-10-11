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
    expect(extractNumbers('45​%')[0]).toMatchObject({ kind: 'count' })
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
