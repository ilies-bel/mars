import { createClient, type Client } from '@libsql/client'
import { resolveContext } from '../context'
import type { SweeperPayload } from './server'

let cached: Client | null = null

const client = (): Client => {
  if (cached) return cached
  const { stateDbPath } = resolveContext()
  cached = createClient({ url: `file:${stateDbPath}` })
  return cached
}

const parseJsonObject = (raw: string | null | undefined): Record<string, unknown> => {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * raiseInboxItem deduplicates by fingerprint and bumps `last_seen_at` /
 * `seen_count`, but it does NOT refresh the top-level payload fields on the
 * existing row. The sweeper spec requires `lastSweptAt`, `ageHours`, and
 * `criticality` in the payload to reflect the latest sweep, so we patch the
 * payload here while preserving any prior `occurrences` history.
 */
export const upsertSweeperPayload = async (
  inboxId: string,
  payload: SweeperPayload,
): Promise<void> => {
  const c = client()
  const existing = await c.execute({
    sql: `SELECT payload FROM inbox_items WHERE id = ?`,
    args: [inboxId],
  })
  if (existing.rows.length === 0) return
  const row = existing.rows[0] as unknown as { payload: string | null }
  const prior = parseJsonObject(row.payload)
  const next: Record<string, unknown> = {
    ...prior,
    taskId: payload.taskId,
    branch: payload.branch,
    worktreePath: payload.worktreePath,
    lastSweptAt: payload.lastSweptAt,
    ageHours: payload.ageHours,
    criticality: payload.criticality,
  }
  await c.execute({
    sql: `UPDATE inbox_items SET payload = ? WHERE id = ?`,
    args: [JSON.stringify(next), inboxId],
  })
}
