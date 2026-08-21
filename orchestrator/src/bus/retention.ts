import { openDb, type DbClient } from '../core/lib/db.js'

/**
 * The single retention policy for orchestrator history. `trace_events`
 * (structured step/tool telemetry), `events` (the bus outbox) and
 * `task_transcripts` (streamed transcript chunks) all age out under the same
 * day window and row-count cap, so an operator can state "the retention
 * window" without qualifying which table they mean.
 *
 * Supersedes four previously-separate mechanisms, all deleted in favour of
 * this module:
 *
 *  - `RETENTION_DAYS_DEFAULT` / `RETENTION_MAX_ROWS_DEFAULT` /
 *    `LOG_LINE_RETENTION_DAYS` and `pruneRetention`
 *    (formerly `core/lib/retention-prune.ts`). The tighter 2-day window for
 *    warn/error `log_line` rows is gone — one window applies to every kind;
 *    the row-count cap remains the backstop against high `log_line` volume.
 *  - `OBSERVABILITY_RETENTION_DAYS` and `pruneObservability`
 *    (formerly `core/lib/observability-prune.ts`), a second, differently
 *    windowed (3-day) sweep over the same `trace_events` table. Because that
 *    sweep ran first in the daemon, 3 days — not 30 — was the window actually
 *    in force. Consolidating restores the documented 30-day window, so a live
 *    daemon now retains substantially more telemetry than before.
 *  - `TRANSCRIPT_RETENTION_DAYS` and the `pruneTranscripts` store method
 *    (formerly `core/lib/trace-events-store.ts`), a retention constant no
 *    sweep ever applied — `task_transcripts` grew without bound.
 *  - The age-based half of `pruneOutbox` (formerly `core/lib/outbox-prune.ts`).
 *    Its cursor-safety gate — never delete an `events` row a registered
 *    Subscriber has not yet consumed — is preserved below as a per-table
 *    correctness rule, not a second retention policy: the day/row-count
 *    window applied is identical to `trace_events`'s. Two behaviour changes
 *    are deliberate. When zero Subscribers are registered, `events` rows now
 *    age out under the normal policy instead of never being pruned at all.
 *    And the age comparison is done in epoch milliseconds, matching how
 *    `events.ts` is actually written (`pruneOutbox` compared the millisecond
 *    column against a second-denominated cutoff, so it never deleted
 *    anything) — that unit mismatch was the unbounded-growth hole this
 *    consolidation closes.
 */
export const EVENT_RETENTION = {
  /** Days of history to retain before a row is eligible for pruning. */
  days: 30,
  /** Row-count cap per table. The oldest rows are trimmed first past this. */
  maxRows: 50_000,
} as const

/**
 * Maximum rows removed by any single DELETE. Keeps each statement's dead-
 * tuple churn bounded so one sweep tick's work stays predictable. Exposed
 * for `mars db compact`, which loops passes with this as the batch size
 * until a full pass removes nothing.
 */
export const RETENTION_BATCH_SIZE = 1_000

/**
 * Wall-clock budget in ms for the row-count cap loop, per table. The loop
 * issues batchSize-sized DELETEs until the table is under maxRows or this
 * budget is spent, whichever comes first.
 */
const RETENTION_SWEEP_BUDGET_MS = 500

const MS_PER_DAY = 24 * 60 * 60 * 1000

export interface PruneEventsOptions {
  /** Days of history to retain. Defaults to EVENT_RETENTION.days. Set to 0 to skip the age passes. */
  days?: number
  /** Row-count cap per table. Defaults to EVENT_RETENTION.maxRows. */
  maxRows?: number
  /** Max rows per DELETE. Defaults to RETENTION_BATCH_SIZE. */
  batchSize?: number
  /** Wall-clock budget for the row-count cap loop. Defaults to RETENTION_SWEEP_BUDGET_MS. */
  sweepBudgetMs?: number
}

