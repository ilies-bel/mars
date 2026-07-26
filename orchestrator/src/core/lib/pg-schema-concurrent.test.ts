/**
 * Concurrency regression test for ensureSchema.
 *
 * Reproduced symptom: concurrent `ensureSchema` calls on separate connections
 * to the same embedded Postgres can deadlock because
 *
 *   1. `schemaReadyByClient` is keyed by DbClient *object*, so two distinct
 *      client instances to the same database each bootstrap independently —
 *      they rely entirely on the PostgreSQL advisory lock for serialisation.
 *   2. `ensureSchema(client)` called directly triggers `ensureClientSchema`
 *      inside `client.batch`, which runs the DDL in a first transaction (T1).
 *      After T1 commits the advisory lock is released.  The outer
 *      `client.batch` then runs the same DDL in a second transaction (T2).
 *      Between T1 and T2 the lock is not held, so another session can
 *      interleave DDL that creates the classic lock-ordering deadlock with
 *      concurrent DML from the running daemon.
 *
 * The test drives two independent `DbClient` objects at the same embedded
 * Postgres, holds the advisory lock from an outside session while both try to
 * bootstrap, then counts how many Postgres sessions are waiting for the lock:
 *
 *   - Before fix: 2  (each client has its own `ensureClientSchema` attempt)
 *   - After fix:  1  (per-target dedup → only one connection blocks;
 *                      the other awaits the JS promise, not the PG lock)
 *
 * Requires a reachable embedded Postgres (daemon running).  The test is
 * automatically skipped when `.mars/pg.dsn` is absent.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import {
  __createFreshClientForTests,
  __resetDbRegistryForTests,
} from './db.js'
import { SCHEMA_ADVISORY_LOCK_KEY } from './pg-schema.js'

// ── DSN resolution ───────────────────────────────────────────────────────────

function findRepoRoot(): string {
  // Walk up from the test file's __dirname until we find a .mars directory.
  // In CI / worktrees the repo root is a few levels up.
  let dir = new URL('.', import.meta.url).pathname
  for (let i = 0; i < 10; i++) {
    try {
      readFileSync(join(dir, '.mars/pg.dsn'))
      return dir
    } catch {
      dir = join(dir, '..')
    }
  }
  return ''
}

const repoRoot = findRepoRoot()
const dsnPath = join(repoRoot, '.mars/pg.dsn')
let embeddedDsn: string | null = null
try {
  embeddedDsn = readFileSync(dsnPath, 'utf8').trim()
} catch {
  // daemon not running — skip
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Count PG sessions blocked waiting for ANY advisory lock (granted = false). */
async function waitingForAdvisoryLock(pool: pg.Pool): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM pg_locks
     WHERE locktype = 'advisory'
       AND objid = $1
       AND granted = false`,
    [SCHEMA_ADVISORY_LOCK_KEY],
  )
  return Number(r.rows[0].n)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ── suite ────────────────────────────────────────────────────────────────────

describe.skipIf(!embeddedDsn)(
  'ensureSchema concurrency (embedded Postgres)',
  () => {
    // A shared pool used only for advisory-lock control and pg_locks queries.
    let controlPool: pg.Pool
    let controlConn: pg.PoolClient

    beforeAll(async () => {
      process.env.MARS_DB_BACKEND = 'embedded'
      controlPool = new pg.Pool({ connectionString: embeddedDsn!, max: 5 })
    })

    afterAll(async () => {
      await __resetDbRegistryForTests()
      process.env.MARS_DB_BACKEND = 'pglite'
      await controlPool.end()
    })

    it(
      'only one DB connection blocks on the advisory lock when two clients bootstrap the same target',
      async () => {
        // 1. Acquire the advisory lock from the control session so that both
        //    clients block when they try pg_advisory_xact_lock.
        controlConn = await controlPool.connect()
        await controlConn.query('BEGIN')
        await controlConn.query(
          'SELECT pg_advisory_xact_lock($1)',
          [SCHEMA_ADVISORY_LOCK_KEY],
        )

        // 2. Two independent client objects wired to the same Postgres.
        //    __createFreshClientForTests bypasses the openDb registry so each
        //    gets its own pool and its own schemaReadyByClient entry.
        const clientA = __createFreshClientForTests(embeddedDsn!)
        const clientB = __createFreshClientForTests(embeddedDsn!)

        // 3. Fire off schema bootstrap on both — both will block internally
        //    when they try to acquire pg_advisory_xact_lock.
        const taskA = clientA.execute('SELECT 1')
        const taskB = clientB.execute('SELECT 1')

        // 4. Wait long enough for both connections to have reached their lock
        //    acquisition attempt inside Postgres.
        await sleep(300)

        // 5. Count sessions blocked on the advisory lock.
        const blocked = await waitingForAdvisoryLock(controlPool)

        // 6. Release the external lock so the tasks can complete.
        await controlConn.query('ROLLBACK')
        controlConn.release()

        await Promise.all([taskA, taskB])
        await clientA.close()
        await clientB.close()

        // === The assertion ===
        //
        // BEFORE FIX: schemaReadyByClient is per-client, so both A and B each
        // open their own ensureClientSchema attempt, each establishing a DB
        // connection that tries pg_advisory_xact_lock.  blocked = 2.
        //
        // AFTER FIX: schemaReadyByTarget is per-target DSN.  The second
        // client's ensureClientSchema sees the promise already created by the
        // first and awaits it in JS — only ONE DB connection blocks.  blocked = 1.
        expect(blocked, 'expected exactly 1 DB session blocked on advisory lock').toBe(1)
      },
      10_000, // 10 s timeout
    )
  },
)
