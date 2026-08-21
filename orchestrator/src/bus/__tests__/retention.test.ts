/**
 * The single history retention policy.
 *
 * Every test drives `pruneEvents` through its public interface and asserts on
 * observable side-effects — which rows survive and the returned counts. No
 * internals are touched, so a rewrite of the pass ordering or the SQL keeps
 * these green.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { getTestDb, TEST_DB_TARGET } from '../../../test/db-fixture.js'
import type { DbClient } from '../../core/lib/db.js'
import { EVENT_RETENTION, pruneEvents } from '../retention.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Epoch-ms timestamp `days` in the past. */
const daysAgo = (days: number): number => Date.now() - days * MS_PER_DAY

let client: DbClient

const seedTraceEvent = async (id: string, timestamp: number): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO trace_events (id, timestamp, kind, severity, payload)
          VALUES (?, ?, 'log_line', 'warn', '{}')`,
    args: [id, timestamp],
  })
}

/** Insert an event row and return its generated id. */
const seedEvent = async (ts: number): Promise<number> => {
  const r = await client.execute({
    sql: `INSERT INTO events (type, payload, ts) VALUES ('task.event', '{}', ?)
          RETURNING id`,
    args: [ts],
  })
  return Number((r.rows[0] as unknown as { id: number | bigint }).id)
}

const traceEventIds = async (): Promise<string[]> => {
  const r = await client.execute('SELECT id FROM trace_events ORDER BY timestamp')
  return r.rows.map((row) => (row as unknown as { id: string }).id)
}

const eventIds = async (): Promise<number[]> => {
  const r = await client.execute('SELECT id FROM events ORDER BY id')
  return r.rows.map((row) => Number((row as unknown as { id: number | bigint }).id))
}

beforeEach(async () => {
  client = await getTestDb()
})

describe('EVENT_RETENTION', () => {
  it('states one window and one cap for all orchestrator history', () => {
    expect(EVENT_RETENTION.days).toBe(30)
    expect(EVENT_RETENTION.maxRows).toBe(50_000)
  })
})

describe('pruneEvents — age window', () => {
  it('removes trace_events older than the window and keeps in-window rows', async () => {
    await seedTraceEvent('stale-1', daysAgo(EVENT_RETENTION.days + 1))
    await seedTraceEvent('stale-2', daysAgo(EVENT_RETENTION.days + 400))
    await seedTraceEvent('fresh-1', daysAgo(1))
    await seedTraceEvent('fresh-2', daysAgo(EVENT_RETENTION.days - 1))

    const r = await pruneEvents(TEST_DB_TARGET)

    expect(r.traceEventsByAge).toBe(2)
    expect(await traceEventIds()).toEqual(['fresh-2', 'fresh-1'])
  })

  it('removes events older than the window and keeps in-window rows', async () => {
    const stale = await seedEvent(daysAgo(EVENT_RETENTION.days + 1))
    const fresh = await seedEvent(daysAgo(EVENT_RETENTION.days - 1))

    const r = await pruneEvents(TEST_DB_TARGET)

    expect(r.eventsByAge).toBe(1)
    expect(await eventIds()).toEqual([fresh])
    expect(stale).not.toBe(fresh)
  })

  it('ages out events written the way production writes them', async () => {
    // The publisher never supplies `ts`; the column DEFAULT does, in epoch
    // milliseconds. A cutoff computed in seconds would never match — that unit
    // mismatch is what left `events` unbounded.
    await client.execute(
      `INSERT INTO events (type, payload) VALUES ('task.event', '{}')`,
    )
    const old = await seedEvent(daysAgo(EVENT_RETENTION.days + 1))

    const r = await pruneEvents(TEST_DB_TARGET)

    expect(r.eventsByAge).toBe(1)
    expect(await eventIds()).not.toContain(old)
  })

  it('removes task_transcripts older than the window and keeps in-window rows', async () => {
    await client.execute({
      sql: `INSERT INTO task_transcripts (task_id, session_id, seq, chunk, ts)
            VALUES ('t-stale', 's', 0, '[]', ?), ('t-fresh', 's', 0, '[]', ?)`,
      args: [daysAgo(EVENT_RETENTION.days + 1), daysAgo(1)],
    })

    const r = await pruneEvents(TEST_DB_TARGET)

    expect(r.transcriptsByAge).toBe(1)
    const rows = await client.execute('SELECT task_id FROM task_transcripts')
    expect(rows.rows.map((x) => (x as unknown as { task_id: string }).task_id)).toEqual([
      't-fresh',
    ])
  })

  it('skips the age passes when days is 0', async () => {
    await seedTraceEvent('ancient', daysAgo(9_999))
    await seedEvent(daysAgo(9_999))

    const r = await pruneEvents(TEST_DB_TARGET, { days: 0 })

    expect(r.traceEventsByAge).toBe(0)
    expect(r.eventsByAge).toBe(0)
    expect(await traceEventIds()).toEqual(['ancient'])
  })

  it('deletes no more than batchSize rows per pass', async () => {
    for (let i = 0; i < 10; i++) {
      await seedTraceEvent(`stale-${i}`, daysAgo(EVENT_RETENTION.days + 1 + i))
    }

    const r = await pruneEvents(TEST_DB_TARGET, { batchSize: 4 })

    expect(r.traceEventsByAge).toBe(4)
  })
})

describe('pruneEvents — row-count cap', () => {
  it('trims the oldest trace_events down to maxRows', async () => {
    for (let i = 0; i < 10; i++) await seedTraceEvent(`e-${i}`, daysAgo(1) + i)

    const r = await pruneEvents(TEST_DB_TARGET, { maxRows: 4, days: 0 })

    expect(r.traceEventsByCount).toBe(6)
    expect(r.traceEventsRemaining).toBe(4)
    expect(await traceEventIds()).toEqual(['e-6', 'e-7', 'e-8', 'e-9'])
  })

  it('trims the oldest events down to maxRows', async () => {
    const ids: number[] = []
    for (let i = 0; i < 10; i++) ids.push(await seedEvent(daysAgo(1)))

    const r = await pruneEvents(TEST_DB_TARGET, { maxRows: 4, days: 0 })

    expect(r.eventsByCount).toBe(6)
    expect(r.eventsRemaining).toBe(4)
    expect(await eventIds()).toEqual(ids.slice(6))
  })

  it('loops batched deletes until the table is under maxRows', async () => {
    for (let i = 0; i < 20; i++) await seedTraceEvent(`e-${i}`, daysAgo(1) + i)

    const r = await pruneEvents(TEST_DB_TARGET, {
      maxRows: 5,
      days: 0,
      batchSize: 3,
    })

    expect(r.traceEventsByCount).toBe(15)
    expect(r.traceEventsRemaining).toBe(5)
  })

  it('deletes nothing when the table is at or below maxRows', async () => {
    for (let i = 0; i < 4; i++) await seedTraceEvent(`e-${i}`, daysAgo(1) + i)

    const r = await pruneEvents(TEST_DB_TARGET, { maxRows: 4, days: 0 })

    expect(r.traceEventsByCount).toBe(0)
    expect(r.traceEventsRemaining).toBe(4)
  })
})

describe('pruneEvents — subscriber consumption gate', () => {
  it('never deletes events a registered subscriber has not consumed', async () => {
    const consumed = await seedEvent(daysAgo(EVENT_RETENTION.days + 1))
    const unconsumed = await seedEvent(daysAgo(EVENT_RETENTION.days + 1))
    await client.execute({
      sql: 'INSERT INTO subscribers (name, cursor) VALUES (?, ?)',
      args: ['lagging', consumed],
    })

    const r = await pruneEvents(TEST_DB_TARGET)

    expect(r.eventsByAge).toBe(1)
    expect(await eventIds()).toEqual([unconsumed])
  })

  it('holds the table above the cap rather than trimming unconsumed events', async () => {
    const ids: number[] = []
    for (let i = 0; i < 10; i++) ids.push(await seedEvent(daysAgo(1)))
    await client.execute({
      sql: 'INSERT INTO subscribers (name, cursor) VALUES (?, ?)',
      args: ['lagging', ids[1]],
    })

    const r = await pruneEvents(TEST_DB_TARGET, { maxRows: 4, days: 0 })

    expect(r.eventsByCount).toBe(2)
    expect(r.eventsRemaining).toBe(8)
    expect(await eventIds()).toEqual(ids.slice(2))
  })

  it('gates on the slowest subscriber when several are registered', async () => {
    const ids: number[] = []
    for (let i = 0; i < 4; i++) ids.push(await seedEvent(daysAgo(EVENT_RETENTION.days + 1)))
    await client.execute({
      sql: 'INSERT INTO subscribers (name, cursor) VALUES (?, ?), (?, ?)',
      args: ['fast', ids[3], 'slow', ids[0]],
    })

    const r = await pruneEvents(TEST_DB_TARGET)

    expect(r.eventsByAge).toBe(1)
    expect(await eventIds()).toEqual(ids.slice(1))
  })

  it('ages out old events when no subscriber is registered', async () => {
    // The old outbox prune returned early on a subscriber-less store, so these
    // rows accumulated forever. There is no cursor to protect: prune them.
    await seedEvent(daysAgo(EVENT_RETENTION.days + 1))
    await seedEvent(daysAgo(EVENT_RETENTION.days + 1))

    const r = await pruneEvents(TEST_DB_TARGET)

    expect(r.eventsByAge).toBe(2)
    expect(await eventIds()).toEqual([])
  })
})

describe('pruneEvents — dedup-ledger hygiene', () => {
  it('removes ledger rows whose event is gone and keeps the rest', async () => {
    const live = await seedEvent(daysAgo(1))
    const stale = await seedEvent(daysAgo(EVENT_RETENTION.days + 1))
    await client.execute({
      sql: `INSERT INTO subscriber_processed_events (subscriber_id, event_id)
            VALUES ('s', ?), ('s', ?)`,
      args: [live, stale],
    })

    const r = await pruneEvents(TEST_DB_TARGET)

    expect(r.eventsByAge).toBe(1)
    expect(r.subscriberProcessedEventsOrphans).toBe(1)
    const rows = await client.execute(
      'SELECT event_id FROM subscriber_processed_events',
    )
    expect(rows.rows.map((x) => Number((x as unknown as { event_id: bigint }).event_id))).toEqual(
      [live],
    )
  })
})
