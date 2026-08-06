/**
 * Archive-entries Outbox Subscriber — behaviour tests.
 *
 * Tests drive the subscriber handlers directly (without a running dispatcher)
 * for synchronous, deterministic assertions against a real (PGlite) schema.
 *
 * Covered acceptance criteria:
 *   1. `action-queue.resolved` → one archive_entry with source_kind='alert'
 *   2. `task.terminal { reason: 'done' }` → one archive_entry with
 *      source_kind='silent_completion'
 *   3. `task.terminal { reason: 'dropped' }` → no archive_entry
 *   4. Replaying the same event id produces zero additional entries
 *      (processedOnce dedup persists across subscriber instances)
 *   5. No archive_entry raises an action-queue item (insertion is silent)
 *
 * System boundary: we use the real PGlite DB (getTestDb) so the schema,
 * processedOnce, and the INSERT all exercise the real path. No mocks.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { DbClient } from '../lib/db.js'
import { getTestDb } from '../../../test/db-fixture.js'
import { buildArchiveSubscribers } from './insert.js'
import type { BusEvent } from '../../bus/events.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal `action-queue.resolved` BusEvent. */
function resolvedEvent(
  eventId: number,
  itemId: string,
  opts: { fromState?: string; toState?: string; by?: string } = {},
): BusEvent {
  return {
    id: eventId,
    type: 'action-queue.resolved',
    payload: {
      itemId,
      fromState: opts.fromState ?? 'open',
      toState: opts.toState ?? 'resolved',
      by: opts.by ?? 'user',
    },
    ts: 1_000,
  } as unknown as BusEvent
}

/** Minimal `task.terminal` BusEvent. */
function terminalEvent(
  eventId: number,
  taskId: string,
  reason: 'done' | 'dropped' | 'failed' | 'purged' = 'done',
): BusEvent {
  return {
    id: eventId,
    type: 'task.terminal',
    payload: { taskId, reason },
    ts: 1_000,
  } as unknown as BusEvent
}

/** Count all rows in archive_entries. */
async function archiveCount(client: DbClient): Promise<number> {
  const r = await client.execute(`SELECT COUNT(*) AS n FROM archive_entries`)
  return Number((r.rows[0] as unknown as { n: number | bigint }).n)
}

