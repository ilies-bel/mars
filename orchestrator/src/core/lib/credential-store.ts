/**
 * credential-store — env-var-based credential registry.
 *
 * Maps human-readable credential names to environment variable names.
 * The actual secret lives in the shell environment; this table stores only
 * the indirection (name → env_var) so E2E runners can look up what variable
 * to read when they need a credential.
 */

import { resolveStateClient } from '../store/state-client.js'
import type { DbTx } from './db.js'

const CREDENTIALS_DDL = `CREATE TABLE IF NOT EXISTS credentials (
  name        TEXT PRIMARY KEY,
  env_var     TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
)`

/** Idempotent CREATE TABLE for the credentials table. */
export const ensureCredentialSchema = async (client: DbTx): Promise<void> => {
  await client.execute(CREDENTIALS_DDL)
}

/** A credential row as returned by {@link listCredentials}. */
export interface Credential {
  name: string
  envVar: string
  description: string
  createdAt: string
}

interface CredentialRow {
  name: string
  env_var: string
  description: string
  created_at: string
}

/**
 * Upsert a credential. If a credential with the same name already exists,
 * its env_var, description, and created_at are updated in place.
 */
export const setCredential = async (
  name: string,
  envVar: string,
  description = '',
): Promise<void> => {
  const c = resolveStateClient()
  const createdAt = new Date().toISOString()
  await c.execute(
    `INSERT INTO credentials (name, env_var, description, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET
       env_var     = excluded.env_var,
       description = excluded.description,
       created_at  = excluded.created_at`,
    [name, envVar, description, createdAt],
  )
}

/**
 * Delete a credential by name. Silently does nothing if no credential with
 * that name exists.
 */
export const removeCredential = async (name: string): Promise<void> => {
  const c = resolveStateClient()
  await c.execute(`DELETE FROM credentials WHERE name = ?`, [name])
}

/** Return all credentials ordered by name. */
export const listCredentials = async (): Promise<Credential[]> => {
  const c = resolveStateClient()
  const r = await c.execute(
    `SELECT name, env_var, description, created_at FROM credentials ORDER BY name`,
  )
  return (r.rows as unknown as CredentialRow[]).map((row) => ({
    name: row.name,
    envVar: row.env_var,
    description: row.description,
    createdAt: row.created_at,
  }))
}

/**
 * For each credential row, read `process.env[envVar]` and return a
 * `{ name: value }` map. Credentials whose env var is not set in the current
 * process are omitted.
 */
export const resolveCredentialEnv = async (): Promise<Record<string, string>> => {
  const credentials = await listCredentials()
  const result: Record<string, string> = {}
  for (const { name, envVar } of credentials) {
    const value = process.env[envVar]
    if (value !== undefined) {
      result[name] = value
    }
  }
  return result
}
