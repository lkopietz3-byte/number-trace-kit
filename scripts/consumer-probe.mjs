// Imports the package by its published name from an installed tarball (not a
// relative path into src/ or dist/) and exercises the real API the way a
// consumer would, asserting real outputs rather than just "it exports
// something."
import assert from 'node:assert/strict';
import { extractNumbers, reconcile, reconcileComponents, traceNumbers } from 'number-trace-kit';

// extractNumbers: exact decimal strings, kinds and units, never floats.
const tokens = extractNumbers('Revenue was $1,234.50 (up 12.5%), about 1.2 million users.');
assert.deepEqual(
  tokens.map((t) => [t.raw, t.value, t.scale, t.kind]),
  [
    ['$1,234.50', '1234.50', 2, 'currency'],
    ['12.5%', '12.5', 1, 'percent'],
    ['1.2 million', '1200000', -5, 'decimal'],
  ],
);
assert.equal(tokens[0]?.currency, 'USD');

// Ambiguity is flagged, never guessed.
const [ambiguous] = extractNumbers('1.234 orders');
assert.equal(ambiguous?.ambiguous, true);
assert.deepEqual(ambiguous?.alternates, [{ value: '1234', scale: 0 }]);
assert.equal(extractNumbers('1,234 orders')[0]?.ambiguous, false);
assert.equal(extractNumbers('1.234,50', { locale: 'de-DE' })[0]?.value, '1234.50');

// Identifiers are not numbers.
assert.deepEqual(extractNumbers('Model X3 on v2.1 (COVID-19)'), []);

// traceNumbers: honest output, with a rounding and an exact match.
const evidence = [{ id: 'report', text: 'Revenue $1,234.50, growth 12.34%, users 1,234,567.' }];
const honest = traceNumbers('Revenue was $1,234.50, growth about 12.3%, with 1.2 million users.', evidence);
assert.equal(honest.verdict, 'clean');
assert.deepEqual(honest.numbers.map((n) => n.status), ['traced', 'rounded', 'rounded']);
assert.deepEqual(honest.numbers[0]?.evidence.map((e) => e.id), ['report']);

// Laundering: an invented number, a wrong unit, and a derived number with derivations off.
const bad = traceNumbers('Margin was 45%, up 99.', 'The invoice was 45 dollars.');
assert.equal(bad.verdict, 'untraced');
assert.deepEqual(bad.numbers.map((n) => n.status), ['untraced', 'untraced']);
assert.equal(bad.numbers[0]?.nearMisses?.[0]?.reason, 'unit-differs');

// Derivations are opt-in and exact; a cap overflow is unknown, never a pass.
const sums = 'Q1 $100.25. Q2 $200.50.';
assert.equal(traceNumbers('Total $300.75.', sums).verdict, 'untraced');
const derived = traceNumbers('Total $300.75.', sums, { derivations: ['sum'] });
assert.equal(derived.numbers[0]?.status, 'derived');
assert.equal(derived.numbers[0]?.derivation?.kind, 'sum');
const capped = traceNumbers('Total $300.75.', sums, { derivations: ['sum', 'difference'], maxCandidates: 1 });
assert.equal(capped.verdict, 'unknown');
assert.equal(capped.candidateCapHit, true);

// Misuse is an error, not a quiet pass.
assert.throws(() => traceNumbers('5', 'x', { derivations: ['product'] }), RangeError);
assert.throws(() => traceNumbers(5, 'x'), TypeError);
assert.throws(() => extractNumbers('5', { locale: 'xx-YY' }), RangeError);

// reconcile: exact, one cent matters, floats are rejected.
assert.deepEqual(
  reconcile({ rows: [{ label: 'a', amount: '10.10' }, { label: 'b', amount: '20.20' }], total: '30.30' }),
  { ok: true, sum: '30.30', total: '30.30', difference: '0', tolerance: '0', rows: 2 },
);
const off = reconcile({ rows: [{ label: 'a', amount: '10.10' }, { label: 'b', amount: '20.20' }], total: '30.31' });
assert.equal(off.ok, false);
assert.equal(off.difference, '-0.01');
assert.equal(reconcile({ rows: [{ label: 'a', amount: 1010 }], total: '10.10' }).ok, true); // integers are minor units
assert.throws(() => reconcile({ rows: [{ label: 'a', amount: 0.1 }], total: '0.1' }), TypeError);
assert.equal(reconcileComponents({ parts: { paid: '1000.00', reserve: '250.50' }, total: '1250.50' }).ok, true);

console.log('number-trace-kit consumer probe: all assertions passed');
