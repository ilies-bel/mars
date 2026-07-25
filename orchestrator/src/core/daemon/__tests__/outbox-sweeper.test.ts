/**
 * Outbox sweeper — behaviour tests.
 *
 * Tests drive `sweepOutbox` through its public interface and assert on
 * observable side-effects (action_queue_items rows). Module caches are reset
 * before each test so the `stateClient()` singleton (used by
 * `raiseActionQueueItem`) opens the fresh test DB every time.
 *
 * dbPath must match resolveDbTarget() — both are stateDir (tmpDir/.mars) so
 * lag detection, pruning, and raiseActionQueueItem all hit the same PGlite
 * instance. The client is imported dynamically AFTER vi.resetModules() so the
 * test and sweeper share the same db.ts module (and thus the same registry).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DbClient } from '../../lib/db.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function setupRepo(): string {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-outbox-sweeper-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/** Count open action-queue rows. */
async function openRowCount(client: DbClient): Promise<number> {
  const r = await client.execute(
    `SELECT COUNT(*) AS n FROM action_queue_items WHERE state = 'open'`,
  )
  return Number((r.rows[0] as unknown as { n: number | bigint }).n)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sweepOutbox', () => {
  let tmpDir: string
  let dbPath: string
  let client: DbClient
  let sweepOutbox: (dbPath: string) => Promise<void>

  beforeEach(async () => {
    tmpDir = setupRepo()
    // dbPath must match resolveDbTarget() so lag-detection and raiseActionQueueItem
    // both open the same PGlite instance. resolveDbTarget() returns stateDir
    // (tmpDir/.mars) when MARS_DB_BACKEND=pglite.
    dbPath = resolve(tmpDir, '.mars')

    // Set MARS_REPO before resetting modules so resolveStateClient()
    // (used by raiseActionQueueItem) opens the correct test DB.
    process.env.MARS_REPO = tmpDir

    // Reset all module-level singletons (stateClient, initialised flag, etc.)
    // so each test gets a clean environment pointed at the fresh tmpDir.
    vi.resetModules()

    // Import db module AFTER resetModules so the client and sweeper share
    // the same db.ts module instance (and thus the same PGlite registry).
    // ensureClientSchema runs automatically on first execute().
    const { openDb } = await import('../../lib/db.js')
    client = openDb(dbPath)

    // Dynamic import AFTER resetModules so the sweeper and raiseActionQueueItem
    // also resolve through the same fresh db.ts module.
    const mod = await import('../outbox-sweeper.js')
    sweepOutbox = mod.sweepOutbox
  })

  afterEach(async () => {
    await client.close()
    delete process.env.MARS_REPO
    delete process.env.MARS_OUTBOX_LAG_WARN_THRESHOLD
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Criterion: lag below threshold raises no item ──────────────────────

  it('raises no action-queue item when lag is below the default threshold', async () => {
    // MAX(events.id)=50001, MIN(subscribers.cursor)=1 → lag=50000 < 100000
    // OVERRIDING SYSTEM VALUE is required because events.id is GENERATED ALWAYS AS IDENTITY.
    await client.execute({
      sql: 'INSERT INTO events (id, type, payload, ts) OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, ?)',
      args: [50001, 'test', '{}', 0],
    })
    await client.execute({
      sql: 'INSERT INTO subscribers (name, cursor) VALUES (?, ?)',
      args: ['writer', 1],
    })

    await sweepOutbox(dbPath)

    expect(await openRowCount(client)).toBe(0)
  })

  // ── Criterion: lag above threshold + idempotency ───────────────────────

  it('raises exactly one action-queue row across two sweeps for a wedged subscriber', async () => {
    // MAX(events.id)=150001, MIN(subscribers.cursor)=1 → lag=150000 > 100000
    // OVERRIDING SYSTEM VALUE is required because events.id is GENERATED ALWAYS AS IDENTITY.
    await client.execute({
      sql: 'INSERT INTO events (id, type, payload, ts) OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, ?)',
      args: [150001, 'test', '{}', 0],
    })
    await client.execute({
      sql: 'INSERT INTO subscribers (name, cursor) VALUES (?, ?)',
      args: ['writer', 1],
    })

    // First sweep: raises the item.
    await sweepOutbox(dbPath)
    // Second sweep: same wedged subscriber, unresolved item → deduped.
    await sweepOutbox(dbPath)

    const rows = await client.execute(
      `SELECT signature, seen_count FROM action_queue_items WHERE state = 'open'`,
    )
    expect(rows.rows).toHaveLength(1)
    const row = rows.rows[0] as unknown as {
      signature: string
      seen_count: number | bigint
    }
    expect(row.signature).toBe('outbox-lag:writer')
    // Second sweep bumped seen_count rather than inserting a duplicate.
    expect(Number(row.seen_count)).toBe(2)
  })

  // ── Criterion: MARS_OUTBOX_LAG_WARN_THRESHOLD env override ────────────

  it('respects MARS_OUTBOX_LAG_WARN_THRESHOLD env and triggers at lag=20 with threshold=10', async () => {
    process.env.MARS_OUTBOX_LAG_WARN_THRESHOLD = '10'

    // MAX(events.id)=21, MIN(subscribers.cursor)=1 → lag=20 > 10
    // OVERRIDING SYSTEM VALUE is required because events.id is GENERATED ALWAYS AS IDENTITY.
    await client.execute({
      sql: 'INSERT INTO events (id, type, payload, ts) OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, ?)',
      args: [21, 'test', '{}', 0],
    })
    await client.execute({
      sql: 'INSERT INTO subscribers (name, cursor) VALUES (?, ?)',
      args: ['writer', 1],
    })

    await sweepOutbox(dbPath)

    const rows = await client.execute(
      `SELECT signature FROM action_queue_items WHERE state = 'open'`,
    )
    expect(rows.rows).toHaveLength(1)
    expect(
      (rows.rows[0] as unknown as { signature: string }).signature,
    ).toBe('outbox-lag:writer')
  })
})
