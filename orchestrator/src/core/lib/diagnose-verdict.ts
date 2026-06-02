/**
 * Public API for the diagnose-verdict store.
 *
 * A diagnose Chore records exactly one verdict against the task it was
 * spawned to investigate and the orchestrator reads it back here — never by
 * parsing the Chore's prose. This module is the stable import surface; the
 * underlying persistence lives in {@link ./diagnose}.
 *
 * See PRD 06e677fb and the diagnose-Chore terminality ADR.
 */
export type {
  DiagnosisVerdict,
  DiagnosisKind,
  StoredDiagnosis,
} from './diagnose'

export { setDiagnosis, getDiagnosis, DIAGNOSIS_KINDS } from './diagnose'
