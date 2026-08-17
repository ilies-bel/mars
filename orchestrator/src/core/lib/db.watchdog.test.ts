/**
 * Unit tests for the PGlite operation watchdog added to makePgliteBackend.
 *
 * PGlite is mocked so its `query` method returns a promise that never settles
 * (simulating a wedged in-process engine).  The test then advances the fake
 * clock past the configured threshold and verifies that the pending client
 * operation rejects with a diagnostic error naming the SQL.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Must be hoisted above the db.ts import so the module receives the mock.
vi.mock('@electric-sql/pglite', () => ({
  PGlite: vi.fn().mockImplementation(() => ({
    /** Never resolves — simulates a completely wedged PGlite instance. */
    query: () => new Promise<never>(() => undefined),
    close: () => Promise.resolve(),
  })),
}))

import { __resetDbRegistryForTests, markSchemaReady, openDb } from './db.js'

/** Short watchdog for tests — long enough to let microtasks drain, short
 *  enough to not slow the suite.  Controlled via the same env var as
 *  production so no extra API is needed. */
const WATCHDOG_MS = 100

let keyCounter = 0
const freshKey = () => `watchdog-test-${process.pid}-${(keyCounter += 1)}`

beforeAll(() => {
  process.env.MARS_DB_BACKEND = 'pglite'
  process.env.PGLITE_QUERY_TIMEOUT_MS = String(WATCHDOG_MS)
})

afterEach(async () => {
  vi.useRealTimers()
  await __resetDbRegistryForTests()
})

describe('PGlite operation watchdog', () => {
  it('rejects a hanging query with a diagnostic that names the SQL', async () => {
    vi.useFakeTimers()

    const client = openDb(freshKey())
    // Skip schema bootstrap so the first operation is exactly the SQL below.
    markSchemaReady(client)

    const sql = 'SELECT watchdog_test_sentinel'
    const pending = client.execute(sql)
    // Suppress the "unhandled rejection" signal that would fire during
    // fake-timer advancement (before the expect() below gets to handle it).
    // The no-op catch does not consume the rejection — `pending` still
    // rejects for the assertions below.
    void pending.catch(() => undefined)

    // Advance past the watchdog threshold so the timer fires.
    await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 50)

    await expect(pending).rejects.toThrow(/watchdog/i)
    await expect(pending).rejects.toThrow(sql)
    await expect(pending).rejects.toThrow(`${WATCHDOG_MS / 1000}s`)
  })

  it('rejects a hanging transaction with a diagnostic labelled "transaction"', async () => {
    vi.useFakeTimers()

    const client = openDb(freshKey())
    markSchemaReady(client)

    // batch() runs everything in a transaction via backend.transaction().
    const pending = client.batch(['SELECT 1'])
    void pending.catch(() => undefined)

    await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 50)

    await expect(pending).rejects.toThrow(/watchdog/i)
    await expect(pending).rejects.toThrow(/transaction/)
    await expect(pending).rejects.toThrow(`${WATCHDOG_MS / 1000}s`)
  })

  it('resolves normally when the operation completes before the threshold', async () => {
    // Override the module-level "always hang" mock for this one call so the
    // query returns immediately.  vi.mocked gives us the typed Mock interface.
    const { PGlite } = await import('@electric-sql/pglite')
    vi.mocked(PGlite).mockImplementationOnce(
      () =>
        ({
          query: () =>
            Promise.resolve({ rows: [{ one: 1 }], affectedRows: 0, fields: [] }),
          close: () => Promise.resolve(),
        }) as unknown as InstanceType<typeof PGlite>,
    )

    const client = openDb(freshKey())
    markSchemaReady(client)

    // Should resolve without needing fake timers to advance.
    await expect(client.execute('SELECT 1 AS one')).resolves.toBeDefined()
  })
})
