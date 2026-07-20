/**
 * THE database client seam (migration 0002: SQLite/libsql → embedded PostgreSQL).
 *
 * Replaces `core/lib/libsql.ts` (hard cut). Call sites keep the libsql call
 * shape — `client.execute(sql, args?)` / `client.execute({sql, args})` with `?`
 * positional placeholders, `client.batch(stmts, mode?)`, and
 * `withTransaction(client, fn)` — while the wire underneath is PostgreSQL:
 *
 * - `MARS_DB_BACKEND=embedded` (default): a `pg.Pool` over the DSN published
 *   by the daemon in `.mars/pg.dsn` (`postgres://mars@127.0.0.1:<port>/mars`).
 * - `MARS_DB_BACKEND=pglite` (tests): an in-process, in-memory PGlite instance
 *   per target key. The target string is an identity key only (test fixtures
 *   derive it from the resolved context, e.g. a mkdtemp repo path); storage is
 *   always `memory://`. All operations on one PGlite instance serialize behind
 *   an internal promise-chain mutex so a plain `execute` can never interleave
 *   into another caller's open transaction (PGlite is a single session).
 *
 * One shared client per (backend, target) per process: `openDb` with the same
 * target returns the same `DbClient` object. `close()` is reference-counted —
 * each `openDb` call increments, each `close()` decrements, and the underlying
 * pool/instance is only torn down when the count reaches zero. This preserves
 * the existing open-use-close discipline of the short-lived sweep helpers
 * without letting them yank the daemon's shared pool away.
 *
 * Value normalization (both backends return identical row value types):
 * - `int8` / `numeric` → JS `number` (values here stay far below 2^53).
 * - `bytea` → `Uint8Array` (pg returns Buffer, which IS a Uint8Array).
 * - Integer 0/1 flag columns come back as plain numbers — never booleans.
 * - Input: JS booleans are serialized as 1/0 (libsql behavior; columns are
 *   INTEGER by design), `undefined` → null, `Uint8Array` → Buffer for pg.
 *
 * No `lastInsertRowid`: use `INSERT ... RETURNING id`.
 * Named (`:name`) args are not supported — no call site ever used them.
 */

import pg from 'pg'
import { PGlite } from '@electric-sql/pglite'

// ── Public types ────────────────────────────────────────────────────────────

/** Values accepted as statement arguments. */
export type DbInValue =
  | null
  | undefined
  | string
  | number
  | bigint
  | boolean
  | Uint8Array

/** A result row, keyed by column name. */
export type DbRow = Record<string, unknown>

/** Mirror of the libsql ResultSet surface the call sites consume. */
export interface DbResultSet {
  rows: DbRow[]
  rowsAffected: number
}

/** `execute('SELECT ...', [a])` or `execute({sql: 'SELECT ...', args: [a]})`. */
export type DbStatement = string | { sql: string; args?: readonly DbInValue[] }

/**
 * Accepted for libsql call-shape compatibility (`batch(stmts, 'write')`);
 * PostgreSQL has no read/write batch distinction — the value is ignored.
 */
export type DbBatchMode = 'read' | 'write'

/** The transaction-scoped executor handed to `withTransaction` callbacks. */
export interface DbTx {
  execute(stmt: DbStatement, args?: readonly DbInValue[]): Promise<DbResultSet>
}

export interface DbClient extends DbTx {
  /** Executes all statements in one transaction; rolls back if any fails. */
  batch(stmts: readonly DbStatement[], mode?: DbBatchMode): Promise<DbResultSet[]>
  /**
   * Releases this handle. Reference-counted per (backend, target): the
   * underlying pool / PGlite instance closes only when every `openDb` of the
   * same target has been balanced by a `close()`.
   */
  close(): Promise<void>
}

// ── Placeholder translation (? → $n) ────────────────────────────────────────

/**
 * Translates `?` positional placeholders to `$1..$n`, skipping content inside
 * '...' string literals (with '' escapes), "..." quoted identifiers (with ""
 * escapes), `--` line comments, `／*...*／` block comments and `$tag$...$tag$`
 * dollar-quoted strings. Exported for tests.
 */
