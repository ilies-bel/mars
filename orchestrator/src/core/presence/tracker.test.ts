/**
 * Tests for the presence tracker:
 *   - `detectTransition(prev, next, thresholdMs)` — pure transition predicate.
 *   - `recordPing(db, ts, thresholdMs)` — stateful ping recorder.
 *
 * `detectTransition` is tested with plain assertions (no DB).
 * `recordPing` uses an in-process PGlite database seeded by `ensureSchema`
 * so the tests verify real DB writes rather than mocked collaborators.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openDb, type DbClient } from '../lib/db.js'
import { ensureSchema } from '../lib/pg-schema.js'
import { detectTransition, recordPing } from './tracker.js'

// ── detectTransition (pure) ────────────────────────────────────────────────

describe('detectTransition', () => {
  it('returns false when prev is null — first ping has no prior away span', () => {
    expect(detectTransition(null, 10_000, 5_000)).toBe(false)
  })

  it('returns false when gap is strictly below the threshold', () => {
    expect(detectTransition(1_000, 4_000, 5_000)).toBe(false) // gap 3 000 < 5 000
  })

  it('returns false when gap is one millisecond below the threshold', () => {
    expect(detectTransition(0, 4_999, 5_000)).toBe(false)
  })

  it('returns true when gap exactly meets the threshold', () => {
    expect(detectTransition(0, 5_000, 5_000)).toBe(true)
  })

  it('returns true when gap exceeds the threshold', () => {
    expect(detectTransition(1_000, 10_000, 5_000)).toBe(true) // gap 9 000 > 5 000
  })
})

// ── recordPing (stateful, uses PGlite) ────────────────────────────────────

describe('recordPing', () => {
  let db: DbClient

  beforeEach(async () => {
    db = openDb(`pglite://presence-tracker-test-${randomUUID()}`)
    await ensureSchema(db)
  })

  afterEach(async () => {
    await db.close()
  })

  it('first ping produces no transition row', async () => {
    await recordPing(db, 1_000, 5_000)

    const { rows } = await db.execute('SELECT * FROM presence_transitions')
    expect(rows).toHaveLength(0)
  })

  it('ping stream with no gap produces zero transition rows', async () => {
    await recordPing(db, 1_000, 5_000)
    await recordPing(db, 3_000, 5_000) // gap 2 000 < threshold 5 000

    const { rows } = await db.execute('SELECT * FROM presence_transitions')
    expect(rows).toHaveLength(0)
  })

  it('single gap longer than threshold produces exactly one transition row', async () => {
    await recordPing(db, 1_000, 5_000)
    await recordPing(db, 10_000, 5_000) // gap 9 000 ≥ threshold 5 000

    const { rows } = await db.execute(
      'SELECT * FROM presence_transitions ORDER BY id',
    )
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].from_ms)).toBe(1_000)
    expect(Number(rows[0].to_ms)).toBe(10_000)
    expect(Number(rows[0].threshold_ms)).toBe(5_000)
  })

  it('duplicate pings arriving after a gap still produce exactly one transition row', async () => {
    await recordPing(db, 1_000, 5_000)
    await recordPing(db, 10_000, 5_000) // gap → transition
    await recordPing(db, 10_001, 5_000) // no gap — no new transition
    await recordPing(db, 10_002, 5_000) // no gap — no new transition

    const { rows } = await db.execute('SELECT * FROM presence_transitions')
    expect(rows).toHaveLength(1)
  })

  it('two separate away spans produce exactly two transition rows', async () => {
    // First away span
    await recordPing(db, 1_000, 5_000)
    await recordPing(db, 10_000, 5_000) // gap → first transition

    // Second away span
    await recordPing(db, 10_100, 5_000) // no gap
    await recordPing(db, 20_000, 5_000) // gap → second transition

    const { rows } = await db.execute(
      'SELECT * FROM presence_transitions ORDER BY id',
    )
    expect(rows).toHaveLength(2)
    expect(Number(rows[0].from_ms)).toBe(1_000)
    expect(Number(rows[1].from_ms)).toBe(10_100)
  })
})
