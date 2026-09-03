/**
 * CRUD helpers for the `kpi_acknowledged_baselines` table.
 *
 * When an operator acknowledges a KPI drift finding, the current snapshot
 * value is persisted here. The self-evolve drift trigger skips re-raising a
 * proposal for the same KPI while its current value stays within
 * `thresholdPct` of the acknowledged value.
 *
 * Three functions are exported:
 *   - `acknowledgeKpiBaseline` — UPSERT a baseline for a KPI key
 *   - `clearKpiBaseline`       — DELETE the baseline for a KPI key
 *   - `listKpiBaselines`       — SELECT all acknowledged baselines
 */

import type { DomainTaskStore as TaskStore } from '../store/task-store-default.js'

/** One row from the `kpi_acknowledged_baselines` table. */
export interface KpiAcknowledgedBaseline {
  /** The KPI key (e.g. 'cost_per_arc_p50', 'failure_rate'). */
  kpi_key: string
  /** The KPI value at acknowledgment time. */
  value: number
  /** ISO-8601 timestamp when the acknowledgment was recorded. */
  acknowledged_at: string
  /** Optional operator note explaining why this level is expected. */
  reason: string | null
}

/**
 * UPSERT a baseline for `kpiKey`. If a row already exists, it is replaced
 * with the new value, timestamp, and reason.
 */
export async function acknowledgeKpiBaseline(
  store: TaskStore,
  kpiKey: string,
  value: number,
  reason?: string,
): Promise<void> {
  const acknowledgedAt = new Date().toISOString()
  await store.execute({
    sql: `INSERT INTO kpi_acknowledged_baselines (kpi_key, value, acknowledged_at, reason)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (kpi_key) DO UPDATE SET
            value = excluded.value,
            acknowledged_at = excluded.acknowledged_at,
            reason = excluded.reason`,
    args: [kpiKey, value, acknowledgedAt, reason ?? null],
  })
}

/**
 * Delete the acknowledged baseline for `kpiKey`. No-op when no row exists.
 * After clearing, the drift trigger reverts to natural prior-window comparison.
 */
export async function clearKpiBaseline(store: TaskStore, kpiKey: string): Promise<void> {
  await store.execute({
    sql: `DELETE FROM kpi_acknowledged_baselines WHERE kpi_key = ?`,
    args: [kpiKey],
  })
}

/**
 * Return all acknowledged baselines, ordered by kpi_key.
 * Returns an empty array when no baselines have been recorded.
 */
export async function listKpiBaselines(store: TaskStore): Promise<KpiAcknowledgedBaseline[]> {
  const result = await store.query({
    sql: `SELECT kpi_key, value, acknowledged_at, reason
          FROM kpi_acknowledged_baselines
          ORDER BY kpi_key`,
    args: [],
  })
  return result.rows.map((raw) => {
    const r = raw as unknown as KpiAcknowledgedBaseline
    return {
      kpi_key: r.kpi_key,
      value: Number(r.value),
      acknowledged_at: r.acknowledged_at,
      reason: r.reason ?? null,
    }
  })
}
