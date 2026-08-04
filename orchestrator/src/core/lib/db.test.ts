import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  __resetDbRegistryForTests,
  __truncateAllForTests,
  openDb,
  translatePlaceholders,
  withTransaction,
  type DbClient,
} from './db.js'

// Unique target keys per test so state never leaks between cases even before
// the afterEach reset runs.
let keyCounter = 0
const freshKey = (): string => `db-test-${process.pid}-${(keyCounter += 1)}`

beforeAll(() => {
  process.env.MARS_DB_BACKEND = 'pglite'
})

afterEach(async () => {
  await __resetDbRegistryForTests()
})

describe('translatePlaceholders', () => {
  it('numbers placeholders left to right', () => {
    expect(translatePlaceholders('SELECT * FROM t WHERE a = ? AND b = ?')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2',
    )
  })

  it('leaves SQL without placeholders untouched', () => {
    const sql = "SELECT 1, 'a', \"col\" FROM t"
    expect(translatePlaceholders(sql)).toBe(sql)
  })

  it('skips ? inside single-quoted strings, including escaped quotes', () => {
    expect(
      translatePlaceholders("SELECT '?' , 'it''s a ?' , ? FROM t WHERE x = ?"),
    ).toBe("SELECT '?' , 'it''s a ?' , $1 FROM t WHERE x = $2")
  })

  it('skips ? inside double-quoted identifiers', () => {
    expect(translatePlaceholders('SELECT "weird?col" FROM t WHERE a = ?')).toBe(
      'SELECT "weird?col" FROM t WHERE a = $1',
    )
  })

  it('skips ? inside line and block comments', () => {
    expect(
      translatePlaceholders('SELECT ? -- what?\n , ? /* really? */ FROM t'),
    ).toBe('SELECT $1 -- what?\n , $2 /* really? */ FROM t')
  })

  it('skips ? inside dollar-quoted strings', () => {
    expect(translatePlaceholders('SELECT $$is this a ?$$, ?')).toBe(
      'SELECT $$is this a ?$$, $1',
    )
  })

  it('handles id-prefix LIKE concat (the queue idiom)', () => {
    expect(translatePlaceholders("SELECT id FROM tasks WHERE id LIKE ? || '%'")).toBe(
      "SELECT id FROM tasks WHERE id LIKE $1 || '%'",
    )
  })
})

// Use 'test_tasks' (not 'tasks') to avoid colliding with the production schema
// that ensureClientSchema applies automatically before the first execute().
// The production schema creates 'tasks' via CREATE TABLE IF NOT EXISTS, so a
// bare CREATE TABLE tasks here would fail with "relation already exists".
const makeTestTasksTable = async (c: DbClient): Promise<void> => {
  await c.execute(
    'CREATE TABLE test_tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0)',
  )
}

