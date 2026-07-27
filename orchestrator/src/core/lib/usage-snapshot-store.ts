/**
 * Store for usage snapshots: periodic token-usage samples written by the
 * daemon's `usage-sampler` and read by `mars daemon usage` (and, in future
 * slices, by the usage-aware scheduler).
 *
 * Schema: `usage_snapshots(id, captured_at, input_tokens, output_tokens,
 * window_kind, raw_json)` — DDL lives in core/lib/pg-schema.ts.
 *
 * Both functions accept a {@link DbClient} so callers control the connection;
 * the caller is responsible for ensuring the schema is up before calling.
 */

import type { DbClient } from './db.js'

export interface UsageSnapshotRow {
  /** Auto-generated identity primary key. */
  id: number
  /** ISO-8601 timestamp when the sample was captured. */
  capturedAt: string
  /** Cumulative input tokens in the current window. */
  inputTokens: number
  /** Cumulative output tokens in the current window. */
  outputTokens: number
  /**
   * Name of the measurement window used when computing this sample
   * (e.g. `'rolling'`, `'daily'`).
   */
  windowKind: string
  /** Full raw totals object for forward-compatibility. */
  rawJson: Record<string, unknown>
}

/**
 * Insert one usage snapshot row. The `id` column is GENERATED ALWAYS AS
 * IDENTITY and must not be supplied by the caller.
 */
export async function insertUsageSnapshot(
  row: Omit<UsageSnapshotRow, 'id'>,
  client: DbClient,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO usage_snapshots
            (captured_at, input_tokens, output_tokens, window_kind, raw_json)
          VALUES ($1, $2, $3, $4, $5)`,
    args: [
      row.capturedAt,
      row.inputTokens,
      row.outputTokens,
      row.windowKind,
      JSON.stringify(row.rawJson),
    ],
  })
}

/**
 * Return the most recently captured snapshot, or `null` when the table is
 * empty.
 */
export async function getLatestUsageSnapshot(
  client: DbClient,
): Promise<UsageSnapshotRow | null> {
  const rs = await client.execute(
    `SELECT id, captured_at, input_tokens, output_tokens, window_kind, raw_json
       FROM usage_snapshots
      ORDER BY captured_at DESC
      LIMIT 1`,
  )
  if (rs.rows.length === 0) return null
  const r = rs.rows[0] as Record<string, unknown>
  const rawJson: Record<string, unknown> =
    typeof r['raw_json'] === 'string'
      ? (JSON.parse(r['raw_json']) as Record<string, unknown>)
      : (r['raw_json'] as Record<string, unknown>)
  return {
    id: Number(r['id']),
    capturedAt: String(r['captured_at']),
    inputTokens: Number(r['input_tokens']),
    outputTokens: Number(r['output_tokens']),
    windowKind: String(r['window_kind']),
    rawJson,
  }
}
