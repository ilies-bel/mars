/**
 * Outbox sweeper — behaviour tests.
 *
 * Tests drive `sweepOutbox` through its public interface and assert on
 * observable side-effects (action_queue_items rows). Module caches are reset
 * before each test so the `stateClient()` singleton (used by
 * `raiseActionQueueItem`) opens the fresh test DB every time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createClient, type Client } from '@libsql/client'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function setupRepo(): string {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-outbox-sweeper-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * Create all tables the sweeper and its collaborators need:
 *  - `events` and `subscribers` (lag detection + pruning)
 *  - `action_queue_items` and `action_queue_history` (raised items)
 *
 * Creating them here before the dynamic import means `initActionQueue()`
 * (called by `raiseActionQueueItem`) will find them already in place and
 * skip the ALTER TABLE migrations that would otherwise conflict.
 */
async function makeClient(dbPath: string): Promise<Client> {
  const client = createClient({ url: `file:${dbPath}` })

  await client.execute(`
    CREATE TABLE IF NOT EXISTS events (
      id      INTEGER PRIMARY KEY,
      type    TEXT    NOT NULL DEFAULT 'test',
      payload TEXT    NOT NULL DEFAULT '{}',
      ts      INTEGER NOT NULL DEFAULT 0
    )
  `)

  await client.execute(`
    CREATE TABLE IF NOT EXISTS subscribers (
      name   TEXT    PRIMARY KEY,
      cursor INTEGER NOT NULL DEFAULT 0
    )
  `)

  // Pre-create action-queue tables with all columns so initActionQueue()
  // skips the ALTER TABLE steps (which would fail if columns already exist).
  await client.execute(`
    CREATE TABLE IF NOT EXISTS action_queue_items (
      id              TEXT    PRIMARY KEY,
      kind            TEXT    NOT NULL,
      category        TEXT    NOT NULL,
      priority        TEXT    NOT NULL,
      state           TEXT    NOT NULL DEFAULT 'open',
      title           TEXT    NOT NULL,
      body            TEXT    NOT NULL DEFAULT '',
      payload         TEXT    NOT NULL DEFAULT '{}',
      context         TEXT    NOT NULL DEFAULT '{}',
      raised_by       TEXT    NOT NULL,
      raised_at       TEXT    NOT NULL,
      resolved_at     TEXT,
      resolution      TEXT,
      resolution_note TEXT,
      root_cause      TEXT,
      fingerprint     TEXT,
      signature       TEXT,
      seen_count      INTEGER NOT NULL DEFAULT 1,
      last_seen_at    TEXT,
      resolved_by     TEXT,
      origin_task_id  TEXT
    )
  `)

  await client.execute(`
    CREATE TABLE IF NOT EXISTS action_queue_history (
      id         TEXT PRIMARY KEY,
      item_id    TEXT NOT NULL,
      at         TEXT NOT NULL,
      from_state TEXT,
      to_state   TEXT NOT NULL,
      by         TEXT,
      note       TEXT
    )
  `)

  return client
}

/** Count open action-queue rows. */
async function openRowCount(client: Client): Promise<number> {
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
  let client: Client
  let sweepOutbox: (dbPath: string) => Promise<void>

  beforeEach(async () => {
    tmpDir = setupRepo()
    dbPath = resolve(tmpDir, '.mars', 'mars.db')

    // Set MARS_REPO before resetting modules so resolveStateClient()
    // (used by raiseActionQueueItem) opens the correct test DB.
    process.env.MARS_REPO = tmpDir

    // Reset all module-level singletons (stateClient, initialised flag, etc.)
    // so each test gets a clean environment pointed at the fresh tmpDir.
    vi.resetModules()

    // Create tables before the dynamic import so initActionQueue() finds
    // action_queue_items already fully-migrated.
    client = await makeClient(dbPath)

    // Dynamic import AFTER resetModules and DB setup.
    const mod = await import('../outbox-sweeper.js')
    sweepOutbox = mod.sweepOutbox
  })

  afterEach(() => {
    client.close()
    delete process.env.MARS_REPO
    delete process.env.MARS_OUTBOX_LAG_WARN_THRESHOLD
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Criterion: lag below threshold raises no item ──────────────────────

  it('raises no action-queue item when lag is below the default threshold', async () => {
    // MAX(events.id)=50001, MIN(subscribers.cursor)=1 → lag=50000 < 100000
    await client.execute({
      sql: 'INSERT INTO events (id, ts) VALUES (?, ?)',
      args: [50001, 0],
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
    await client.execute({
      sql: 'INSERT INTO events (id, ts) VALUES (?, ?)',
      args: [150001, 0],
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
    await client.execute({
      sql: 'INSERT INTO events (id, ts) VALUES (?, ?)',
      args: [21, 0],
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
