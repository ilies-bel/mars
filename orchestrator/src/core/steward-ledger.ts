/**
 * Append-only evidence for proactive Steward interventions.
 *
 * A target is identified by its kind, id, and current version (or content
 * hash). Keeping that version in every row lets callers distinguish a repeat
 * intervention from a legitimate response to a changed target.
 */

import { randomUUID } from 'node:crypto'
import type { DbClient } from './lib/db.js'
import { ensureSchema } from './lib/pg-schema.js'
import { resolveStateClient } from './store/state-client.js'

export interface StewardLedgerEntry {
  targetKind: string
  targetId: string
  targetVersion: string
  recipeId: string
  rationale: string
  outcome: string
  commitSha?: string | null
  /** Override for imported or deterministically tested historical entries. */
  ts?: string
}

export interface StewardLedgerRow extends Required<StewardLedgerEntry> {
  id: string
}

let initialized = false

const client = (): DbClient => resolveStateClient()

const init = async (): Promise<void> => {
  if (initialized) return
  await ensureSchema(client())
  initialized = true
}

const rowToStewardLedgerEntry = (
  row: Record<string, unknown>,
): StewardLedgerRow => ({
  id: String(row.id),
  ts: String(row.ts),
  targetKind: String(row.target_kind),
  targetId: String(row.target_id),
  targetVersion: String(row.target_version),
  recipeId: String(row.recipe_id),
  rationale: String(row.rationale),
  outcome: String(row.outcome),
  commitSha:
    row.commit_sha === null || row.commit_sha === undefined
      ? null
      : String(row.commit_sha),
})

/** Record an intervention and return its immutable ledger id. */
export const recordStewardIntervention = async (
  entry: StewardLedgerEntry,
): Promise<string> => {
  await init()
  const id = randomUUID()
  await client().execute({
    sql: `INSERT INTO steward_ledger
            (id, ts, target_kind, target_id, target_version, recipe_id, rationale, outcome, commit_sha)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      entry.ts ?? new Date().toISOString(),
      entry.targetKind,
      entry.targetId,
      entry.targetVersion,
      entry.recipeId,
      entry.rationale,
      entry.outcome,
      entry.commitSha ?? null,
    ],
  })
  return id
}

/** Return an intervention history for one stable target, newest first. */
export const listStewardLedgerFor = async (
  kind: string,
  id: string,
): Promise<StewardLedgerRow[]> => {
  await init()
  const result = await client().execute({
    sql: `SELECT * FROM steward_ledger
          WHERE target_kind = ? AND target_id = ?
          ORDER BY ts DESC, id DESC`,
    args: [kind, id],
  })
  return result.rows.map((row) =>
    rowToStewardLedgerEntry(row as Record<string, unknown>),
  )
}

/** Return all interventions at or after the supplied ISO-8601 timestamp. */
export const listStewardLedgerSince = async (
  ts: string,
): Promise<StewardLedgerRow[]> => {
  await init()
  const result = await client().execute({
    sql: `SELECT * FROM steward_ledger WHERE ts >= ? ORDER BY ts DESC, id DESC`,
    args: [ts],
  })
  return result.rows.map((row) =>
    rowToStewardLedgerEntry(row as Record<string, unknown>),
  )
}
