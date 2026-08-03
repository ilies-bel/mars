import type { DbResultSet, DbStatement } from './db.js'

/** Minimal database seam shared by the task store and transactional scopes. */
export interface MonitorDb {
  execute(stmt: DbStatement): Promise<DbResultSet>
}

/** A systemic gate failure is quarantined after this many distinct origins. */
export const GATE_VERDICT_TRIP_THRESHOLD = 5

export interface ObserveVerifyGateFailureInput {
  gateId: string
  originId: string
  failureSignature: string
  failedAt: number
}

export interface ObserveVerifyGateFailureResult {
  streak: number
  thresholdCrossed: boolean
}

interface FailureStreakRow {
  current_signature: string
  streak_count: number
  last_origin_id: string
}

/**
 * Record a registry-gate failure. Streaks are per gate and only distinct
 * origins advance them; every observation refreshes the gate's latest evidence.
 */
export const observeVerifyGateFailure = async (
  client: MonitorDb,
  { gateId, originId, failureSignature, failedAt }: ObserveVerifyGateFailureInput,
): Promise<ObserveVerifyGateFailureResult> => {
  const latest = await client.execute({
    sql: `UPDATE verify_gates
             SET last_failure_signature = ?, last_failure_at = ?, last_failure_origin_id = ?
           WHERE id = ?`,
    args: [failureSignature, failedAt, originId, gateId],
  })
  if (latest.rowsAffected === 0) return { streak: 0, thresholdCrossed: false }

  const r = await client.execute({
    sql: `SELECT current_signature, streak_count, last_origin_id
            FROM verify_gate_failure_streaks WHERE gate_id = ?`,
    args: [gateId],
  })
  const previous = r.rows[0] as unknown as FailureStreakRow | undefined
  const sameSignature = previous?.current_signature === failureSignature
  const sameOrigin = previous?.last_origin_id === originId
  const streak = !sameSignature ? 1 : sameOrigin ? previous.streak_count : previous.streak_count + 1

  await client.execute({
    sql: `INSERT INTO verify_gate_failure_streaks
            (gate_id, current_signature, streak_count, last_origin_id, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(gate_id) DO UPDATE SET
            current_signature = excluded.current_signature,
            streak_count = excluded.streak_count,
            last_origin_id = excluded.last_origin_id,
            updated_at = excluded.updated_at`,
    args: [gateId, failureSignature, streak, originId, failedAt],
  })

  return {
    streak,
    thresholdCrossed:
      streak >= GATE_VERDICT_TRIP_THRESHOLD &&
      (!sameSignature || previous.streak_count < GATE_VERDICT_TRIP_THRESHOLD),
  }
}

/** Kept as a no-op seam for callers that initialize the canonical schema. */
export const ensureGateMetaMonitorSchema = async (_client: MonitorDb): Promise<void> => {}

/** Historical test hook; schema state is owned by pg-schema.ts. */
export const resetGateMetaMonitorSchemaLatchForTests = (): void => {}
