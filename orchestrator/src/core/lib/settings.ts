/**
 * Per-repo KV settings store backed by the `app_settings` table in mars.db.
 *
 * Each repo has exactly one mars.db, so these settings are scoped to the
 * repo without a separate project_id column — one mars.db is one project.
 *
 * Public surface:
 *   - `RELEASE_NOTES_LAST_VIEWED_KEY` — stable key for tracking the last
 *     time the user viewed release notes.
 *   - `initSettings()` — idempotent table creation (call from initDatabases).
 *   - `getSetting(db, key)` — read a setting value, or null when absent.
 *   - `setSetting(db, key, value)` — upsert a setting, stamping updated_at.
 */

import type { Client } from '@libsql/client'
import { resolveStateClient } from '../store/state-client'

/** Stable key used to persist the last-viewed release-notes timestamp. */
export const RELEASE_NOTES_LAST_VIEWED_KEY = 'release_notes.last_viewed_at'

let initialised = false

/**
 * Idempotent bootstrap: create the `app_settings` table if it doesn't exist.
 * Safe to call on an existing database — the CREATE TABLE is a no-op when
 * the table is already present.
 */
export const initSettings = async (): Promise<void> => {
  if (initialised) return
  const c = resolveStateClient()
  await c.execute(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  initialised = true
}

/**
 * Read a setting by key. Returns `null` when the key has never been set.
 *
 * @param db  The libsql client to read from (mars.db state client).
 * @param key The settings key to look up.
 */
export const getSetting = async (db: Client, key: string): Promise<string | null> => {
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
 * @param db    The libsql client to write to (mars.db state client).
 * @param key   The settings key to persist.
 * @param value The string value to store.
 */
export const setSetting = async (db: Client, key: string, value: string): Promise<void> => {
  const now = new Date().toISOString()
  await db.execute({
    sql: `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    args: [key, value, now],
  })
}