export function translatePlaceholders(sql: string): string {
  let out = ''
  let n = 0
  let i = 0
  const len = sql.length
  while (i < len) {
    const ch = sql[i]
    if (ch === "'" || ch === '"') {
      // Quoted literal/identifier; doubled quote is an escape.
      let j = i + 1
      while (j < len) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      out += sql.slice(i, j)
      i = j
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      let j = sql.indexOf('\n', i)
      if (j === -1) j = len
      out += sql.slice(i, j)
      i = j
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      const j = end === -1 ? len : end + 2
      out += sql.slice(i, j)
      i = j
      continue
    }
    if (ch === '$') {
      // Dollar-quoted string: $tag$ ... $tag$ (tag may be empty).
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        const j = end === -1 ? len : end + tag.length
        out += sql.slice(i, j)
        i = j
        continue
      }
    }
    if (ch === '?') {
      n += 1
      out += `$${n}`
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

// ── Statement / value normalization ─────────────────────────────────────────

function toParam(value: DbInValue): unknown {
  if (value === undefined) return null
  // Columns are INTEGER 0/1 by design (migration 0002 keeps them); serialize
  // JS booleans the way libsql did so they land in integer columns.
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'bigint') {
    // Values in this schema stay far below 2^53; pg would send bigint fine
    // but PGlite's serializer does not — normalize once, here.
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  }
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    // node-postgres only recognizes Buffer for bytea; a bare Uint8Array
    // would be JSON-stringified. Buffer IS a Uint8Array, so PGlite is fine.
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  return value
}

function normalizeStatement(
  stmt: DbStatement,
  args?: readonly DbInValue[],
): { sql: string; params: unknown[] } {
  if (typeof stmt === 'string') {
    return { sql: translatePlaceholders(stmt), params: (args ?? []).map(toParam) }
  }
  if (args !== undefined) {
    throw new Error(
      'db: pass args either inside the statement object or as the second argument, not both',
    )
  }
  return {
    sql: translatePlaceholders(stmt.sql),
    params: (stmt.args ?? []).map(toParam),
  }
}

function normalizeRow(row: DbRow): DbRow {
  let out: DbRow | null = null
  for (const key of Object.keys(row)) {
    const v = row[key]
    if (typeof v === 'bigint') {
      // Safety net if a backend parser slips through: libsql returned numbers.
      out ??= { ...row }
      out[key] = Number(v)
    }
  }
  return out ?? row
}

/** First SQL keyword, past leading whitespace/comments (lowercased). */
function leadingKeyword(sql: string): string {
  let i = 0
  const len = sql.length
  for (;;) {
    while (i < len && /\s/.test(sql[i]!)) i += 1
    if (sql.startsWith('--', i)) {
      const j = sql.indexOf('\n', i)
      if (j === -1) return ''
      i = j + 1
      continue
    }
    if (sql.startsWith('/*', i)) {
      const j = sql.indexOf('*/', i)
      if (j === -1) return ''
      i = j + 2
      continue
    }
    break
  }
  const m = /^[A-Za-z]+/.exec(sql.slice(i))
  return m ? m[0].toLowerCase() : ''
}

// ── Backend abstraction ─────────────────────────────────────────────────────

type QueryFn = (sql: string, params: unknown[]) => Promise<DbResultSet>

interface BackendOps {
  query: QueryFn
  /**
   * Runs `fn` with a dedicated, exclusive session wrapped in
   * BEGIN/COMMIT/ROLLBACK. Rollback errors are swallowed; the original error
   * is rethrown.
   */
  transaction<T>(fn: (query: QueryFn) => Promise<T>): Promise<T>
  end(): Promise<void>
}

async function runInTx<T>(
  query: QueryFn,
  fn: (query: QueryFn) => Promise<T>,
): Promise<T> {
  await query('BEGIN', [])
  try {
    const result = await fn(query)
    await query('COMMIT', [])
    return result
  } catch (err: unknown) {
    try {
      await query('ROLLBACK', [])
    } catch {
      // Swallow rollback errors; the original error takes priority.
    }
    throw err
  }
}

// ── embedded backend (pg.Pool over the daemon-provisioned server) ───────────

let pgTypeParsersInstalled = false

function installPgTypeParsers(): void {
  if (pgTypeParsersInstalled) return
  pgTypeParsersInstalled = true
  // int8 (OID 20) and numeric (OID 1700) come back as strings by default;
  // libsql returned numbers and every value in this schema is far below 2^53.
  pg.types.setTypeParser(20, (v: string) => Number(v))
  pg.types.setTypeParser(1700, (v: string) => Number(v))
}

function toResultSetPg(result: pg.QueryResult): DbResultSet {
  return {
    rows: result.rows.map(normalizeRow),
    // libsql reports 0 for SELECT; pg's rowCount for SELECT is rows.length.
    rowsAffected: result.command === 'SELECT' ? 0 : (result.rowCount ?? 0),
  }
}

function makeEmbeddedBackend(dsn: string): BackendOps {
  installPgTypeParsers()
  const pool = new pg.Pool({ connectionString: dsn })
  // An idle client dropping (e.g. server restart) emits 'error' on the pool;
  // without a listener that crashes the process. The next checkout surfaces
  // the failure to the caller instead.
  pool.on('error', () => {})
  return {
    query: async (sql, params) =>
      toResultSetPg(await pool.query({ text: sql, values: params })),
    transaction: async (fn) => {
      const conn = await pool.connect()
      let broken = false
      try {
        return await runInTx(async (sql, params) => {
          try {
            return toResultSetPg(await conn.query({ text: sql, values: params }))
          } catch (err: unknown) {
            // COMMIT/ROLLBACK failures can leave the session in an unknown
            // state; destroy the connection instead of pooling it again.
            if (sql === 'COMMIT' || sql === 'ROLLBACK') broken = true
            throw err
          }
        }, fn)
      } finally {
        conn.release(broken ? new Error('db: transaction connection discarded') : undefined)
      }
    },
    end: () => pool.end(),
  }
}

// ── pglite backend (in-process, in-memory; tests) ───────────────────────────

/** Serializes async operations: at most one runs at a time, FIFO. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn)
    this.tail = result.catch(() => undefined)
    return result
  }
}

function toResultSetPglite(
  result: { rows: DbRow[]; affectedRows?: number },
  sql: string,
): DbResultSet {
  return {
    rows: result.rows.map(normalizeRow),
    rowsAffected:
      leadingKeyword(sql) === 'select' ? 0 : (result.affectedRows ?? 0),
  }
}

function makePgliteBackend(): BackendOps {
  const db = new PGlite({
    parsers: {
      20: (v: string) => Number(v), // int8 — match the pg parser above
      1700: (v: string) => Number(v), // numeric
    },
  })
  const mutex = new Mutex()
  const rawQuery: QueryFn = async (sql, params) =>
    toResultSetPglite(await db.query<DbRow>(sql, params as unknown[]), sql)
  return {
    // Single session: EVERY operation takes the mutex so a plain execute can
    // never land inside another caller's open BEGIN..COMMIT window.
    query: (sql, params) => mutex.run(() => rawQuery(sql, params)),
    transaction: (fn) => mutex.run(() => runInTx(rawQuery, fn)),
    end: () => mutex.run(() => db.close()),
  }
}

// ── Registry + client construction ──────────────────────────────────────────

type BackendKind = 'embedded' | 'pglite'

function resolveBackendKind(): BackendKind {
  const raw = process.env.MARS_DB_BACKEND ?? 'embedded'
  if (raw !== 'embedded' && raw !== 'pglite') {
    throw new Error(
      `db: invalid MARS_DB_BACKEND '${raw}' (expected 'embedded' or 'pglite')`,
    )
  }
  return raw
}

interface RegistryEntry {
  client: DbClient
  backend: BackendOps
  refs: number
}

const registry = new Map<string, RegistryEntry>()
const backendOf = new WeakMap<DbClient, BackendOps>()

function makeClient(backend: BackendOps, key: string): DbClient {
  const client: DbClient = {
    execute: (stmt, args) => {
      const { sql, params } = normalizeStatement(stmt, args)
      return backend.query(sql, params)
    },
    batch: (stmts, _mode?) => {
      const normalized = stmts.map((s) => normalizeStatement(s))
      return backend.transaction(async (query) => {
        const results: DbResultSet[] = []
        for (const { sql, params } of normalized) {
          results.push(await query(sql, params))
        }
        return results
      })
    },
    close: async () => {
      const entry = registry.get(key)
      if (!entry || entry.client !== client) return // already torn down
      entry.refs -= 1
      if (entry.refs > 0) return
      registry.delete(key)
      await entry.backend.end()
    },
  }
  backendOf.set(client, backend)
  return client
}

/**
 * Opens (or returns the process-shared) client for `target`.
 *
 * - embedded: `target` is a `postgres://` DSN (read it from `.mars/pg.dsn`).
 * - pglite: `target` is an opaque identity key; storage is in-memory.
 */
export function openDb(target: string): DbClient {
  const kind = resolveBackendKind()
  if (kind === 'embedded' && !/^postgres(ql)?:\/\//.test(target)) {
    throw new Error(
      `db: embedded backend expects a postgres:// DSN, got '${target}' ` +
        '(read it from .mars/pg.dsn — file paths are a SQLite-era artifact)',
    )
  }
  const key = `${kind}:${target}`
  const existing = registry.get(key)
  if (existing) {
    existing.refs += 1
    return existing.client
  }
  const backend = kind === 'embedded' ? makeEmbeddedBackend(target) : makePgliteBackend()
  const entry: RegistryEntry = {
    backend,
    refs: 1,
    client: makeClient(backend, key),
  }
  registry.set(key, entry)
  return entry.client
}

/**
 * Runs `fn` inside a transaction on a dedicated session: BEGIN before,
 * COMMIT on success, ROLLBACK on any error (rollback errors swallowed, the
 * original rethrown) — an exception can never strand an open transaction.
 * On the embedded backend the session is a pool checkout; on PGlite the
 * whole transaction holds the instance mutex.
 */
export async function withTransaction<T>(
  client: DbClient,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  const backend = backendOf.get(client)
  if (!backend) {
    throw new Error('db: withTransaction requires a client created by openDb')
  }
  return backend.transaction((query) =>
    fn({
      execute: (stmt, args) => {
        const { sql, params } = normalizeStatement(stmt, args)
        return query(sql, params)
      },
    }),
  )
}

/**
 * Test-only: closes every registered client and empties the registry so the
 * next `openDb` starts fresh (mirrors `__resetStateClientForTests`).
 */
export async function __resetDbRegistryForTests(): Promise<void> {
  const entries = [...registry.values()]
  registry.clear()
  await Promise.allSettled(entries.map((e) => e.backend.end()))
}
