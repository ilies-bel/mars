import { getDefaultTaskStore } from '../store/task-store'

/**
 * Structured verdict recorded by a diagnose Chore against a stuck task.
 *
 * A diagnose Chore is the bounded successor to the legacy free-form
 * context-gathering child: investigate-only, terminal, and required to end
 * by recording exactly one of these verdict kinds. The orchestrator reads
 * the verdict back through {@link getDiagnosis} and branches structurally
 * — it never parses the Chore's prose. Recording a second verdict for the
 * same task overwrites the first (last-writer-wins; the Chore is terminal
 * so a real Chore only writes once, but a retry-loop must not crash).
 *
 * See PRD 06e677fb / ADR on diagnose-Chore terminality.
 */
export type DiagnosisVerdict =
  | {
      kind: 'root-cause-found'
      evidence: string
      involvedFiles: readonly string[]
      fixDirection: string
    }
  | {
      kind: 'inconclusive'
      whatChecked: string
      whyUnscoped: string
    }

/** Discriminator returned to callers that read a verdict that may not exist. */
export type StoredDiagnosis =
  | (DiagnosisVerdict & { taskId: string; recordedAt: number })
  | { kind: 'no-verdict'; taskId: string }

export type DiagnosisKind = DiagnosisVerdict['kind']

export const DIAGNOSIS_KINDS: readonly DiagnosisKind[] = [
  'root-cause-found',
  'inconclusive',
] as const

const isDiagnosisKind = (value: unknown): value is DiagnosisKind =>
  value === 'root-cause-found' || value === 'inconclusive'

// The normalized diagnosis tables (diagnoses_root_cause,
// diagnoses_inconclusive, diagnosis_involved_files) are owned by the
// canonical schema (pg-schema.ts `ensureSchema`, applied at daemon/init
// start). The SQLite-era in-place backfill from the legacy polymorphic
// `diagnoses` table is gone — legacy history is handled once by the
// one-time importer (src/init/import-sqlite.ts).

const requireNonEmpty = (value: string, field: string): void => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`diagnose set: ${field} is required and must be non-empty`)
  }
}

/**
 * Record a verdict against `taskId`. Validates the shape eagerly: missing or
 * blank required fields, or an unknown verdict kind, throw before touching
 * the store so a partial record is never persisted. A second `setDiagnosis`
 * for the same `taskId` overwrites the prior row.
 */
export const setDiagnosis = async (
  taskId: string,
  verdict: DiagnosisVerdict,
): Promise<void> => {
  if (typeof taskId !== 'string' || taskId.trim().length === 0) {
    throw new Error('diagnose set: taskId is required')
  }
  if (!isDiagnosisKind((verdict as { kind?: unknown }).kind)) {
    throw new Error(
      `diagnose set: kind must be one of ${DIAGNOSIS_KINDS.join(', ')}; got '${String((verdict as { kind?: unknown }).kind)}'`,
    )
  }

  let evidence: string | null = null
  let validatedFiles: string[] = []
  let fixDirection: string | null = null
  let whatChecked: string | null = null
  let whyUnscoped: string | null = null

  if (verdict.kind === 'root-cause-found') {
    requireNonEmpty(verdict.evidence, 'evidence')
    requireNonEmpty(verdict.fixDirection, 'fix-direction')
    if (!Array.isArray(verdict.involvedFiles)) {
      throw new Error('diagnose set: involved-files must be an array')
    }
    validatedFiles = verdict.involvedFiles.filter(
      (f) => typeof f === 'string' && f.trim().length > 0,
    )
    if (validatedFiles.length === 0) {
      throw new Error('diagnose set: at least one involved file is required')
    }
    evidence = verdict.evidence.trim()
    fixDirection = verdict.fixDirection.trim()
  } else {
    requireNonEmpty(verdict.whatChecked, 'what-checked')
    requireNonEmpty(verdict.whyUnscoped, 'why-unscoped')
    whatChecked = verdict.whatChecked.trim()
    whyUnscoped = verdict.whyUnscoped.trim()
  }

  const store = await getDefaultTaskStore()
  const now = Date.now()

  // Delete from all child tables first so an overwrite across verdict kinds
  // leaves no stale rows (e.g. switching from root-cause to inconclusive).
  await store.execute({
    sql: `DELETE FROM diagnoses_root_cause WHERE task_id = ?`,
    args: [taskId],
  })
  await store.execute({
    sql: `DELETE FROM diagnoses_inconclusive WHERE task_id = ?`,
    args: [taskId],
  })
  await store.execute({
    sql: `DELETE FROM diagnosis_involved_files WHERE task_id = ?`,
    args: [taskId],
  })

  if (verdict.kind === 'root-cause-found') {
    await store.execute({
      sql: `INSERT INTO diagnoses_root_cause
              (task_id, evidence, fix_direction, recorded_at)
            VALUES (?, ?, ?, ?)`,
      args: [taskId, evidence!, fixDirection!, now],
    })
    for (let i = 0; i < validatedFiles.length; i++) {
      await store.execute({
        sql: `INSERT INTO diagnosis_involved_files
                (task_id, position, path)
              VALUES (?, ?, ?)`,
        args: [taskId, i, validatedFiles[i]],
      })
    }
  } else {
    await store.execute({
      sql: `INSERT INTO diagnoses_inconclusive
              (task_id, what_checked, why_unscoped, recorded_at)
            VALUES (?, ?, ?, ?)`,
      args: [taskId, whatChecked!, whyUnscoped!, now],
    })
  }
}

/**
 * Read the verdict for `taskId`. Returns a `no-verdict` discriminator when
 * nothing has been recorded — never throws on absence, never returns empty
 * success. The caller branches on `result.kind`.
 */
export const getDiagnosis = async (taskId: string): Promise<StoredDiagnosis> => {
  const store = await getDefaultTaskStore()

  const rcResult = await store.query({
    sql: `SELECT evidence, fix_direction, recorded_at
            FROM diagnoses_root_cause
           WHERE task_id = ?`,
    args: [taskId],
  })
  if (rcResult.rows.length > 0) {
    const r = rcResult.rows[0] as unknown as {
      evidence: string
      fix_direction: string
      recorded_at: number
    }
    const filesResult = await store.query({
      sql: `SELECT path
              FROM diagnosis_involved_files
             WHERE task_id = ?
             ORDER BY position`,
      args: [taskId],
    })
    const involvedFiles = filesResult.rows.map(
      (row) => (row as unknown as { path: string }).path,
    )
    return {
      kind: 'root-cause-found',
      taskId,
      recordedAt: r.recorded_at,
      evidence: r.evidence,
      involvedFiles,
      fixDirection: r.fix_direction,
    }
  }

  const incResult = await store.query({
    sql: `SELECT what_checked, why_unscoped, recorded_at
            FROM diagnoses_inconclusive
           WHERE task_id = ?`,
    args: [taskId],
  })
  if (incResult.rows.length > 0) {
    const r = incResult.rows[0] as unknown as {
      what_checked: string
      why_unscoped: string
      recorded_at: number
    }
    return {
      kind: 'inconclusive',
      taskId,
      recordedAt: r.recorded_at,
      whatChecked: r.what_checked,
      whyUnscoped: r.why_unscoped,
    }
  }

  return { kind: 'no-verdict', taskId }
}
