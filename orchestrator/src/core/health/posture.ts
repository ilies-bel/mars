/**
 * Per-check operator posture storage.
 *
 * The posture controls how the Steward routes a failing health-check finding:
 *
 *   'automatic' — Default for all checks. Mars acts on a finding immediately:
 *                 fix-route checks enqueue a repair task; alert-route checks
 *                 raise an action-queue row. No operator gesture required.
 *
 *   'manual'    — Finding surfaces as an offer (action-queue row with an
 *                 embedded fix spec). Nothing is enacted until the operator
 *                 takes the offer, at which point the fix task is enqueued.
 *                 Applies to fix-route checks only; alert-route checks
 *                 already carry this semantics natively.
 *
 *   'off'       — The check runs but no route fires for it. Other checks in
 *                 the same pass are unaffected. `mars doctor` still enumerates
 *                 the check and shows its last known state.
 *
 * Default by route kind:
 *   - 'fix'   route → 'automatic' (Mars can repair it, acts without asking)
 *   - 'alert' route → 'automatic' (requires human decision; auto-raises AQ row)
 *   - 'notice' route → 'automatic' (states once, auto-silenceable)
 *
 * The operator can change any check to 'manual' or 'off' via
 * `mars health posture <check-id> <value>`. Rows are only stored when
 * explicitly set; a missing row means 'automatic'.
 *
 * DB-backed storage: `PostureStore` with `createDbPostureStore(db)`.
 * In-memory storage for tests: `createInMemoryPostureStore()`.
 */

import type { HealthCheckPosture } from './pass.js'
import type { DbClient } from '../lib/db.js'

// Re-export HealthCheckPosture for callers that import from this module.
export type { HealthCheckPosture }

// ── PostureStore ──────────────────────────────────────────────────────────────

/**
 * Persistence contract for per-check operator posture.
 *
 * Implementations are backed by the `health_postures` DB table (production)
 * or a plain in-memory Map (tests). Callers never read the DB directly.
 */
export interface PostureStore {
  /**
   * Return the effective posture for a check id.
   * Returns 'automatic' (the default) when no explicit posture has been set.
   */
  getPosture(checkId: string): Promise<HealthCheckPosture>

  /**
   * Persist a posture for a check id. Idempotent — calling again with the
   * same value is a no-op at the application level.
   */
  setPosture(checkId: string, value: HealthCheckPosture): Promise<void>

  /**
   * Return all explicitly configured postures in check-id order.
   * Checks absent from this list are on 'automatic' (the default).
   */
  listPostures(): Promise<Array<{ checkId: string; posture: HealthCheckPosture }>>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_POSTURES: readonly HealthCheckPosture[] = ['automatic', 'manual', 'off']

const isValidPosture = (v: unknown): v is HealthCheckPosture =>
  typeof v === 'string' && VALID_POSTURES.includes(v as HealthCheckPosture)

// ── In-memory implementation (tests) ─────────────────────────────────────────

/**
 * Create a pure in-memory PostureStore.
 *
 * Used in tests. State does not survive process restarts.
 */
export const createInMemoryPostureStore = (): PostureStore => {
  const map = new Map<string, HealthCheckPosture>()

  return {
    async getPosture(checkId) {
      return map.get(checkId) ?? 'automatic'
    },
    async setPosture(checkId, value) {
      map.set(checkId, value)
    },
    async listPostures() {
      return Array.from(map.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([checkId, posture]) => ({ checkId, posture }))
    },
  }
}

// ── DB-backed implementation (production) ─────────────────────────────────────

/**
 * Create a DB-backed PostureStore reading from and writing to `health_postures`.
 *
 * The table is created by the canonical schema (migration 0007). A missing row
 * means 'automatic'. An invalid posture value in the DB is treated as 'automatic'
 * (defensive read, cannot happen through the write path).
 */
export const createDbPostureStore = (db: DbClient): PostureStore => ({
  async getPosture(checkId) {
    const result = await db.execute({
      sql: 'SELECT posture FROM health_postures WHERE check_id = ?',
      args: [checkId],
    })
    const row = result.rows[0]
    if (!row) return 'automatic'
    return isValidPosture(row.posture) ? row.posture : 'automatic'
  },

  async setPosture(checkId, value) {
    await db.execute({
      sql: `INSERT INTO health_postures (check_id, posture)
            VALUES (?, ?)
            ON CONFLICT (check_id) DO UPDATE SET posture = excluded.posture`,
      args: [checkId, value],
    })
  },

  async listPostures() {
    const result = await db.execute({
      sql: 'SELECT check_id, posture FROM health_postures ORDER BY check_id',
      args: [],
    })
    return result.rows.map((row) => ({
      checkId: String(row.check_id),
      posture: isValidPosture(row.posture) ? row.posture : ('automatic' as const),
    }))
  },
})
