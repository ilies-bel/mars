/**
 * Away-digest subscriber — behaviour tests.
 *
 * Tests drive the subscriber handler directly (no running dispatcher) and
 * verify observable DB state — rows in `main_thread_entries` — rather than
 * internal implementation details. A real PGlite database seeded by
 * `ensureSchema` is used so the UNIQUE(transition_id) constraint is exercised
 * in exactly the same way as production.
 *
 * `composeAwayDigest` is NOT mocked: the tests pass a controlled `loadEvents`
 * stub instead, which is the intended extension point for the digest composer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openDb, type DbClient } from '../lib/db.js'
import { ensureSchema } from '../lib/pg-schema.js'
import type { BusEvent } from '../../bus/events.js'
import type { NarrationEvent } from '../../narration/types.js'
import { buildAwayDigestSubscriber, AWAY_DIGEST_SUBSCRIBER } from './awayDigest.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid `presence.transition` BusEvent. */
function makeTransitionEvent(
  transitionId: number,
  fromMs: number,
  toMs: number,
): BusEvent {
  return {
    id: transitionId,
    type: 'presence.transition',
    payload: { transitionId, fromMs, toMs },
    ts: toMs,
  }
}

/** A `loadEvents` stub that returns a non-empty narration list → non-null digest. */
const LANDED_EVENT: NarrationEvent = {
  taskId: 'task-abc',
  title: 'Ship the thing',
  kind: 'task.landed',
}

const loadEventsWithActivity = (_from: number, _to: number): Promise<NarrationEvent[]> =>
  Promise.resolve([LANDED_EVENT])

/** A `loadEvents` stub that returns an empty list → null digest. */
const loadEventsEmpty = (_from: number, _to: number): Promise<NarrationEvent[]> =>
  Promise.resolve([])

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe('buildAwayDigestSubscriber', () => {
  let db: DbClient

  beforeEach(async () => {
    db = openDb(`pglite://away-digest-test-${randomUUID()}`)
    await ensureSchema(db)
  })

  afterEach(async () => {
    await db.close()
  })

  // -------------------------------------------------------------------------
  // Name / registration contract
  // -------------------------------------------------------------------------

  it('subscriber name encodes its trigger event', () => {
    const sub = buildAwayDigestSubscriber(db, loadEventsWithActivity)
    expect(sub.name).toBe(AWAY_DIGEST_SUBSCRIBER)
    expect(sub.name).toContain('presence.transition')
  })

  // -------------------------------------------------------------------------
  // Core behaviour — digest is written to main_thread_entries
  // -------------------------------------------------------------------------

  it('inserts one main_thread_entries row when the span has narrable activity', async () => {
    const sub = buildAwayDigestSubscriber(db, loadEventsWithActivity)
    await sub.handler(makeTransitionEvent(1, 1_000, 10_000))

    const { rows } = await db.execute("SELECT * FROM main_thread_entries WHERE kind = 'away_digest'")
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('away_digest')
    expect(Number(rows[0].transition_id)).toBe(1)
  })

  it('stores the digest payload as valid JSON with counts and lines', async () => {
    const sub = buildAwayDigestSubscriber(db, loadEventsWithActivity)
    await sub.handler(makeTransitionEvent(2, 1_000, 10_000))

    const { rows } = await db.execute('SELECT payload FROM main_thread_entries WHERE transition_id = 2')
    expect(rows).toHaveLength(1)

    const payload = rows[0].payload as { counts: { landed: number }; lines: unknown[] }
    expect(payload.counts.landed).toBe(1)
    expect(payload.lines).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Idempotency — at most one digest per transition
  // -------------------------------------------------------------------------

  it('writes at most one row even when the handler fires twice for the same transition', async () => {
    const sub = buildAwayDigestSubscriber(db, loadEventsWithActivity)

    await sub.handler(makeTransitionEvent(3, 1_000, 10_000))
    await sub.handler(makeTransitionEvent(3, 1_000, 10_000))

    const { rows } = await db.execute(
      'SELECT * FROM main_thread_entries WHERE transition_id = 3',
    )
    expect(rows).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // No-op when the digest is null (empty span)
  // -------------------------------------------------------------------------

  it('writes no row when the span has no narrable activity', async () => {
    const sub = buildAwayDigestSubscriber(db, loadEventsEmpty)
    await sub.handler(makeTransitionEvent(4, 1_000, 10_000))

    const { rows } = await db.execute('SELECT * FROM main_thread_entries')
    expect(rows).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Event-type filter — non-transition events are ignored
  // -------------------------------------------------------------------------

  it('ignores non-presence.transition events without inserting a row', async () => {
    const sub = buildAwayDigestSubscriber(db, loadEventsWithActivity)

    const unrelated: BusEvent = {
      id: 99,
      type: 'task.queued',
      payload: { taskId: 'task-x' },
      ts: Date.now(),
    }
    await sub.handler(unrelated)

    const { rows } = await db.execute('SELECT * FROM main_thread_entries')
    expect(rows).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Multiple distinct transitions — one row each
  // -------------------------------------------------------------------------

  it('inserts one row per distinct transition', async () => {
    const sub = buildAwayDigestSubscriber(db, loadEventsWithActivity)

    await sub.handler(makeTransitionEvent(10, 1_000, 10_000))
    await sub.handler(makeTransitionEvent(11, 15_000, 25_000))

    const { rows } = await db.execute(
      "SELECT * FROM main_thread_entries WHERE kind = 'away_digest' ORDER BY transition_id",
    )
    expect(rows).toHaveLength(2)
    expect(Number(rows[0].transition_id)).toBe(10)
    expect(Number(rows[1].transition_id)).toBe(11)
  })
})
