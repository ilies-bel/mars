/**
 * Dispatch spend controller — persisted levers store (migration 0003).
 *
 * The `dispatch_spend_control` table holds a single operator-set row that
 * controls how the daemon responds to spend-rate pressure:
 *
 *   per_kind_ceilings    — per-worker-kind concurrency caps (jsonb, keyed by
 *                          worker kind string; null means ambient / no cap).
 *   pause_threshold_pct  — stop dispatching when spend rate ≥ this %.
 *   resume_threshold_pct — resume dispatching when spend rate drops to ≤ this %.
 *   suppress_recovery    — when true, no recovery/fix-tasks are spawned.
 *   ramp_back_step_pct   — step size (%) for incrementally restoring concurrency
 *                          after a pause clears.
 *
 * `loadSpendControl(client)` seeds the row with defaults on first call and
 * returns the Zod-validated object. `upsertSpendControl(client, patch)`
 * accepts a partial update, merges it in, and returns the updated row.
 *
 * Schema ownership: DDL lives in core/lib/pg-schema.ts (`ensureSchema`).
 */

import { z } from 'zod'
import type { DbClient } from '../../lib/db.js'

// ── Zod schema ────────────────────────────────────────────────────────────────

/**
 * Validated shape of the operator-set dispatch spend control levers.
 */
export const SpendControlLevers = z.object({
  /** Per-worker-kind concurrency ceiling map. null = no per-kind override. */
  perKindCeilings: z.record(z.string(), z.number().int().positive()).nullable(),
  /** Pause dispatch when spend rate (%) reaches this threshold. */
  pauseThresholdPct: z.number().int().min(0).max(100),
  /** Resume dispatch when spend rate (%) drops to this threshold. */
  resumeThresholdPct: z.number().int().min(0).max(100),
  /** When true, suppress recovery / fix-task spawning. */
  suppressRecovery: z.boolean(),
  /** Step size (%) for incrementally restoring concurrency after a pause. */
  rampBackStepPct: z.number().int().min(1).max(100),
})

export type SpendControlLevers = z.infer<typeof SpendControlLevers>

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULTS: SpendControlLevers = {
  perKindCeilings: null,
  pauseThresholdPct: 90,
  resumeThresholdPct: 70,
  suppressRecovery: false,
  rampBackStepPct: 10,
}

// ── Row → domain ──────────────────────────────────────────────────────────────

function rowToLevers(raw: Record<string, unknown>): SpendControlLevers {
  return SpendControlLevers.parse({
    perKindCeilings: raw['per_kind_ceilings'] ?? null,
    pauseThresholdPct: Number(raw['pause_threshold_pct']),
    resumeThresholdPct: Number(raw['resume_threshold_pct']),
    suppressRecovery:
      typeof raw['suppress_recovery'] === 'boolean'
        ? raw['suppress_recovery']
        : raw['suppress_recovery'] === 1 || raw['suppress_recovery'] === 'true',
    rampBackStepPct: Number(raw['ramp_back_step_pct']),
  })
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return the persisted dispatch spend control levers. If no row exists yet,
 * seeds the table with the built-in defaults and returns them.
 *
 * The result is Zod-validated — callers can rely on the schema invariants.
 */
export async function loadSpendControl(client: DbClient): Promise<SpendControlLevers> {
  const rs = await client.execute('SELECT * FROM dispatch_spend_control WHERE id = 1')
  if (rs.rows.length > 0) {
    return rowToLevers(rs.rows[0] as Record<string, unknown>)
  }

  // Seed defaults on first access.
  await client.execute({
    sql: `INSERT INTO dispatch_spend_control
            (id, per_kind_ceilings, pause_threshold_pct, resume_threshold_pct,
             suppress_recovery, ramp_back_step_pct, updated_at)
          VALUES (1, ?, ?, ?, ?, ?, now())
          ON CONFLICT (id) DO NOTHING`,
    args: [
      DEFAULTS.perKindCeilings !== null
        ? JSON.stringify(DEFAULTS.perKindCeilings)
        : null,
      DEFAULTS.pauseThresholdPct,
      DEFAULTS.resumeThresholdPct,
      DEFAULTS.suppressRecovery,
      DEFAULTS.rampBackStepPct,
    ],
  })

  return { ...DEFAULTS }
}

/**
 * Merge `patch` into the current levers row and return the updated value.
 *
 * If no row exists yet, inserts the merged defaults+patch. For
 * `perKindCeilings`, a `null` patch value explicitly clears the column;
 * omitting the key leaves it unchanged.
 */
export async function upsertSpendControl(
  client: DbClient,
  patch: Partial<SpendControlLevers>,
): Promise<SpendControlLevers> {
  const current = await loadSpendControl(client)
  const merged: SpendControlLevers = SpendControlLevers.parse({
    ...current,
    ...patch,
  })

  await client.execute({
    sql: `INSERT INTO dispatch_spend_control
            (id, per_kind_ceilings, pause_threshold_pct, resume_threshold_pct,
             suppress_recovery, ramp_back_step_pct, updated_at)
          VALUES (1, ?, ?, ?, ?, ?, now())
          ON CONFLICT (id) DO UPDATE SET
            per_kind_ceilings    = EXCLUDED.per_kind_ceilings,
            pause_threshold_pct  = EXCLUDED.pause_threshold_pct,
            resume_threshold_pct = EXCLUDED.resume_threshold_pct,
            suppress_recovery    = EXCLUDED.suppress_recovery,
            ramp_back_step_pct   = EXCLUDED.ramp_back_step_pct,
            updated_at           = EXCLUDED.updated_at`,
    args: [
      merged.perKindCeilings !== null
        ? JSON.stringify(merged.perKindCeilings)
        : null,
      merged.pauseThresholdPct,
      merged.resumeThresholdPct,
      merged.suppressRecovery,
      merged.rampBackStepPct,
    ],
  })

  return merged
}
