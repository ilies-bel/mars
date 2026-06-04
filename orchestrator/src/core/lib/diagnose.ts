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
  | (DiagnosisVerdict & { taskId: string; recordedAt: string })
  | { kind: 'no-verdict'; taskId: string }

export type DiagnosisKind = DiagnosisVerdict['kind']

export const DIAGNOSIS_KINDS: readonly DiagnosisKind[] = [
  'root-cause-found',
  'inconclusive',
] as const

const isDiagnosisKind = (value: unknown): value is DiagnosisKind =>
  value === 'root-cause-found' || value === 'inconclusive'

let initialised = false

const parseFiles = (raw: unknown): readonly string[] => {
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

/**
 * Create the normalized diagnosis tables (diagnoses_root_cause,
 * diagnoses_inconclusive, diagnosis_involved_files) and backfill from the
 * legacy polymorphic diagnoses table if it still exists. The legacy table
 * is dropped once data is safely copied so subsequent startups skip the
 * migration entirely.
 */
const initDiagnoses = async (): Promise<void> => {
  if (initialised) return
  const store = await getDefaultTaskStore()

  await store.execute(`
    CREATE TABLE IF NOT EXISTS diagnoses_root_cause (
      task_id       TEXT NOT NULL PRIMARY KEY,
      evidence      TEXT NOT NULL,
      fix_direction TEXT NOT NULL,
      recorded_at   TEXT NOT NULL
    )
  `)
  await store.execute(`
    CREATE TABLE IF NOT EXISTS diagnoses_inconclusive (
      task_id      TEXT NOT NULL PRIMARY KEY,
      what_checked TEXT NOT NULL,
      why_unscoped TEXT NOT NULL,
      recorded_at  TEXT NOT NULL
    )
  `)
  await store.execute(`
    CREATE TABLE IF NOT EXISTS diagnosis_involved_files (
      task_id  TEXT    NOT NULL,
      position INTEGER NOT NULL,
      path     TEXT    NOT NULL,
      PRIMARY KEY (task_id, position)
    )
  `)

  // One-time migration: backfill the legacy polymorphic diagnoses table into
  // the normalized child tables, then drop it. Idempotent: once the legacy
  // table is gone this block is a no-op on every subsequent startup.
  const oldTable = await store.query(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='diagnoses'`,
  )
  if (oldTable.rows.length > 0) {
    const rcRows = await store.query(`
      SELECT task_id, evidence, involved_files_json, fix_direction, recorded_at
        FROM diagnoses
       WHERE kind = 'root-cause-found'
    `)
    for (const row of rcRows.rows) {
      const r = row as unknown as {
        task_id: string
        evidence: string | null
        involved_files_json: string | null
        fix_direction: string | null
        recorded_at: string
      }
      await store.execute({
        sql: `INSERT OR IGNORE INTO diagnoses_root_cause
                (task_id, evidence, fix_direction, recorded_at)
              VALUES (?, ?, ?, ?)`,
        args: [r.task_id, r.evidence ?? '', r.fix_direction ?? '', r.recorded_at],
      })
      const files = parseFiles(r.involved_files_json)
      for (let i = 0; i < files.length; i++) {
        await store.execute({
          sql: `INSERT OR IGNORE INTO diagnosis_involved_files
                  (task_id, position, path)
                VALUES (?, ?, ?)`,
          args: [r.task_id, i, files[i]],
        })
      }
    }
    const incRows = await store.query(`
      SELECT task_id, what_checked, why_unscoped, recorded_at
        FROM diagnoses
       WHERE kind = 'inconclusive'
    `)
    for (const row of incRows.rows) {
      const r = row as unknown as {
        task_id: string
        what_checked: string | null
        why_unscoped: string | null
        recorded_at: string
      }
      await store.execute({
        sql: `INSERT OR IGNORE INTO diagnoses_inconclusive
                (task_id, what_checked, why_unscoped, recorded_at)
              VALUES (?, ?, ?, ?)`,
        args: [
          r.task_id,
          r.what_checked ?? '',
          r.why_unscoped ?? '',
          r.recorded_at,
        ],
      })
    }
    await store.execute(`DROP TABLE diagnoses`)
  }

  initialised = true
}

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

  await initDiagnoses()
  const store = await getDefaultTaskStore()
  const now = new Date().toISOString()

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
  await initDiagnoses()
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
      recorded_at: string
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
      recorded_at: string
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
