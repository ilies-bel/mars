import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { openLibsql } from '../libsql'
import type { RaiseActionQueueItem } from '../action-queue'

// Hoisted mock of raiseActionQueueItem so checkOutboxLag's import resolves to
// the spy.  Other action-queue exports keep their real implementations — only
// the side-effect surface that would otherwise need a real state.db is
// stubbed.
const raiseSpy = vi.hoisted(() =>
  vi.fn(async (_item: unknown): Promise<string> => 'mock-item-id'),
)
vi.mock('../action-queue', async (importActual) => {
  const actual = await importActual<typeof import('../action-queue')>()
  return { ...actual, raiseActionQueueItem: raiseSpy }
})

// Import AFTER the mock is registered.
const { checkOutboxLag } = await import('../outbox-lag')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-outbox-lag-'))
  return join(dir, 'mars.db')
}

const EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    type    TEXT    NOT NULL,
    payload TEXT    NOT NULL DEFAULT '{}',
    ts      INTEGER NOT NULL DEFAULT 0
  )
`

const SUBSCRIBERS_DDL = `
  CREATE TABLE IF NOT EXISTS subscribers (
    name   TEXT    PRIMARY KEY,
    cursor INTEGER NOT NULL
  )
`

const insertEvent = () => ({
  sql: 'INSERT INTO events (type, payload, ts) VALUES (?, ?, ?)',
  args: ['task.event', '{}', 0],
})

const insertSubscriber = (name: string, cursor: number) => ({
  sql: 'INSERT INTO subscribers (name, cursor) VALUES (?, ?)',
  args: [name, cursor],
})

const seedOutbox = async (
  dbPath: string,
  eventCount: number,
  subscribers: Array<{ name: string; cursor: number }>,
): Promise<void> => {
  const client = openLibsql({ url: `file:${dbPath}` })
  try {
    await client.execute(EVENTS_DDL)
    await client.execute(SUBSCRIBERS_DDL)
    for (let i = 0; i < eventCount; i++) {
      await client.execute(insertEvent())
    }
    for (const s of subscribers) {
      await client.execute(insertSubscriber(s.name, s.cursor))
    }
  } finally {
    client.close()
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  raiseSpy.mockClear()
})

describe('checkOutboxLag — empty subscribers (no-op)', () => {
  it('returns lag=0, raised=false and does not call raiseActionQueueItem', async () => {
    const dbPath = tmpDbPath()
    // 10 events but no subscribers — nobody can be wedged.
    await seedOutbox(dbPath, 10, [])

    const result = await checkOutboxLag(dbPath, 5)

    expect(result).toEqual({ lag: 0, raised: false })
    expect(raiseSpy).not.toHaveBeenCalled()
  })
})

describe('checkOutboxLag — under threshold (no raise)', () => {
  it('returns the computed lag without raising', async () => {
    const dbPath = tmpDbPath()
    // 10 events, subscriber consumed up to id 8 → lag = 2
    await seedOutbox(dbPath, 10, [{ name: 'worker', cursor: 8 }])

    const result = await checkOutboxLag(dbPath, 5)

    expect(result).toEqual({ lag: 2, raised: false })
    expect(raiseSpy).not.toHaveBeenCalled()
  })
})

describe('checkOutboxLag — over threshold (raises one item)', () => {
  it('calls raiseActionQueueItem with the outbox-lag kind and stable signature', async () => {
    const dbPath = tmpDbPath()
    // 100 events, subscriber stuck at cursor 10 → lag = 90
    await seedOutbox(dbPath, 100, [{ name: 'wedged', cursor: 10 }])

    const result = await checkOutboxLag(dbPath, 50)

    expect(result).toEqual({ lag: 90, raised: true })
    expect(raiseSpy).toHaveBeenCalledTimes(1)

    const raised = raiseSpy.mock.calls[0]?.[0] as RaiseActionQueueItem
    expect(raised.kind).toBe('outbox-lag')
    expect(raised.signature).toBe('outbox-lag')
    // Title surfaces both the actual lag and the configured threshold.
    expect(raised.title).toContain('90')
    expect(raised.title).toContain('50')
    expect(raised.body).toContain('90')
    expect(raised.body).toContain('50')
    expect(raised.payload).toMatchObject({
      lag: 90,
      threshold: 50,
      head: 100,
      tail: 10,
    })
    expect(raised.raisedBy).toBe('outbox-lag-detector')
  })
})

describe('checkOutboxLag — repeated over-threshold check (dedup contract)', () => {
  it('uses the same stable signature on every call so raiseActionQueueItem dedupes to one row', async () => {
    const dbPath = tmpDbPath()
    await seedOutbox(dbPath, 100, [{ name: 'wedged', cursor: 10 }])

    const first = await checkOutboxLag(dbPath, 50)
    const second = await checkOutboxLag(dbPath, 50)

    expect(first).toEqual({ lag: 90, raised: true })
    expect(second).toEqual({ lag: 90, raised: true })
    // Both invocations carry the SAME stable signature; the action-queue
    // store keys dedup on that signature, so two checks fold onto one row.
    expect(raiseSpy).toHaveBeenCalledTimes(2)
    const signatures = raiseSpy.mock.calls.map(
      (call) => (call[0] as RaiseActionQueueItem).signature,
    )
    expect(signatures).toEqual(['outbox-lag', 'outbox-lag'])
  })
})