export interface PruneEventsResult {
  /** trace_events rows deleted because they exceeded the day window. */
  traceEventsByAge: number
  /** trace_events rows deleted because the table exceeded maxRows. */
  traceEventsByCount: number
  /** trace_events row count after pruning — a gauge for sweep logging. */
  traceEventsRemaining: number
  /** events rows deleted because they exceeded the day window (and, when Subscribers are registered, had been consumed by every one). */
  eventsByAge: number
  /** events rows deleted because the table exceeded maxRows (subject to the same consumption gate). */
  eventsByCount: number
  /** events row count after pruning — a gauge for sweep logging. */
  eventsRemaining: number
  /** task_transcripts rows deleted because they exceeded the day window. */
  transcriptsByAge: number
  /**
   * subscriber_processed_events rows deleted because their event_id is no
   * longer present in `events`. A dedup-ledger hygiene pass, not itself
   * governed by the day/maxRows window — it just tracks whatever `events`
   * pruning above already did.
   */
  subscriberProcessedEventsOrphans: number
}

type PrunableTable = 'trace_events' | 'events'

async function countRows(
  client: DbClient,
  table: PrunableTable,
): Promise<number> {
  const r = await client.execute(`SELECT COUNT(*) AS n FROM ${table}`)
  return Number((r.rows[0] as unknown as { n: number | bigint }).n)
}

/**
 * Trim `table` down to `maxRows` by repeatedly deleting the oldest rows in
 * `batchSize`-sized DELETEs, stopping when the table is under the cap, when
 * `sweepBudgetMs` is spent, or when a DELETE removes nothing.
 *
 * `floor` is the `events` consumption gate: when non-null only rows with
 * `id <= floor` are eligible, so a lagging Subscriber's unconsumed backlog is
 * never trimmed. That backlog can therefore hold the table above the cap —
 * the DELETE returning zero is what ends the loop in that case, and the
 * outbox sweeper's lag alert is what tells the operator why.
 */
async function trimToCap(
  client: DbClient,
  table: PrunableTable,
  orderBy: string,
  opts: {
    maxRows: number
    batchSize: number
    sweepBudgetMs: number
    floor: number | null
  },
): Promise<number> {
  const budgetDeadline = Date.now() + opts.sweepBudgetMs
  const floorClause = opts.floor !== null ? 'WHERE id <= ?' : ''
  let deleted = 0
  let currentCount = await countRows(client, table)

  while (currentCount > opts.maxRows && Date.now() < budgetDeadline) {
    const toDelete = Math.min(currentCount - opts.maxRows, opts.batchSize)
    const r = await client.execute({
      sql: `DELETE FROM ${table}
            WHERE id IN (
              SELECT id FROM ${table} ${floorClause}
              ORDER BY ${orderBy} ASC LIMIT ?
            )`,
      args: opts.floor !== null ? [opts.floor, toDelete] : [toDelete],
    })
    if (r.rowsAffected === 0) break
    deleted += r.rowsAffected
    currentCount = await countRows(client, table)
  }

  return deleted
}

/**
 * Prune orchestrator history — `trace_events`, `events` and
 * `task_transcripts` — to {@link EVENT_RETENTION} (overridable via `opts`).
 * Bounded passes, in order:
 *
 *   1. trace_events by age   — delete rows older than `days`.
 *   2. trace_events by count — loop batchSize-sized DELETEs until the table
 *      is under `maxRows` or `sweepBudgetMs` elapses.
 *   3. events by age + count — the same two passes, additionally gated so a
 *      row is only removed once every registered Subscriber has consumed it
 *      (id <= MIN(subscribers.cursor)); with zero Subscribers registered
 *      there is nothing to protect, so the gate is a no-op and the normal
 *      window applies.
 *   4. task_transcripts by age — delete chunk rows older than `days`. No
 *      row-count cap: transcripts are bounded per task and the day window is
 *      the whole policy for them.
 *   5. subscriber_processed_events — delete dedup-ledger rows whose
 *      event_id no longer exists in `events` (safe: if the event is gone,
 *      no Subscriber will ever be asked to process it again).
 *
 * Every timestamp column involved (`trace_events.timestamp`, `events.ts`,
 * `task_transcripts.ts`) is epoch **milliseconds**; the cutoffs below are too.
 *
 * Space reclamation after the DELETEs is autovacuum's job — no explicit
 * VACUUM here (`mars db compact` does that deliberately after looping this).
 */
