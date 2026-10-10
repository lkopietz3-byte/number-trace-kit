// Strict NodeNext type probe: compiled (never run) by scripts/verify-package.mjs
// against the installed .d.ts files, the way a TypeScript consumer's own
// tsconfig (strict, NodeNext) would see this package. No @types/node here, so
// no `node:` imports; a tiny local assert stands in.
import {
  extractNumbers,
  reconcile,
  reconcileComponents,
  traceNumbers,
  type Derivation,
  type EvidenceDoc,
  type EvidenceInput,
  type ExtractOptions,
  type NumberKind,
  type NumberToken,
  type NumberTrace,
  type ReconcileOptions,
  type ReconcileResult,
  type TraceOptions,
  type TraceResult,
  type TraceStatus,
  type TraceVerdict,
} from 'number-trace-kit';

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const extractOptions: ExtractOptions = { locale: 'de-DE', parenthesesAreNegative: true };
const tokens: NumberToken[] = extractNumbers('Der Betrag: 1.234,50 EUR', extractOptions);
const first: NumberToken | undefined = tokens[0];
const value: string | undefined = first?.value;
const kind: NumberKind | undefined = first?.kind;
assertEqual(value, '1234.50', 'token value');
assertEqual(kind, 'currency', 'token kind');

const docs: EvidenceDoc[] = [{ id: 'invoice', text: 'Amount due EUR 1234.50' }];
const evidence: EvidenceInput = docs;
const derivations: Derivation[] = ['sum', 'percent-change'];
const options: TraceOptions = { locale: 'de-DE', evidenceLocale: 'en-US', derivations, rounding: ['half-up'], maxCandidates: 1000 };
const result: TraceResult = traceNumbers('Der Betrag: 1.234,50 EUR', evidence, options);
const verdict: TraceVerdict = result.verdict;
const row: NumberTrace | undefined = result.numbers[0];
const status: TraceStatus | undefined = row?.status;
assertEqual(verdict, 'clean', 'verdict');
assertEqual(status, 'traced', 'status');
assertEqual(row?.evidence[0]?.id, 'invoice', 'cited evidence id');

const reconcileOptions: ReconcileOptions = { minorUnitDigits: 2, allowFloat: false };
const rec: ReconcileResult = reconcile(
  { rows: [{ label: 'a', amount: '10.10' }, { label: 'b', amount: 2020 }], total: '30.30', tolerance: '0' },
  reconcileOptions,
);
assertEqual(rec.ok, true, 'reconcile ok');
assertEqual(rec.sum, '30.30', 'reconcile sum');
assertEqual(reconcileComponents({ parts: { paid: '1.00', reserve: 50n }, total: '1.50' }).ok, true, 'components');

console.log('consumer-probe.mts: type probe assembled without error');
