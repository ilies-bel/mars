import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from '../core/lib/node-sqlite.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { __resetDbRegistryForTests, openDb, type DbClient } from '../core/lib/db.js'
import { ensureSchema } from '../core/lib/pg-schema.js'
import { IMPORT_MARKER_VERSION, importLegacySqlite } from './import-sqlite.js'

let keyCounter = 0
const freshKey = (): string => `import-sqlite-test-${process.pid}-${(keyCounter += 1)}`

const tempDirs: string[] = []
const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-import-sqlite-'))
  tempDirs.push(dir)
  return dir
}

beforeAll(() => {
  process.env.MARS_DB_BACKEND = 'pglite'
})

afterEach(async () => {
  await __resetDbRegistryForTests()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const NOW = '2026-07-20T12:00:00.000Z'
const TRANSCRIPT_BLOB = new Uint8Array([0x1f, 0x8b, 8, 0, 255, 1, 2, 3])

/** Builds a representative legacy mars.db fixture. Returns its path. */
const buildFixture = (dir: string): string => {
  const path = join(dir, 'mars.db')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      legacy_junk TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      ts INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE task_blockers (
      task_id TEXT NOT NULL,
      blocker_task_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'confirmed',
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, blocker_task_id)
    );
    CREATE TABLE task_durable_transcripts (
      task_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',
      step_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      transcript BLOB NOT NULL,
      byte_len INTEGER NOT NULL
    );
    CREATE TABLE legacy_only_table (id TEXT PRIMARY KEY);
  `)
  const insertTask = db.prepare(
    `INSERT INTO tasks (id, prompt, status, error, retry_count, legacy_junk, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  insertTask.run('t1', 'do the thing', 'done', null, 0, 'junk', NOW, NOW)
  insertTask.run('t2', 'blocked work', 'blocked', 'boom', 2, null, NOW, NOW)
  insertTask.run('t3', 'queued work', 'queued', null, 1, null, NOW, NOW)
  const insertEvent = db.prepare(
    `INSERT INTO events (id, type, payload, ts) VALUES (?, ?, ?, ?)`,
  )
  // Sparse AUTOINCREMENT ids — the sequence must advance past max(id).
  insertEvent.run(1, 'task.created', '{}', 1_700_000_001)
  insertEvent.run(5, 'task.done', '{}', 1_700_000_002)
  insertEvent.run(9, 'task.failed', '{"taskId":"t2"}', 1_700_000_003)
  db.prepare(
    `INSERT INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)`,
  ).run('t3', 't2', NOW)
  db.prepare(
    `INSERT INTO task_durable_transcripts (task_id, created_at, transcript, byte_len)
     VALUES (?, ?, ?, ?)`,
  ).run('t1', NOW, TRANSCRIPT_BLOB, TRANSCRIPT_BLOB.byteLength)
  db.close()
  return path
}

const freshPgClient = async (): Promise<DbClient> => {
  const c = openDb(freshKey())
  await ensureSchema(c)
  return c
}

describe('importLegacySqlite', () => {
  it('returns no-sqlite when the file does not exist', async () => {
    const client = await freshPgClient()
    const result = await importLegacySqlite({
      sqlitePath: join(makeTempDir(), 'mars.db'),
      client,
    })
    expect(result).toEqual({ status: 'no-sqlite' })
  })

  it('copies rows, preserves ids/NULLs/BLOBs, advances sequences, renames the file', async () => {
    const dir = makeTempDir()
    const sqlitePath = buildFixture(dir)
    const client = await freshPgClient()

    const result = await importLegacySqlite({ sqlitePath, client })
    expect(result.status).toBe('imported')
    if (result.status !== 'imported') return

    expect(result.tables).toMatchObject({
      tasks: 3,
      events: 3,
      task_blockers: 1,
      task_durable_transcripts: 1,
    })
    expect(result.skippedTables).toEqual(['legacy_only_table'])
    expect(result.droppedColumns).toEqual({ tasks: ['legacy_junk'] })

    // Row content survives, including NULLs and PG defaults for absent columns.
    const t2 = await client.execute(
      `SELECT prompt, status, error, retry_count, priority, intent FROM tasks WHERE id = 't2'`,
    )
    expect(t2.rows[0]).toEqual({
      prompt: 'blocked work',
      status: 'blocked',
      error: 'boom',
      retry_count: 2,
      priority: 0, // PG column absent from the fixture → schema default
      intent: '',
    })
    const t1 = await client.execute(`SELECT error FROM tasks WHERE id = 't1'`)
    expect(t1.rows[0].error).toBeNull()

    // Identity ids preserved verbatim; sequence advanced past max(id).
    const events = await client.execute(`SELECT id FROM events ORDER BY id`)
    expect(events.rows.map((r) => r.id)).toEqual([1, 5, 9])
    const next = await client.execute(
      `INSERT INTO events (type, payload) VALUES ('post-import', '{}') RETURNING id`,
    )
    expect(next.rows[0].id).toBe(10)

    // BLOB → bytea round-trip, byte-exact.
    const transcript = await client.execute(
      `SELECT transcript FROM task_durable_transcripts WHERE task_id = 't1'`,
    )
    expect(Array.from(transcript.rows[0].transcript as Uint8Array)).toEqual(
      Array.from(TRANSCRIPT_BLOB),
    )
    const transcriptTimestamp = await client.execute(
      `SELECT created_at FROM task_durable_transcripts WHERE task_id = 't1'`,
    )
    expect(transcriptTimestamp.rows[0].created_at).toBe(Date.parse(NOW))

    // Import marker recorded.
    const marker = await client.execute(
      `SELECT 1 FROM schema_migrations WHERE version = ?`,
      [IMPORT_MARKER_VERSION],
    )
    expect(marker.rows.length).toBe(1)

    // File renamed to mars.db.bak-<unix-ts>.
    expect(existsSync(sqlitePath)).toBe(false)
    expect(result.renamedTo).toMatch(/mars\.db\.bak-\d{10}$/)
    expect(existsSync(result.renamedTo)).toBe(true)
    expect(readdirSync(dir).filter((f) => f.startsWith('mars.db'))).toHaveLength(1)
  })

  it('copies in batches larger than one INSERT chunk', async () => {
    const dir = makeTempDir()
    const path = join(dir, 'mars.db')
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE signals (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL,
      recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`)
    const insert = db.prepare(
      `INSERT INTO signals (id, task_id, kind, recorded_at) VALUES (?, ?, ?, ?)`,
    )
    for (let i = 0; i < 1203; i += 1) {
      insert.run(`s${i}`, `t${i % 7}`, 'usage', 1_700_000_000 + i)
    }
    db.close()

    const client = await freshPgClient()
    const result = await importLegacySqlite({ sqlitePath: path, client })
    expect(result.status).toBe('imported')
    const count = await client.execute(`SELECT count(*) AS n FROM signals`)
    expect(count.rows[0].n).toBe(1203)
  })

  it('is a no-op when the import marker is already present', async () => {
    const dir = makeTempDir()
    const sqlitePath = buildFixture(dir)
    const client = await freshPgClient()
    await client.execute(
      `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
      [IMPORT_MARKER_VERSION, NOW],
    )
    const result = await importLegacySqlite({ sqlitePath, client })
    expect(result).toEqual({ status: 'skipped', reason: 'already-imported' })
    // File untouched, nothing copied.
    expect(existsSync(sqlitePath)).toBe(true)
    const count = await client.execute(`SELECT count(*) AS n FROM tasks`)
    expect(count.rows[0].n).toBe(0)
  })

  it('is a no-op when PG already has task data', async () => {
    const dir = makeTempDir()
    const sqlitePath = buildFixture(dir)
    const client = await freshPgClient()
    await client.execute(
      `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
       VALUES ('existing', 'p', 'queued', ?, ?)`,
      [NOW, NOW],
    )
    const result = await importLegacySqlite({ sqlitePath, client })
    expect(result).toEqual({ status: 'skipped', reason: 'pg-has-data' })
    expect(existsSync(sqlitePath)).toBe(true)
  })

  it('renames -wal and -shm siblings alongside the main file', async () => {
    const dir = makeTempDir()
    const path = join(dir, 'mars.db')
    const db = new DatabaseSync(path)
    db.exec(`PRAGMA journal_mode = WAL`)
    db.exec(`CREATE TABLE preferences (name TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    db.prepare(`INSERT INTO preferences (name, value) VALUES (?, ?)`).run('a', '1')
    // Keep a second connection open so the -wal/-shm files survive the
    // writer's close (a lone connection checkpoints and removes them).
    const holdOpen = new DatabaseSync(path, { readOnly: true })
    holdOpen.prepare('SELECT 1').get()
    db.close()
    expect(existsSync(`${path}-wal`)).toBe(true)

    const client = await freshPgClient()
    const result = await importLegacySqlite({ sqlitePath: path, client })
    holdOpen.close()
    expect(result.status).toBe('imported')
    if (result.status !== 'imported') return
    const count = await client.execute(`SELECT count(*) AS n FROM preferences`)
    expect(count.rows[0].n).toBe(1)
    expect(existsSync(`${path}-wal`)).toBe(false)
    expect(existsSync(`${result.renamedTo}-wal`)).toBe(true)
  })
})
