/**
 * Tests for the daemon heartbeat writer.
 *
 * Behaviour under test:
 *  1. On start, a boot row is upserted with the current pid and boot
 *     timestamp before startHeartbeatWriter resolves.
 *  2. A recurring interval keeps updating last_beat_ts; the timestamp
 *     advances between ticks when `now` advances.
 *
 * Fake timers are used to control the interval without real waits.
 * The DB is stubbed at the system boundary (db.execute) so the test
 * exercises the writer's public interface without a real database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbClient, DbResultSet, DbStatement } from '../../lib/db.js'
import { startHeartbeatWriter } from '../heartbeat-writer.js'

// ── Stub helpers ─────────────────────────────────────────────────────────────

interface CapturedCall {
  sql: string
  args: readonly unknown[]
}

/**
 * Minimal DbClient stub. Only `execute` is implemented; all other members
 * throw if called, ensuring the heartbeat writer stays within its declared
 * surface.
 */
const makeStubDb = (): {
  db: DbClient
  calls: () => CapturedCall[]
} => {
  const captured: CapturedCall[] = []
  const ok: DbResultSet = { rows: [], rowsAffected: 1 }

  const execute = vi.fn(async (stmt: DbStatement): Promise<DbResultSet> => {
    const s = typeof stmt === 'string'
      ? { sql: stmt, args: [] as readonly unknown[] }
      : { sql: stmt.sql, args: stmt.args ?? [] }
    captured.push(s)
    return ok
  })

  const db = { execute } as unknown as DbClient
  return { db, calls: () => captured }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('startHeartbeatWriter — boot row', () => {
  afterEach(() => {
    delete process.env.MARS_HEARTBEAT_MS
  })

  it('upserts a daemon_heartbeat row before resolving', async () => {
    const { db, calls } = makeStubDb()
    const boot = new Date('2026-01-01T00:00:00.000Z')

    const writer = await startHeartbeatWriter({ db, now: () => boot })

    const insertCall = calls().find((c) => c.sql.includes('daemon_heartbeat'))
    expect(insertCall, 'expected an INSERT/UPSERT into daemon_heartbeat').toBeDefined()
    writer.stop()
  })

  it('includes the current process pid in the boot row', async () => {
    const { db, calls } = makeStubDb()
    const boot = new Date('2026-01-01T00:00:00.000Z')

    const writer = await startHeartbeatWriter({ db, now: () => boot })

    const insertCall = calls().find((c) =>
      c.sql.includes('daemon_heartbeat') && c.sql.includes('INSERT'),
    )
    expect(insertCall?.args[0]).toBe(process.pid)
    writer.stop()
  })

  it('includes the boot timestamp in the boot row', async () => {
    const { db, calls } = makeStubDb()
    const boot = new Date('2026-07-26T12:00:00.000Z')

    const writer = await startHeartbeatWriter({ db, now: () => boot })

    const insertCall = calls().find((c) =>
      c.sql.includes('daemon_heartbeat') && c.sql.includes('INSERT'),
    )
    expect(insertCall?.args[1]).toBe(boot.toISOString())
    writer.stop()
  })
})

describe('startHeartbeatWriter — interval ticks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.MARS_HEARTBEAT_MS
  })

  it('last_beat_ts advances between two writer ticks', async () => {
    process.env.MARS_HEARTBEAT_MS = '5000'

    const { db, calls } = makeStubDb()
    let currentTime = new Date('2026-01-01T00:00:00.000Z')
    const writer = await startHeartbeatWriter({ db, now: () => currentTime })

    // Advance clock to first tick and let the interval fire.
    currentTime = new Date('2026-01-01T00:00:05.000Z')
    vi.advanceTimersByTime(5000)
    // Flush the microtask queue so the void db.execute() promise is registered.
    await Promise.resolve()

    // Advance clock to second tick.
    currentTime = new Date('2026-01-01T00:00:10.000Z')
    vi.advanceTimersByTime(5000)
    await Promise.resolve()

    // Extract UPDATE calls (not the initial INSERT).
    const updateCalls = calls().filter((c) =>
      c.sql.includes('UPDATE daemon_heartbeat'),
    )
    expect(updateCalls).toHaveLength(2)
    expect(updateCalls[0].args[0]).toBe('2026-01-01T00:00:05.000Z')
    expect(updateCalls[1].args[0]).toBe('2026-01-01T00:00:10.000Z')
    // The two timestamps must differ — last_beat_ts advanced.
    expect(updateCalls[0].args[0]).not.toBe(updateCalls[1].args[0])

    writer.stop()
  })

  it('stop() cancels the interval so no further updates are written', async () => {
    process.env.MARS_HEARTBEAT_MS = '5000'
    const { db, calls } = makeStubDb()
    const writer = await startHeartbeatWriter({ db })

    writer.stop()

    vi.advanceTimersByTime(20_000) // 4 intervals
    await Promise.resolve()

    const updateCalls = calls().filter((c) =>
      c.sql.includes('UPDATE daemon_heartbeat'),
    )
    expect(updateCalls).toHaveLength(0)
  })

  it('respects MARS_HEARTBEAT_MS env var for the tick interval', async () => {
    process.env.MARS_HEARTBEAT_MS = '2000'
    const { db, calls } = makeStubDb()
    const writer = await startHeartbeatWriter({ db })

    vi.advanceTimersByTime(5999) // 2 full 2-second intervals but not a third
    await Promise.resolve()

    const updateCalls = calls().filter((c) =>
      c.sql.includes('UPDATE daemon_heartbeat'),
    )
    expect(updateCalls).toHaveLength(2)
    writer.stop()
  })

  it('does not emit an unhandled rejection when an interval write fails', async () => {
    process.env.MARS_HEARTBEAT_MS = '5000'
    const { db } = makeStubDb()
    vi.mocked(db.execute)
      .mockResolvedValueOnce({ rows: [], rowsAffected: 1 })
      .mockRejectedValueOnce(new Error('database is stopping'))
    const onUnhandledRejection = vi.fn()
    process.once('unhandledRejection', onUnhandledRejection)
    const writer = await startHeartbeatWriter({ db })
    try {
      await vi.advanceTimersByTimeAsync(5000)
      vi.useRealTimers()
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(onUnhandledRejection).not.toHaveBeenCalled()
    } finally {
      writer.stop()
      process.removeListener('unhandledRejection', onUnhandledRejection)
    }
  })
})
