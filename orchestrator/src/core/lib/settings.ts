/**
 * Per-repo KV settings store backed by the `app_settings` table.
 *
 * Each repo has exactly one Mars database, so these settings are scoped to
 * the repo without a separate project_id column — one database is one
 * project.
 *
 * Schema ownership: `app_settings` is created by `ensureSchema` in
 * `core/lib/pg-schema.ts` (migration 0002) — this module carries no DDL.
 *
 * Public surface:
 *   - `RELEASE_NOTES_LAST_VIEWED_KEY` — stable key for tracking the last
 *     time the user viewed release notes.
 *   - `getSetting(db, key)` — read a setting value, or null when absent.
 *   - `setSetting(db, key, value)` — upsert a setting, stamping updated_at.
 */

import type { DbClient } from './db.js'
import { resolveStateClient } from '../store/state-client'

/** Idempotent PostgreSQL schema bootstrap retained for existing callers. */
export const initSettings = async (): Promise<void> => {
  const { ensureSchema } = await import('./pg-schema.js')
  await ensureSchema(resolveStateClient())
}

/** Stable key used to persist the last-viewed release-notes timestamp. */
export const RELEASE_NOTES_LAST_VIEWED_KEY = 'release_notes.last_viewed_at'

/** Stable key for persisting the operator's name during onboarding. */
export const ONBOARDING_OPERATOR_NAME_KEY = 'onboarding.operator_name'

/**
 * Read a setting by key. Returns `null` when the key has never been set.
 *
 * @param db  The DB client to read from (state client).
 * @param key The settings key to look up.
 */
export const getSetting = async (db: DbClient, key: string): Promise<string | null> => {
  const result = await db.execute({
    sql: 'SELECT value FROM app_settings WHERE key = ?',
    args: [key],
  })
  const row = result.rows[0]
  if (!row) return null
  const value = row.value
  return typeof value === 'string' ? value : null
}

/**
 * Write (upsert) a setting. On conflict, overwrites the existing row and
 * bumps `updated_at` to the current wall-clock instant.
 *
 * @param db    The DB client to write to (state client).
 * @param key   The settings key to persist.
 * @param value The string value to store.
 */
export const setSetting = async (db: DbClient, key: string, value: string): Promise<void> => {
  const now = new Date().toISOString()
  await db.execute({
    sql: `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    args: [key, value, now],
  })
}