export async function pruneEvents(
  dbTarget: string,
  opts?: PruneEventsOptions,
): Promise<PruneEventsResult> {
  const days = opts?.days ?? EVENT_RETENTION.days
  const maxRows = opts?.maxRows ?? EVENT_RETENTION.maxRows
  const batchSize = opts?.batchSize ?? RETENTION_BATCH_SIZE
  const sweepBudgetMs = opts?.sweepBudgetMs ?? RETENTION_SWEEP_BUDGET_MS
  const cutoffMs = Date.now() - days * MS_PER_DAY

  const client = openDb(dbTarget)
  try {
    // ── trace_events: age ────────────────────────────────────────────────
    let traceEventsByAge = 0
    if (days > 0) {
      const r = await client.execute({
        sql: `DELETE FROM trace_events
              WHERE id IN (
                SELECT id FROM trace_events WHERE timestamp < ? LIMIT ?
              )`,
        args: [cutoffMs, batchSize],
      })
      traceEventsByAge = r.rowsAffected
    }

    // ── trace_events: row-count cap ───────────────────────────────────────
    const traceEventsByCount = await trimToCap(client, 'trace_events', 'timestamp', {
      maxRows,
      batchSize,
      sweepBudgetMs,
      floor: null,
    })
    const traceEventsRemaining = await countRows(client, 'trace_events')

    // ── events: consumption floor ─────────────────────────────────────────
    // MIN(subscribers.cursor) when at least one Subscriber is registered;
    // null (no floor — nothing to protect) when none are.
    const subInfo = await client.execute(
      'SELECT COUNT(*) AS n, MIN(cursor) AS min_cursor FROM subscribers',
    )
    const subRow = subInfo.rows[0] as unknown as {
      n: number | bigint
      min_cursor: number | bigint | null
    }
    const subscriberFloor =
      Number(subRow.n) > 0 ? Number(subRow.min_cursor) : null

    // ── events: age ──────────────────────────────────────────────────────
    let eventsByAge = 0
    if (days > 0) {
      const floorClause = subscriberFloor !== null ? 'AND id <= ?' : ''
      const args: number[] =
        subscriberFloor !== null
          ? [cutoffMs, subscriberFloor, batchSize]
          : [cutoffMs, batchSize]
      const r = await client.execute({
        sql: `DELETE FROM events
              WHERE id IN (
                SELECT id FROM events
                WHERE ts < ? ${floorClause}
                ORDER BY id ASC LIMIT ?
              )`,
        args,
      })
      eventsByAge = r.rowsAffected
    }

    // ── events: row-count cap (same consumption floor) ────────────────────
    const eventsByCount = await trimToCap(client, 'events', 'id', {
      maxRows,
      batchSize,
      sweepBudgetMs,
      floor: subscriberFloor,
    })
    const eventsRemaining = await countRows(client, 'events')

    // ── task_transcripts: age ─────────────────────────────────────────────
    let transcriptsByAge = 0
    if (days > 0) {
      const r = await client.execute({
        sql: `DELETE FROM task_transcripts
              WHERE (task_id, session_id, seq) IN (
                SELECT task_id, session_id, seq FROM task_transcripts
                WHERE ts < ? LIMIT ?
              )`,
        args: [cutoffMs, batchSize],
      })
      transcriptsByAge = r.rowsAffected
    }

    // ── subscriber_processed_events: orphan dedup-ledger cleanup ──────────
    const orphanResult = await client.execute({
      sql: `DELETE FROM subscriber_processed_events
            WHERE (subscriber_id, event_id) IN (
              SELECT subscriber_id, event_id FROM subscriber_processed_events
              WHERE event_id NOT IN (SELECT id FROM events)
              LIMIT ?
            )`,
      args: [batchSize],
    })

    return {
      traceEventsByAge,
      traceEventsByCount,
      traceEventsRemaining,
      eventsByAge,
      eventsByCount,
      eventsRemaining,
      transcriptsByAge,
      subscriberProcessedEventsOrphans: orphanResult.rowsAffected,
    }
  } finally {
    await client.close()
  }
}
