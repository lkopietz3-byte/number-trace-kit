// Types for the vitest cross-checks, which import the shared dev-only helpers.
export interface CrosscheckCase { k: string; [key: string]: unknown }
export interface CrosscheckExpected { e?: string; ys?: { y: string; expect: string }[] }
export interface DecimalHelpers {
  roundRat: (r: { p: bigint; q: bigint }, scale: number, mode: 'half-up' | 'half-even') => { mantissa: bigint }
  toRat: (a: { n: bigint; s: number }) => { p: bigint; q: bigint }
  parseDecimal: (text: string) => { n: bigint; s: number }
  add: (a: { n: bigint; s: number }, b: { n: bigint; s: number }) => { n: bigint; s: number }
  sub: (a: { n: bigint; s: number }, b: { n: bigint; s: number }) => { n: bigint; s: number }
  formatDec: (a: { n: bigint; s: number }) => string
  ratDiv: (a: { p: bigint; q: bigint }, b: { p: bigint; q: bigint }) => { p: bigint; q: bigint } | null
  ratMul: (a: { p: bigint; q: bigint }, b: { p: bigint; q: bigint }) => { p: bigint; q: bigint }
  ratSub: (a: { p: bigint; q: bigint }, b: { p: bigint; q: bigint }) => { p: bigint; q: bigint }
}
export interface TraceLike { traceNumbers: (output: string, evidence: string, options: never) => { numbers: readonly { status: string; reason?: string }[] } }
export function generateCases(seed: number, n: number): CrosscheckCase[]
export function checkCase(kit: TraceLike, dec: DecimalHelpers, c: CrosscheckCase, expected: CrosscheckExpected): { bad: string[]; checks: number }
export function icuLocales(languages: readonly string[]): string[]
export function checkLocale(
  extractNumbers: (text: string, options: { locale: string }) => readonly { value: string; ambiguous: boolean; alternates?: readonly { value: string }[] | undefined }[],
  resolveLocale: (locale: string) => { decimal: number; order: string },
  tag: string,
): { mismatches: string[]; prints: number; ambiguous: number }
export function checkLocaleStyles(
  extractNumbers: (text: string, options: { locale: string }) => readonly { value: string; kind: string; ambiguous: boolean; alternates?: readonly { value: string }[] | undefined }[],
  tag: string,
): { mismatches: string[]; prints: number }