describe('execute (pglite backend)', () => {
  it('names the timestamp column when a fixture uses an ISO string for epoch milliseconds', async () => {
    const c = openDb(freshKey())
    const createdAt = new Date().toISOString()
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES (?, ?, 'queued', ?, ?), (?, ?, 'queued', ?, ?)`,
      args: ['dependent', 'dependent task', createdAt, createdAt, 'blocker', 'blocker task', createdAt, createdAt],
    })

    await expect(c.execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, created_at)
            VALUES (?, ?, ?)`,
      args: ['dependent', 'blocker', createdAt],
    })).rejects.toThrow('task_blockers.created_at expects epoch milliseconds')
  })

  it('names the timestamp column when a fixture leaves a native timestamp blank', async () => {
    const c = openDb(freshKey())

    await expect(c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES (?, ?, 'queued', ?, ?)`,
      args: ['blank-time', 'task with an invalid time', '', new Date().toISOString()],
    })).rejects.toThrow('tasks.created_at expects an ISO-8601 timestamp')
  })

  it('attaches SQL and arguments to PGlite errors', async () => {
    const c = openDb(freshKey())

    await expect(c.execute(
      'SELECT * FROM missing_fixture_table WHERE id = ?',
      ['missing-fixture'],
    )).rejects.toThrow(/SQL: SELECT \* FROM missing_fixture_table WHERE id = \$1\nargs: \["missing-fixture"\]/)
  })

  it('returns rows as objects keyed by column name', async () => {
    const c = openDb(freshKey())
    await makeTestTasksTable(c)
    await c.execute('INSERT INTO test_tasks (id, status) VALUES (?, ?)', ['t1', 'queued'])
    const r = await c.execute('SELECT id, status, retry_count FROM test_tasks WHERE id = ?', ['t1'])
    expect(r.rows).toEqual([{ id: 't1', status: 'queued', retry_count: 0 }])
  })

  it('accepts the {sql, args} statement-object shape', async () => {
    const c = openDb(freshKey())
    await makeTestTasksTable(c)
    await c.execute({
      sql: 'INSERT INTO test_tasks (id, status) VALUES (?, ?)',
      args: ['t2', 'running'],
    })
    const r = await c.execute({ sql: 'SELECT status FROM test_tasks WHERE id = ?', args: ['t2'] })
    expect(r.rows[0]?.['status']).toBe('running')
  })

  it('reports rowsAffected for DML and 0 for SELECT', async () => {
    const c = openDb(freshKey())
    await makeTestTasksTable(c)
    await c.execute('INSERT INTO test_tasks (id, status) VALUES (?, ?), (?, ?)', [
      'a', 'queued', 'b', 'queued',
    ])
    const upd = await c.execute("UPDATE test_tasks SET status = 'done' WHERE status = ?", ['queued'])
    expect(upd.rowsAffected).toBe(2)
    const sel = await c.execute('SELECT * FROM test_tasks')
    expect(sel.rowsAffected).toBe(0)
    const del = await c.execute('DELETE FROM test_tasks WHERE id = ?', ['a'])
    expect(del.rowsAffected).toBe(1)
    const noop = await c.execute('DELETE FROM test_tasks WHERE id = ?', ['missing'])
    expect(noop.rowsAffected).toBe(0)
  })

  it('supports INSERT ... RETURNING id (the lastInsertRowid replacement)', async () => {
    const c = openDb(freshKey())
    // Use 'test_events' (not 'events') — production schema owns 'events'.
    await c.execute(
      'CREATE TABLE test_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, type TEXT)',
    )
    const r = await c.execute('INSERT INTO test_events (type) VALUES (?) RETURNING id', ['x'])
    expect(r.rows[0]?.['id']).toBe(1)
    expect(typeof r.rows[0]?.['id']).toBe('number')
  })

  it('returns int8 aggregates and columns as JS numbers', async () => {
    const c = openDb(freshKey())
    await makeTestTasksTable(c)
    await c.execute('INSERT INTO test_tasks (id, status) VALUES (?, ?)', ['t1', 'queued'])
    const count = await c.execute('SELECT COUNT(*) AS cnt FROM test_tasks')
    expect(count.rows[0]?.['cnt']).toBe(1)
    const big = await c.execute('SELECT 9007199254740::int8 AS v, 1.5::numeric AS n')
    expect(big.rows[0]?.['v']).toBe(9007199254740)
    expect(big.rows[0]?.['n']).toBe(1.5)
  })

  it('round-trips bytea as Uint8Array and 0/1 integers as numbers', async () => {
    const c = openDb(freshKey())
    await c.execute('CREATE TABLE blobs (id TEXT PRIMARY KEY, body bytea, flag INTEGER)')
    const payload = new Uint8Array([0, 1, 2, 255, 128, 7])
    await c.execute('INSERT INTO blobs (id, body, flag) VALUES (?, ?, ?)', [
      'b1', payload, true,
    ])
    const r = await c.execute('SELECT body, flag FROM blobs WHERE id = ?', ['b1'])
    const body = r.rows[0]?.['body']
    expect(body).toBeInstanceOf(Uint8Array)
    expect(Array.from(body as Uint8Array)).toEqual([0, 1, 2, 255, 128, 7])
    // INTEGER 0/1 flags stay numbers — no boolean coercion on the way out.
    expect(r.rows[0]?.['flag']).toBe(1)
  })
})

describe('withTransaction', () => {
  it('commits when the callback resolves', async () => {
    const c = openDb(freshKey())
    await makeTestTasksTable(c)
    const out = await withTransaction(c, async (tx) => {
      await tx.execute('INSERT INTO test_tasks (id, status) VALUES (?, ?)', ['t1', 'queued'])
      await tx.execute("UPDATE test_tasks SET status = 'running' WHERE id = ?", ['t1'])
      return 'ok'
    })
    expect(out).toBe('ok')
    const r = await c.execute('SELECT status FROM test_tasks WHERE id = ?', ['t1'])
    expect(r.rows[0]?.['status']).toBe('running')
  })

  it('rolls back everything and rethrows the original error', async () => {
    const c = openDb(freshKey())
    await makeTestTasksTable(c)
    await expect(
      withTransaction(c, async (tx) => {
        await tx.execute('INSERT INTO test_tasks (id, status) VALUES (?, ?)', ['t1', 'queued'])
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    const r = await c.execute('SELECT COUNT(*) AS cnt FROM test_tasks')
    expect(r.rows[0]?.['cnt']).toBe(0)
  })

  it('serializes concurrent transactions (no interleaving on the single session)', async () => {
    const c = openDb(freshKey())
    await c.execute('CREATE TABLE counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)')
    await c.execute('INSERT INTO counter (id, n) VALUES (1, 0)')
    // Read-modify-write with an await gap: interleaving would lose an update.
    const bump = () =>
      withTransaction(c, async (tx) => {
        const r = await tx.execute('SELECT n FROM counter WHERE id = 1')
        const n = r.rows[0]?.['n'] as number
        await new Promise((resolve) => setTimeout(resolve, 5))
        await tx.execute('UPDATE counter SET n = ? WHERE id = 1', [n + 1])
      })
    await Promise.all([bump(), bump(), bump()])
    const r = await c.execute('SELECT n FROM counter WHERE id = 1')
    expect(r.rows[0]?.['n']).toBe(3)
  })

  it('keeps a concurrent plain execute out of an open transaction', async () => {
    const c = openDb(freshKey())
    await makeTestTasksTable(c)
    const tx = withTransaction(c, async (t) => {
      await t.execute('INSERT INTO test_tasks (id, status) VALUES (?, ?)', ['inside', 'queued'])
      await new Promise((resolve) => setTimeout(resolve, 10))
      throw new Error('abort')
    })
    // Issued while the transaction above is still open; must serialize AFTER
    // its rollback, not join it (and so must survive the rollback).
    const outside = c.execute('INSERT INTO test_tasks (id, status) VALUES (?, ?)', [
      'outside', 'queued',
    ])
    await expect(tx).rejects.toThrow('abort')
    await outside
    const r = await c.execute('SELECT id FROM test_tasks ORDER BY id')
    expect(r.rows).toEqual([{ id: 'outside' }])
  })

  it('recovers after a failed transaction (mutex chain does not wedge)', async () => {
    const c = openDb(freshKey())
    await makeTestTasksTable(c)
    await expect(
      withTransaction(c, async (tx) => {
        await tx.execute('INSERT INTO nonexistent_table VALUES (1)')
      }),
    ).rejects.toThrow()
    const r = await c.execute('SELECT 1 AS one')
    expect(r.rows[0]?.['one']).toBe(1)
  })
})

describe('batch', () => {
  it('executes statements in order and returns one result set per statement', async () => {
    const c = openDb(freshKey())
    await makeTestTasksTable(c)
    const results = await c.batch(
      [
        { sql: 'INSERT INTO test_tasks (id, status) VALUES (?, ?)', args: ['a', 'queued'] },
        { sql: 'INSERT INTO test_tasks (id, status) VALUES (?, ?)', args: ['b', 'queued'] },
        { sql: 'SELECT COUNT(*) AS cnt FROM test_tasks', args: [] },
      ],
      'write',
    )
    expect(results).toHaveLength(3)
    expect(results[0]?.rowsAffected).toBe(1)
    expect(results[2]?.rows[0]?.['cnt']).toBe(2)
  })

  it('is atomic: a failing statement rolls back the whole batch', async () => {
    const c = openDb(freshKey())
    await makeTestTasksTable(c)
    await expect(
      c.batch(
        [
          { sql: 'INSERT INTO test_tasks (id, status) VALUES (?, ?)', args: ['a', 'queued'] },
          { sql: 'INSERT INTO test_tasks (id, status) VALUES (?, ?)', args: ['a', 'dup-pk'] },
        ],
        'write',
      ),
    ).rejects.toThrow()
    const r = await c.execute('SELECT COUNT(*) AS cnt FROM test_tasks')
    expect(r.rows[0]?.['cnt']).toBe(0)
  })

  it('accepts bare-string statements and the read mode flag', async () => {
    const c = openDb(freshKey())
    await makeTestTasksTable(c)
    const [r] = await c.batch(['SELECT COUNT(*) AS cnt FROM test_tasks'], 'read')
    expect(r?.rows[0]?.['cnt']).toBe(0)
  })
})

describe('registry', () => {
  it('closes an unused client without starting a database', async () => {
    const key = freshKey()
    const client = openDb(key)

    await client.close()

    expect(openDb(key)).not.toBe(client)
  })

  it('returns the same client object for the same target', async () => {
    const key = freshKey()
    const a = openDb(key)
    const b = openDb(key)
    expect(a).toBe(b)
    await a.execute('CREATE TABLE shared (id INTEGER)')
    await b.execute('INSERT INTO shared (id) VALUES (1)')
    const r = await a.execute('SELECT COUNT(*) AS cnt FROM shared')
    expect(r.rows[0]?.['cnt']).toBe(1)
  })

  it('gives different targets isolated databases', async () => {
    const a = openDb(freshKey())
    const b = openDb(freshKey())
    expect(a).not.toBe(b)
    await a.execute('CREATE TABLE only_in_a (id INTEGER)')
    await expect(b.execute('SELECT * FROM only_in_a')).rejects.toThrow()
  })

  it('close() is reference-counted: one handle closing does not kill the shared client', async () => {
    const key = freshKey()
    const a = openDb(key)
    const b = openDb(key) // second open on the same target: refs = 2
    await a.execute('CREATE TABLE t (id INTEGER)')
    await a.close() // refs 2 → 1; backend stays alive
    await b.execute('INSERT INTO t (id) VALUES (1)')
    const r = await b.execute('SELECT COUNT(*) AS cnt FROM t')
    expect(r.rows[0]?.['cnt']).toBe(1)
    await b.close() // refs 1 → 0; backend actually closes
    expect(openDb(key)).not.toBe(b)
  })

  it('__resetDbRegistryForTests yields a fresh database for a reused key', async () => {
    const key = freshKey()
    const a = openDb(key)
    await a.execute('CREATE TABLE persists_maybe (id INTEGER)')
    await __resetDbRegistryForTests()
    const b = openDb(key)
    expect(b).not.toBe(a)
    await expect(b.execute('SELECT * FROM persists_maybe')).rejects.toThrow()
  })

  it('__truncateAllForTests clears application rows and restores schema-owned rows', async () => {
    const c = openDb(freshKey())
    await c.execute({
      sql: `INSERT INTO chat_threads (id, title, created_at, updated_at)
            VALUES ('test-thread', 'Temporary', 1, 1)`,
    })
    await c.execute("INSERT INTO events (type, payload) VALUES ('test', '{}')")

    await __truncateAllForTests(c)

    expect((await c.execute('SELECT id FROM chat_threads ORDER BY id')).rows)
      .toEqual([{ id: 'main' }])
    expect((await c.execute('SELECT version FROM schema_migrations')).rows)
      .toHaveLength(1)
    await c.execute("INSERT INTO events (type, payload) VALUES ('test', '{}')")
    expect((await c.execute('SELECT id FROM events')).rows).toEqual([{ id: 1 }])
  })
})

describe('backend selection', () => {
  it('rejects a non-DSN target on the embedded backend', () => {
    process.env.MARS_DB_BACKEND = 'embedded'
    try {
      expect(() => openDb('file:/tmp/mars.db')).toThrow(/postgres:\/\/ DSN/)
    } finally {
      process.env.MARS_DB_BACKEND = 'pglite'
    }
  })

  it('rejects an unknown MARS_DB_BACKEND value', () => {
    process.env.MARS_DB_BACKEND = 'sqlite'
    try {
      expect(() => openDb('whatever')).toThrow(/invalid MARS_DB_BACKEND/)
    } finally {
      process.env.MARS_DB_BACKEND = 'pglite'
    }
  })
})

describe('isolation', () => {
  // Both tests use the same fixed key so they share the same logical database
  // identity; the afterEach(__resetDbRegistryForTests) between them is what
  // makes the second CREATE TABLE succeed. If the reset is ever removed or
  // broken, the second test will fail loudly with "relation already exists".
  const FIXED_KEY = `db-isolation-test-${process.pid}`

  it('does not leak tables between cases (first)', async () => {
    const c = openDb(FIXED_KEY)
    await c.execute('CREATE TABLE isolation_probe (id INTEGER PRIMARY KEY)')
    await c.execute('INSERT INTO isolation_probe (id) VALUES (42)')
    const r = await c.execute('SELECT id FROM isolation_probe')
    expect(r.rows[0]?.['id']).toBe(42)
  })

  it('does not leak tables between cases (second - same key, same table name)', async () => {
    // afterEach from the previous case must have reset the registry; otherwise
    // openDb(FIXED_KEY) returns the same database and CREATE TABLE fails.
    const c = openDb(FIXED_KEY)
    await c.execute('CREATE TABLE isolation_probe (id INTEGER PRIMARY KEY)')
    await c.execute('INSERT INTO isolation_probe (id) VALUES (99)')
    const r = await c.execute('SELECT id FROM isolation_probe')
    expect(r.rows[0]?.['id']).toBe(99)
  })
})
