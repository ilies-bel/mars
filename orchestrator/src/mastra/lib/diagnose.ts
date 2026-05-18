import { getClient, initQueue } from '../queue'

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

const initDiagnoses = async (): Promise<void> => {
  if (initialised) return
  await initQueue()
  const c = getClient()
  await c.execute(`
    CREATE TABLE IF NOT EXISTS diagnoses (
      task_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      evidence TEXT,
      involved_files_json TEXT,
      fix_direction TEXT,
      what_checked TEXT,
      why_unscoped TEXT,
      recorded_at TEXT NOT NULL
    )
  `)
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
  let involvedFilesJson: string | null = null
  let fixDirection: string | null = null
  let whatChecked: string | null = null
  let whyUnscoped: string | null = null

  if (verdict.kind === 'root-cause-found') {
    requireNonEmpty(verdict.evidence, 'evidence')
    requireNonEmpty(verdict.fixDirection, 'fix-direction')
    if (!Array.isArray(verdict.involvedFiles)) {
      throw new Error('diagnose set: involved-files must be an array')
    }
    const files = verdict.involvedFiles.filter(
      (f) => typeof f === 'string' && f.trim().length > 0,
    )
    if (files.length === 0) {
      throw new Error('diagnose set: at least one involved file is required')
    }
    evidence = verdict.evidence.trim()
    involvedFilesJson = JSON.stringify(files)
    fixDirection = verdict.fixDirection.trim()
  } else {
    requireNonEmpty(verdict.whatChecked, 'what-checked')
    requireNonEmpty(verdict.whyUnscoped, 'why-unscoped')
    whatChecked = verdict.whatChecked.trim()
    whyUnscoped = verdict.whyUnscoped.trim()
  }

  await initDiagnoses()
  const c = getClient()
  const now = new Date().toISOString()
  await c.execute({
    sql: `INSERT INTO diagnoses (
            task_id, kind,
            evidence, involved_files_json, fix_direction,
            what_checked, why_unscoped,
            recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            kind = excluded.kind,
            evidence = excluded.evidence,
            involved_files_json = excluded.involved_files_json,
            fix_direction = excluded.fix_direction,
            what_checked = excluded.what_checked,
            why_unscoped = excluded.why_unscoped,
            recorded_at = excluded.recorded_at`,
    args: [
      taskId,
      verdict.kind,
      evidence,
      involvedFilesJson,
      fixDirection,
      whatChecked,
      whyUnscoped,
      now,
    ],
  })
}

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
 * Read the verdict for `taskId`. Returns a `no-verdict` discriminator when
 * nothing has been recorded — never throws on absence, never returns empty
 * success. The caller branches on `result.kind`.
 */
export const getDiagnosis = async (taskId: string): Promise<StoredDiagnosis> => {
  await initDiagnoses()
  const c = getClient()
  const r = await c.execute({
    sql: `SELECT kind, evidence, involved_files_json, fix_direction,
                 what_checked, why_unscoped, recorded_at
            FROM diagnoses WHERE task_id = ?`,
    args: [taskId],
  })
  if (r.rows.length === 0) return { kind: 'no-verdict', taskId }
  const row = r.rows[0] as unknown as Record<string, unknown>
  const kind = row.kind as string
  const recordedAt = (row.recorded_at as string) ?? ''
  if (kind === 'root-cause-found') {
    return {
      kind,
      taskId,
      recordedAt,
      evidence: (row.evidence as string) ?? '',
      involvedFiles: parseFiles(row.involved_files_json),
      fixDirection: (row.fix_direction as string) ?? '',
    }
  }
  if (kind === 'inconclusive') {
    return {
      kind,
      taskId,
      recordedAt,
      whatChecked: (row.what_checked as string) ?? '',
      whyUnscoped: (row.why_unscoped as string) ?? '',
    }
  }
  // Unknown kind on disk: surface as no-verdict so the branch logic falls
  // through to the inconclusive path instead of acting on a half-row.
  return { kind: 'no-verdict', taskId }
}
