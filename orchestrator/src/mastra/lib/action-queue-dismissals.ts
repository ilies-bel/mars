/**
 * ActionQueue dismissals — the only persistent operator opinion the actionQueue honours.
 *
 * The actionQueue is a per-slice state view: a row exists iff its entity is
 * currently stuck (raised into `action_queue_items`). A *dismissal* lets the operator
 * say "I have seen this one, hide it for now" without changing the entity's
 * state. The dismissal is keyed on `(entityKind, entityId)` and is wiped the
 * moment the entity's state changes — see `clearDismissalForEntity`, called
 * from `updateTask` on every real task status transition. So a dismissed
 * failed task that gets `mars restart`ed (status → queued) reappears in the
 * actionQueue if it fails again, rather than staying silently hidden.
 *
 * This is deliberately NOT the event log. Events (every self-heal raise,
 * recovery finding, auto-close) still go to `action_queue_items` / `action_queue_history`
 * via {@link ./actionQueue}. Dismissals are a tiny side table.
 */

import { type Client } from '@libsql/client'
import { resolveContext } from '../context'
import { openLibsql } from './libsql'

export type DismissalEntityKind = 'task' | 'worktree' | 'proposal'

export interface ActionQueueDismissal {
  entityKind: DismissalEntityKind
  entityId: string
  dismissedAt: string
  dismissedBy: string | null
  note: string | null
}

let clientSingleton: Client | null = null
let initialised = false

const getClient = (): Client => {
  if (clientSingleton) return clientSingleton
  const { stateDbPath } = resolveContext()
  clientSingleton = openLibsql({ url: `file:${stateDbPath}` })
  return clientSingleton
}

export const initActionQueueDismissals = async (): Promise<void> => {
  if (initialised) return
  const c = getClient()
  await c.execute(`
    CREATE TABLE IF NOT EXISTS action_queue_dismissals (
      entity_kind  TEXT NOT NULL,
      entity_id    TEXT NOT NULL,
      dismissed_at TEXT NOT NULL,
      dismissed_by TEXT,
      note         TEXT,
      PRIMARY KEY (entity_kind, entity_id)
    )
  `)
  initialised = true
}

const isDismissalEntityKind = (s: unknown): s is DismissalEntityKind =>
  s === 'task' || s === 'worktree' || s === 'proposal'

export const dismissEntity = async (
  entityKind: DismissalEntityKind,
  entityId: string,
  opts: { by?: string; note?: string } = {},
): Promise<void> => {
  await initActionQueueDismissals()
  const c = getClient()
  await c.execute({
    sql: `INSERT INTO action_queue_dismissals (entity_kind, entity_id, dismissed_at, dismissed_by, note)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
            dismissed_at = excluded.dismissed_at,
            dismissed_by = excluded.dismissed_by,
            note         = excluded.note`,
    args: [
      entityKind,
      entityId,
      new Date().toISOString(),
      opts.by ?? null,
      opts.note ?? null,
    ],
  })
}

export const undismissEntity = async (
  entityKind: DismissalEntityKind,
  entityId: string,
): Promise<boolean> => {
  await initActionQueueDismissals()
  const c = getClient()
  const r = await c.execute({
    sql: `DELETE FROM action_queue_dismissals WHERE entity_kind = ? AND entity_id = ?`,
    args: [entityKind, entityId],
  })
  return r.rowsAffected > 0
}

export const isEntityDismissed = async (
  entityKind: DismissalEntityKind,
  entityId: string,
): Promise<boolean> => {
  await initActionQueueDismissals()
  const c = getClient()
  // Rows with note = 'ack' are acknowledged but not hidden from the open filter.
  // Only note = null (classic dismiss), 'dismissed', or 'resolved' count as dismissed.
  const r = await c.execute({
    sql: `SELECT 1 FROM action_queue_dismissals
          WHERE entity_kind = ? AND entity_id = ? AND (note IS NULL OR note != 'ack')
          LIMIT 1`,
    args: [entityKind, entityId],
  })
  return r.rows.length > 0
}

export const listDismissals = async (): Promise<ActionQueueDismissal[]> => {
  await initActionQueueDismissals()
  const c = getClient()
  const r = await c.execute(
    `SELECT entity_kind, entity_id, dismissed_at, dismissed_by, note
       FROM action_queue_dismissals`,
  )
  return r.rows.flatMap((row) => {
    const r0 = row as unknown as Record<string, unknown>
    const kind = r0.entity_kind
    if (!isDismissalEntityKind(kind)) return []
    return [
      {
        entityKind: kind,
        entityId: r0.entity_id as string,
        dismissedAt: (r0.dismissed_at as string | null) ?? '',
        dismissedBy: (r0.dismissed_by as string | null) ?? null,
        note: (r0.note as string | null) ?? null,
      },
    ]
  })
}

/**
 * Drop any dismissal keyed to a task id. Called from `updateTask` on every
 * real status transition so a dismissed-then-restarted task can resurface.
 * No-op when no dismissal exists.
 */
export const clearDismissalForEntity = async (
  entityKind: DismissalEntityKind,
  entityId: string,
): Promise<void> => {
  await undismissEntity(entityKind, entityId)
}
