import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { openLibsql } from '../libsql'
import { pruneOutbox } from '../outbox-prune'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-outbox-prune-'))
  return join(dir, 'mars.db')
}

const EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    type    TEXT    NOT NULL,
    payload TEXT    NOT NULL DEFAULT '{}',
    ts      INTEGER NOT NULL
  )
`

const SUBSCRIBERS_DDL = `
  CREATE TABLE IF NOT EXISTS subscribers (
    name   TEXT    PRIMARY KEY,
    cursor INTEGER NOT NULL
  )
`

/** Unix timestamp in seconds, offset from now. Negative = past. */
const unixOffset = (offsetSeconds: number): number =>
  Math.floor(Date.now() / 1000) + offsetSeconds

const insertEvent = (ts: number) => ({
  sql: 'INSERT INTO events (type, payload, ts) VALUES (?, ?, ?)',
  args: ['task.event', '{}', ts],
})

const insertSubscriber = (name: string, cursor: number) => ({
  sql: 'INSERT INTO subscribers (name, cursor) VALUES (?, ?)',
  args: [name, cursor],
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pruneOutbox — empty subscribers (no-op)', () => {
  it('returns 0 and deletes nothing when no subscribers are registered', async () => {
    const dbPath = tmpDbPath()
    const client = openLibsql({ url: `file:${dbPath}` })
    try {
      await client.execute(EVENTS_DDL)
      await client.execute(SUBSCRIBERS_DDL)

      // Seed an old event — it must survive because there are no consumers
      await client.execute(insertEvent(unixOffset(-7200)))

      const deleted = await pruneOutbox(dbPath, 60)

      expect(deleted).toBe(0)
      const remaining = await client.execute('SELECT id FROM events')
      expect(remaining.rows).toHaveLength(1)
    } finally {
      client.close()
    }
  })
})

describe('pruneOutbox — all consumed + young (no-op)', () => {
  it('returns 0 when events are consumed by all subscribers but younger than maxAgeSeconds', async () => {
    const dbPath = tmpDbPath()
    const client = openLibsql({ url: `file:${dbPath}` })
    try {
      await client.execute(EVENTS_DDL)
      await client.execute(SUBSCRIBERS_DDL)

      // Recent event: 30 seconds old
      await client.execute(insertEvent(unixOffset(-30)))
      // Subscriber has consumed it (cursor = 1)
      await client.execute(insertSubscriber('worker', 1))

      // maxAgeSeconds = 3600 (1 hour) — event is only 30 s old, survives
      const deleted = await pruneOutbox(dbPath, 3600)

      expect(deleted).toBe(0)
      const remaining = await client.execute('SELECT id FROM events')
      expect(remaining.rows).toHaveLength(1)
    } finally {
      client.close()
    }
  })
})

describe('pruneOutbox — all consumed + old (deletes)', () => {
  it('deletes events that satisfy both cursor and age gates', async () => {
    const dbPath = tmpDbPath()
    const client = openLibsql({ url: `file:${dbPath}` })
    try {
      await client.execute(EVENTS_DDL)
      await client.execute(SUBSCRIBERS_DDL)

      // Two events, both 2 hours old
      const oldTs = unixOffset(-7200)
      await client.execute(insertEvent(oldTs))
      await client.execute(insertEvent(oldTs))

      // Both subscribers have consumed both events (cursor = 2)
      await client.execute(insertSubscriber('worker-a', 2))
      await client.execute(insertSubscriber('worker-b', 2))

      // maxAgeSeconds = 3600 (1 hour) — both events qualify
      const deleted = await pruneOutbox(dbPath, 3600)

      expect(deleted).toBe(2)
      const remaining = await client.execute('SELECT id FROM events')
      expect(remaining.rows).toHaveLength(0)
    } finally {
      client.close()
    }
  })
})

describe('pruneOutbox — partial consumer + old (deletes up to MIN cursor)', () => {
  it('deletes only rows <= MIN cursor when one subscriber lags behind', async () => {
    const dbPath = tmpDbPath()
    const client = openLibsql({ url: `file:${dbPath}` })
    try {
      await client.execute(EVENTS_DDL)
      await client.execute(SUBSCRIBERS_DDL)

      // Three old events
      const oldTs = unixOffset(-7200)
      await client.execute(insertEvent(oldTs))
      await client.execute(insertEvent(oldTs))
      await client.execute(insertEvent(oldTs))

      // worker-a consumed all 3; worker-b only consumed 1
      // MIN(cursor) = 1, so only event id=1 is pruneable
      await client.execute(insertSubscriber('worker-a', 3))
      await client.execute(insertSubscriber('worker-b', 1))

      const deleted = await pruneOutbox(dbPath, 3600)

      expect(deleted).toBe(1)
      const remaining = await client.execute(
        'SELECT id FROM events ORDER BY id',
      )
      expect(remaining.rows).toHaveLength(2)
      expect(Number(remaining.rows[0].id)).toBe(2)
      expect(Number(remaining.rows[1].id)).toBe(3)
    } finally {
      client.close()
    }
  })
})

describe('pruneOutbox — mixed age+cursor combinations', () => {
  it('only deletes rows satisfying BOTH gates simultaneously', async () => {
    const dbPath = tmpDbPath()
    const client = openLibsql({ url: `file:${dbPath}` })
    try {
      await client.execute(EVENTS_DDL)
      await client.execute(SUBSCRIBERS_DDL)

      const oldTs = unixOffset(-7200) // 2 hours old — past cutoff
      const youngTs = unixOffset(-10) // 10 seconds old — under cutoff

      // event 1: old (will be pruned)
      await client.execute(insertEvent(oldTs))
      // event 2: young (survives age gate)
      await client.execute(insertEvent(youngTs))

      // Subscriber has consumed both (cursor = 2)
      await client.execute(insertSubscriber('worker', 2))

      // 1 hour max age: event 1 (old) qualifies, event 2 (young) does not
      const deleted = await pruneOutbox(dbPath, 3600)

      expect(deleted).toBe(1)
      const remaining = await client.execute('SELECT id FROM events')
      expect(remaining.rows).toHaveLength(1)
      expect(Number(remaining.rows[0].id)).toBe(2)
    } finally {
      client.close()
    }
  })

  it('returns 0 when subscriber cursor is behind even though events are old', async () => {
    const dbPath = tmpDbPath()
    const client = openLibsql({ url: `file:${dbPath}` })
    try {
      await client.execute(EVENTS_DDL)
      await client.execute(SUBSCRIBERS_DDL)

      // Two old events
      const oldTs = unixOffset(-7200)
      await client.execute(insertEvent(oldTs))
      await client.execute(insertEvent(oldTs))

      // Subscriber has not consumed anything yet (cursor = 0)
      await client.execute(insertSubscriber('worker', 0))

      // MIN(cursor) = 0, no event has id <= 0 → nothing to delete
      const deleted = await pruneOutbox(dbPath, 3600)

      expect(deleted).toBe(0)
      const remaining = await client.execute('SELECT id FROM events')
      expect(remaining.rows).toHaveLength(2)
    } finally {
      client.close()
    }
  })
})
