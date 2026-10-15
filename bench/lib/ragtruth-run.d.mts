// Types for test/field-regression.test.ts, which runs the benchmark's own scoring on the committed excerpts.
export interface RagtruthToken { raw: string; start: number; end: number; status: string; reason: string | null; cls: string; sub: string; why: string | undefined; postKit: boolean }
export interface RagtruthRow { id: string; task: string; stratum: string | null; form: string; verdict: string; cpuMs: number; numbers: RagtruthToken[] }
export interface EvidenceDoc { id: string; text: string }
export interface KitLike { traceNumbers: (answer: string, evidence: EvidenceDoc[], options: never) => { verdict: string; numbers: readonly { status: string; reason?: string; token: { start: number; end: number; raw: string } }[] } }
export const RAGTRUTH_CONFIGS: Record<string, object>
export function runRagtruthConfig(
  kit: KitLike,
  items: unknown[],
  evidenceOf: (item: never) => { docs: EvidenceDoc[]; form: string } | null,
  options: object,
  manual: Record<string, object>,
): { rows: RagtruthRow[]; counters: { unseenRun: number } }
