import type { MonitorDb } from './gate-meta-monitor'
import type { GateReplayResult } from './gate-replay'

/**
 * Shadow-mode burn-in for verify gates (draft proposal acd01d23, item 2).
 *
 * Context: incident 2026-07-03T08:15Z — the completeness gate shipped reading
 * coder text from disk transcripts headless sessions no longer write. It
 * failed CLOSED for 100% of tasks from its first live minute and blocked its
 * own fix from merging. The meta-monitor (gate-meta-monitor.ts) catches
 * identical-verdict storms AFTER the fact. Shadow mode prevents a
 * never-validated gate from enforcing at all.
 *
 * Behaviour:
 *  - A new verify gate starts in shadow mode. In shadow mode its verdict is
 *    recorded in trace_events and visible in the run timeline, but it never
 *    fails verify.
 *  - Each time the gate produces a "clean parse" — a run where the gate found
 *    data to evaluate and produced a definite verdict beyond merely "absent"
 *    (a pass is not required, a partial/incomplete verdict also counts) — a
 *    parse is recorded against the gate.
 *  - After {@link SHADOW_BURN_IN_COUNT} clean parses the gate auto-promotes
 *    to enforcing mode and may fail verify from that point onward.
 *  - A gate whose input pipeline starves (e.g. reading transcripts that are
 *    never written) never records a clean parse and therefore never promotes.
 *
 * State is persisted in the `gate_burn_in` table — a small durable table in
 * the same DB as `gate_verdict_monitor`. The {@link MonitorDb} seam
 * (`.execute()` only) is structurally satisfied by a raw
 * {@link import('./db.js').DbClient}, by a `TaskStore`, and by any stub
 * that exposes `.execute()`.
 */

/**
 * Number of clean parses required to promote a gate from shadow mode to
 * enforcing mode.
 *
 * A "clean parse" is a gate run that produced a definite verdict — the gate
 * demonstrated it can SEE the data it judges. A pass is not required; a
 * verdict of "incomplete" or "unsubstantiated-completion" also counts as a
 * clean parse. Only a verdict of "absent" (gate could not find its input
 * data at all) does NOT count — that is the starvation signature.
 *
 * Deliberately NOT configurable: this is a correctness safety net, not a
 * tunable threshold.
 */
export const SHADOW_BURN_IN_COUNT = 10

/**
 * The `gate_burn_in` table is owned by the canonical schema (pg-schema.ts
 * `ensureSchema`, applied at daemon/init start). This function is retained as
 * the historical call-site seam and is now a no-op.
 */
const ensureGateBurnInSchema = async (
  _client: MonitorDb,
): Promise<void> => {
  // Schema is guaranteed by pg-schema.ts ensureSchema at startup.
}

/**
 * Historical test hook for the removed in-process "schema ensured" latch.
 * No-op since the canonical schema owns the table.
 */
export const resetGateBurnInSchemaLatchForTests = (): void => {
  // No latch remains; schema ownership moved to pg-schema.ts.
}

export interface GateBurnInStatus {
  /** True when the gate has not yet accumulated {@link SHADOW_BURN_IN_COUNT} clean parses. */
  inShadow: boolean
  /** Number of clean parses recorded so far. */
  parseCount: number
  /**
   * The last {@link GateReplayResult} computed for this gate (ADR-0099:
   * promotion requires a replay pass over the gate's motivating-failure
   * fixtures, not clean-parse count alone). `null` when no replay has been
   * recorded yet — either the gate has never reached the burn-in threshold,
   * or it has no motivating-failure fixtures to replay against.
   */
  replay: GateReplayResult | null
}

/**
 * Runtime shape guard for a stored {@link GateReplayResult} — the column is
 * free-form JSON, never trust it blindly on read.
 */
const isGateReplayResult = (value: unknown): value is GateReplayResult => {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return (
    typeof o.caught === 'number' &&
    typeof o.missed === 'number' &&
    typeof o.total === 'number' &&
    Array.isArray(o.misses)
  )
}