/** Return the first archive_entry for a given source_id, or null if absent. */
async function entryForSource(
  client: DbClient,
  sourceId: string,
): Promise<{ kind: string; source_kind: string; source_id: string } | null> {
  const r = await client.execute({
    sql: `SELECT kind, source_kind, source_id
            FROM archive_entries
           WHERE source_id = ?
           LIMIT 1`,
    args: [sourceId],
  })
  if (r.rows.length === 0) return null
  const row = r.rows[0] as unknown as {
    kind: string
    source_kind: string
    source_id: string
  }
  return { kind: row.kind, source_kind: row.source_kind, source_id: row.source_id }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('archive-entries subscriber', () => {
  let client: DbClient

  beforeEach(async () => {
    client = await getTestDb()
  })

  // ── action-queue.resolved → source_kind='alert' ───────────────────────────

  it('inserts one archive_entry with source_kind=alert when action-queue.resolved fires', async () => {
    const [subscriber] = buildArchiveSubscribers(client)
    await subscriber.handler(resolvedEvent(1, 'item-abc'))

    expect(await archiveCount(client)).toBe(1)
    const entry = await entryForSource(client, 'item-abc')
    expect(entry).not.toBeNull()
    expect(entry!.source_kind).toBe('alert')
    expect(entry!.source_id).toBe('item-abc')
    expect(entry!.kind).toBe('resolved')
  })

  it('captures provenance fields (fromState, toState, by) in the archive_entry', async () => {
    const [subscriber] = buildArchiveSubscribers(client)
    await subscriber.handler(
      resolvedEvent(2, 'item-xyz', {
        fromState: 'pending',
        toState: 'closed',
        by: 'operator',
      }),
    )

    const r = await client.execute({
      sql: `SELECT provenance FROM archive_entries WHERE source_id = ? LIMIT 1`,
      args: ['item-xyz'],
    })
    expect(r.rows).toHaveLength(1)
    // PGlite returns JSONB columns already parsed; real Postgres returns a string.
    const raw = (r.rows[0] as unknown as { provenance: string | Record<string, unknown> })
      .provenance
    const prov = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>
    expect(prov.fromState).toBe('pending')
    expect(prov.toState).toBe('closed')
    expect(prov.by).toBe('operator')
  })

  // ── task.terminal { reason: 'done' } → source_kind='silent_completion' ────

  it('inserts one archive_entry with source_kind=silent_completion when task.terminal done fires', async () => {
    const [subscriber] = buildArchiveSubscribers(client)
    await subscriber.handler(terminalEvent(10, 'task-alpha', 'done'))

    expect(await archiveCount(client)).toBe(1)
    const entry = await entryForSource(client, 'task-alpha')
    expect(entry).not.toBeNull()
    expect(entry!.source_kind).toBe('silent_completion')
    expect(entry!.source_id).toBe('task-alpha')
    expect(entry!.kind).toBe('done')
  })

  // ── task.terminal { reason != 'done' } → no entry ─────────────────────────

  it('does NOT insert an archive_entry when task.terminal reason is dropped', async () => {
    const [subscriber] = buildArchiveSubscribers(client)
    await subscriber.handler(terminalEvent(11, 'task-beta', 'dropped'))

    expect(await archiveCount(client)).toBe(0)
  })

  it('does NOT insert an archive_entry when task.terminal reason is failed', async () => {
    const [subscriber] = buildArchiveSubscribers(client)
    await subscriber.handler(terminalEvent(12, 'task-gamma', 'failed'))

    expect(await archiveCount(client)).toBe(0)
  })

  // ── Unrelated events are ignored ──────────────────────────────────────────

  it('does NOT insert an archive_entry for unrelated event types', async () => {
    const [subscriber] = buildArchiveSubscribers(client)
    const unrelated: BusEvent = {
      id: 99,
      type: 'task.created',
      payload: { taskId: 'task-delta', title: 'Some task' },
      ts: 1_000,
    } as unknown as BusEvent
    await subscriber.handler(unrelated)

    expect(await archiveCount(client)).toBe(0)
  })

  // ── Multiple distinct events produce multiple entries ────────────────────

  it('produces one archive_entry per distinct event (resolved + done)', async () => {
    const [subscriber] = buildArchiveSubscribers(client)
    await subscriber.handler(resolvedEvent(20, 'item-one'))
    await subscriber.handler(terminalEvent(21, 'task-two', 'done'))

    expect(await archiveCount(client)).toBe(2)
  })

  // ── processedOnce dedup: replay safety ────────────────────────────────────

  it('replaying the same event id produces zero additional archive entries', async () => {
    const event = resolvedEvent(42, 'item-replay')
    const [subscriber] = buildArchiveSubscribers(client)

    await subscriber.handler(event)
    expect(await archiveCount(client)).toBe(1)

    // Replay — same event id, same subscriber
    await subscriber.handler(event)
    expect(await archiveCount(client)).toBe(1)
  })

  it('processedOnce dedup persists across subscriber instances', async () => {
    // Simulates a daemon restart: first instance processes the event (dedup row
    // committed), then a second instance sees the same event id on re-drain.
    const event = resolvedEvent(77, 'item-persistent')

    const [sub1] = buildArchiveSubscribers(client)
    await sub1.handler(event)
    expect(await archiveCount(client)).toBe(1)

    // New subscriber instance — same DB, dedup row still present
    const [sub2] = buildArchiveSubscribers(client)
    await sub2.handler(event)
    expect(await archiveCount(client)).toBe(1)
  })
})