const parseGateReplayResult = (raw: string | null): GateReplayResult | null => {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return isGateReplayResult(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Read the current burn-in status for a gate. A gate that has never been seen
 * is treated as fully in shadow mode (parseCount = 0, replay = null).
 */
export const getGateBurnInStatus = async (
  client: MonitorDb,
  gateName: string,
): Promise<GateBurnInStatus> => {
  await ensureGateBurnInSchema(client)
  const r = await client.execute({
    sql: `SELECT parse_count, promoted_at, last_replay_result FROM gate_burn_in WHERE gate_name = ?`,
    args: [gateName],
  })
  if (r.rows.length === 0) {
    return { inShadow: true, parseCount: 0, replay: null }
  }
  const row = r.rows[0] as unknown as {
    parse_count: number
    promoted_at: number | null
    last_replay_result: string | null
  }
  return {
    inShadow: row.promoted_at === null,
    parseCount: row.parse_count,
    replay: parseGateReplayResult(row.last_replay_result),
  }
}

/**
 * Persist the last {@link GateReplayResult} computed for a gate (ADR-0099),
 * so it is readable per-gate via {@link getGateBurnInStatus} regardless of
 * whether the replay led to promotion. Upserts the `gate_burn_in` row —
 * safe to call even before {@link recordGateParse} has ever run for this
 * gate name, though in practice replay is only computed once burn-in has
 * already created the row.
 */
export const recordGateReplayResult = async (
  client: MonitorDb,
  gateName: string,
  result: GateReplayResult,
): Promise<void> => {
  await ensureGateBurnInSchema(client)
  await client.execute({
    sql: `INSERT INTO gate_burn_in (gate_name, parse_count, last_replay_result)
          VALUES (?, 0, ?)
          ON CONFLICT(gate_name) DO UPDATE SET
            last_replay_result = excluded.last_replay_result`,
    args: [gateName, JSON.stringify(result)],
  })
}

export interface RecordGateParseResult {
  /** The new parse count after this observation. */
  parseCount: number
  /**
   * True when this observation pushed the gate over the threshold and it was
   * just promoted to enforcing mode (or was already promoted).
   */
  promoted: boolean
}

/**
 * Record one clean parse for a gate and advance the burn-in counter.
 *
 * If the gate was already promoted (parse_count >= SHADOW_BURN_IN_COUNT and
 * promoted_at is set), this is a no-op beyond confirming promoted=true.
 *
 * On the observation that first reaches {@link SHADOW_BURN_IN_COUNT}, the
 * gate's `promoted_at` timestamp is written — subsequent calls to
 * {@link getGateBurnInStatus} return `inShadow: false`.
 */
export const recordGateParse = async (
  client: MonitorDb,
  gateName: string,
): Promise<RecordGateParseResult> => {
  await ensureGateBurnInSchema(client)

  // Upsert: increment parse_count only when the gate is not yet promoted.
  // Once promoted_at is set, further parses leave the count unchanged.
  await client.execute({
    sql: `INSERT INTO gate_burn_in (gate_name, parse_count)
          VALUES (?, 1)
          ON CONFLICT(gate_name) DO UPDATE SET
            parse_count = CASE
              WHEN gate_burn_in.promoted_at IS NOT NULL THEN gate_burn_in.parse_count
              ELSE gate_burn_in.parse_count + 1
            END`,
    args: [gateName],
  })

  // Read back the new state.
  const r = await client.execute({
    sql: `SELECT parse_count, promoted_at FROM gate_burn_in WHERE gate_name = ?`,
    args: [gateName],
  })
  const row = r.rows[0] as unknown as {
    parse_count: number
    promoted_at: number | null
  }
  const parseCount = row.parse_count

  // Promote on the first crossing of the threshold.
  if (row.promoted_at === null && parseCount >= SHADOW_BURN_IN_COUNT) {
    await client.execute({
      sql: `UPDATE gate_burn_in SET promoted_at = ? WHERE gate_name = ?`,
      args: [Date.now(), gateName],
    })
    return { parseCount, promoted: true }
  }

  return { parseCount, promoted: row.promoted_at !== null }
}
