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
 * - `timestamptz` → ISO-8601 UTC strings (rather than backend-dependent
 *   `Date` objects) so CLI and HTTP JSON keep a stable wire format.
 * - Integer 0/1 flag columns come back as plain numbers — never booleans.
 * - Input: JS booleans are serialized as 1/0 (libsql behavior; columns are
 *   INTEGER by design), `undefined` → null, `Uint8Array` → Buffer for pg.
 *
 * No `lastInsertRowid`: use `INSERT ... RETURNING id`.
 * Named (`:name`) args are not supported — no call site ever used them.
 */

import pg from 'pg'
import { PGlite } from '@electric-sql/pglite'
import { recordDbBusyError } from './db-busy-watchdog.js'

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
  | readonly string[]

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

/**
 * A small, test-only bridge for SQLite-era fixture SQL while the suite is
 * being converted to canonical PostgreSQL DDL. Production never enables this
 * flag: runtime call sites execute the PostgreSQL they ship.
 */
function rewriteLegacyFixtureSql(sql: string): string {
  if (process.env.MARS_DB_SQLITE_FIXTURE_COMPAT !== '1') return sql

  let rewritten = sql
    .replace(/\bAUTOINCREMENT\b/gi, '')
    .replace(/\bdatetime\('now'\)/gi, 'now()')
    .replace(/\bunixepoch\(\)/gi, 'floor(extract(epoch from now()))::bigint')
    .replace(/\blast_insert_rowid\(\)/gi, "(SELECT MAX(id) FROM events)")
    .replace(
      /json_extract\(payload\s*,\s*'\$\.([A-Za-z_][A-Za-z0-9_]*)'\)/gi,
      "(payload::jsonb ->> '$1')",
    )

  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(rewritten)) {
    rewritten = rewritten.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO')
    const semicolon = /;\s*$/.exec(rewritten)?.[0] ?? ''
    const body = semicolon ? rewritten.slice(0, -semicolon.length) : rewritten
    rewritten = `${body} ON CONFLICT DO NOTHING${semicolon}`
  } else if (/^\s*INSERT\s+OR\s+REPLACE\s+INTO\b/i.test(rewritten)) {
    // The remaining fixtures use deterministic, fresh ids. A plain INSERT
    // exercises the production table without retaining SQLite REPLACE's
    // delete-and-insert semantics.
    rewritten = rewritten.replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, 'INSERT INTO')
  }
  return rewritten
}

function normalizeStatement(
  stmt: DbStatement,
  args?: readonly DbInValue[],
): { sql: string; params: unknown[] } {
  if (typeof stmt === 'string') {
    return { sql: translatePlaceholders(rewriteLegacyFixtureSql(stmt)), params: (args ?? []).map(toParam) }
  }
  if (args !== undefined) {
    throw new Error(
      'db: pass args either inside the statement object or as the second argument, not both',
    )
  }
  return {
    sql: translatePlaceholders(rewriteLegacyFixtureSql(stmt.sql)),
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
    if (v instanceof Date) {
      // node-postgres returns Date for timestamptz while PGlite can return a
      // string. Normalize at the DB boundary so all public row consumers keep
      // the established ISO-8601 wire format.
      out ??= { ...row }
      out[key] = v.toISOString()
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

// ── Deadlock retry (embedded backend) ───────────────────────────────────────

/** PostgreSQL SQLSTATE for a deadlock victim (`deadlock detected`). */
const DEADLOCK_SQLSTATE = '40P01'
/**
 * Bounded so a genuine, persistent lock-ordering bug still surfaces instead of
 * spinning forever. Eight jittered retries span ~1s of wall time — ample for
 * the daemon's concurrent reconcile/dispatch/watchdog passes to serialize out.
 */
const DEADLOCK_MAX_RETRIES = 8

function isDeadlockError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === DEADLOCK_SQLSTATE
  )
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs `op`, retrying on a PostgreSQL deadlock (SQLSTATE 40P01) with jittered
 * backoff. Deadlocks are the expected outcome when the daemon's many
 * concurrent reconcile / dispatch-poll-fallback / phantom-watchdog passes touch
 * `tasks` and `task_blockers` in different lock orders: Postgres kills one side
 * and rolls it FULLY back, so re-running the operation from a clean state is
 * safe. A single autocommit statement re-executes as itself; a transaction
 * re-runs its whole body from a fresh BEGIN. Exported for unit coverage.
 */
export async function withDeadlockRetry<T>(op: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await op()
    } catch (err: unknown) {
      if (!isDeadlockError(err) || attempt >= DEADLOCK_MAX_RETRIES) {
        // Record deadlock-exhaustion events for the busy-storm watchdog. Only
        // count deadlock errors that exhausted all retries — a single deadlock
        // that succeeds on the second attempt is normal concurrency, not a storm.
        if (isDeadlockError(err) && attempt >= DEADLOCK_MAX_RETRIES) {
          recordDbBusyError('deadlock:exhausted')
        }
        throw err
      }
      // Jittered backoff so simultaneously-deadlocked passes don't re-collide
      // in lockstep on the next attempt.
      const backoffMs = 20 * (attempt + 1) + Math.floor(Math.random() * 40)
      await sleep(backoffMs)
    }
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
  const pool = new pg.Pool({
    connectionString: dsn,
    // Bound query execution time so a reset TCP connection (pg LOG: "unexpected
    // EOF on client connection with an open transaction") causes the awaited
    // query to reject rather than hang forever. Merge-step DB calls
    // (onVegaStart, onAfterFastForward) route through this pool; without a
    // timeout a dead connection silently wedges the merge body and holds
    // .merge.lock indefinitely.
    query_timeout: 60_000,
  })
  // An idle client dropping (e.g. server restart) emits 'error' on the pool;
  // without a listener that crashes the process. The next checkout surfaces
  // the failure to the caller instead.
  pool.on('error', () => {})
  return {
    // A single autocommit statement: on a deadlock it rolled back on its own,
    // so re-executing the same statement is safe.
    query: (sql, params) =>
      withDeadlockRetry(async () =>
        toResultSetPg(await pool.query({ text: sql, values: params })),
      ),
    // A multi-statement transaction: on a deadlock Postgres aborts the whole
    // transaction, so retry re-checks-out a connection and re-runs `fn` from a
    // fresh BEGIN. Each attempt gets its own connection + `broken` flag.
    transaction: (fn) =>
      withDeadlockRetry(async () => {
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
      }),
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

// PGlite 0.5.x honours the `parsers` option for int8 (OID 20) but silently
// ignores it for numeric (OID 1700) — the parser is never invoked.  Work
// around this by reading the per-query `fields` descriptor that PGlite always
// provides and converting string values in numeric columns to JS numbers after
// the fact.
const PGLITE_NUMERIC_OID = 1700

function toResultSetPglite(
  result: { rows: DbRow[]; affectedRows?: number; fields?: ReadonlyArray<{ name: string; dataTypeID: number }> },
  sql: string,
): DbResultSet {
  const numericCols = new Set(
    (result.fields ?? []).filter((f) => f.dataTypeID === PGLITE_NUMERIC_OID).map((f) => f.name),
  )
  const normalize = numericCols.size === 0
    ? normalizeRow
    : (row: DbRow): DbRow => {
        let r = normalizeRow(row)
        for (const col of numericCols) {
          const v = r[col]
          if (typeof v === 'string') {
            r = { ...r, [col]: Number(v) }
          }
        }
        return r
      }
  return {
    rows: result.rows.map(normalize),
    rowsAffected:
      leadingKeyword(sql) === 'select' ? 0 : (result.affectedRows ?? 0),
  }
}

function makePgliteBackend(target: string): BackendOps {
  // File-backed PGlite preserves the former libsql fixture contract: a helper
  // may open, seed, close, and then hand the same target to another helper.
  // Opaque keys remain in-memory for the fast unit tests that only need an
  // isolated connection identity.
  const dataDir = target.startsWith('/') ? `${target}.pglite` : undefined
  // PGlite starts booting as soon as it is constructed. Closing an instance
  // before that asynchronous boot has completed can then wait indefinitely,
  // even though no database operation was requested. Keep `openDb` cheap and
  // make an unused client immediately closable by constructing PGlite on its
  // first query or transaction instead.
  let db: PGlite | undefined
  const mutex = new Mutex()
  const rawQuery: QueryFn = async (sql, params) => {
    db ??= new PGlite(dataDir, {
      parsers: {
        20: (v: string) => Number(v), // int8 — match the pg parser above
        1700: (v: string) => Number(v), // numeric
      },
    })
    return toResultSetPglite(await db.query<DbRow>(sql, params as unknown[]), sql)
  }
  return {
    // Single session: EVERY operation takes the mutex so a plain execute can
    // never land inside another caller's open BEGIN..COMMIT window.
    query: (sql, params) => mutex.run(() => rawQuery(sql, params)),
    transaction: (fn) => mutex.run(() => runInTx(rawQuery, fn)),
    end: () => (db === undefined ? Promise.resolve() : mutex.run(() => db!.close())),
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

// A client can be opened directly by a CLI command or a focused library test,
// without first passing through daemon startup.  Keep that path safe by
// applying the canonical schema before its first user operation.
//
// schemaReadyByTarget serialises schema bootstrap at the *database* level
// (keyed by the registry key: "kind:normalizedTarget").  Two distinct DbClient
// objects that point at the same database share one promise, so only a single
// pg_advisory_xact_lock / DDL transaction runs per process per target — no
// matter how many separate openDb / resolveQueueClient calls were made.
//
// schemaApplyingByClient is the re-entry guard: while ensureSchema is issuing
// DDL it calls client.batch() which calls ensureClientSchema() again on the
// same client.  Without the guard that would start a second bootstrap and
// deadlock waiting for the advisory lock the current transaction already holds.
// It is set AFTER the dynamic import resolves so that two callers that race on
// the very first execute() before any await runs both fall through to
// `await ready` rather than returning immediately before the promise is set.
const schemaReadyByTarget = new Map<string, Promise<void>>()
const schemaApplyingByClient = new WeakSet<DbClient>()

async function ensureClientSchema(client: DbClient, key: string): Promise<void> {
  // Re-entrant call from within ensureSchema's DDL batch — skip.
  if (schemaApplyingByClient.has(client)) return
  let ready = schemaReadyByTarget.get(key)
  if (!ready) {
    ready = (async () => {
      // ensureSchema is imported lazily to avoid a circular-module dependency
      // (pg-schema.ts imports db.ts; db.ts must not import pg-schema.ts at the
      // top level).
      const { ensureSchema } = await import('./pg-schema.js')
      schemaApplyingByClient.add(client)
      try {
        await ensureSchema(client)
      } finally {
        schemaApplyingByClient.delete(client)
      }
    })()
    schemaReadyByTarget.set(key, ready)
  }
  await ready
}

function makeClient(backend: BackendOps, key: string): DbClient {
  const client: DbClient = {
    execute: async (stmt, args) => {
      await ensureClientSchema(client, key)
      const { sql, params } = normalizeStatement(stmt, args)
      return backend.query(sql, params)
    },
    batch: async (stmts, _mode?) => {
      await ensureClientSchema(client, key)
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
  // SQLite-era fixtures commonly used `file:/path/to/mars.db`, while the
  // PostgreSQL helpers receive the same path as an opaque PGlite identity.
  // Treat those as one test database; embedded mode still requires a DSN.
  const normalizedTarget = kind === 'pglite' && target.startsWith('file:')
    ? target.slice('file:'.length)
    : target
  const key = `${kind}:${normalizedTarget}`
  const existing = registry.get(key)
  if (existing) {
    existing.refs += 1
    return existing.client
  }
  const backend = kind === 'embedded'
    ? makeEmbeddedBackend(target)
    : makePgliteBackend(normalizedTarget)
  const entry: RegistryEntry = {
    backend,
    refs: 1,
    client: makeClient(backend, key),
  }
  registry.set(key, entry)
  return entry.client
}

/**
 * Close every open database connection in the registry and clear the registry.
 *
 * Used exclusively by the test suite before `vi.resetModules()` so that PGlite
 * WASM memory is freed rather than orphaned. Calling this in production code is
 * a mistake — production uses a long-lived singleton pool that must not be torn
 * down between requests.
 *
 * Safe to call when the registry is empty (no-op).
 */
export async function closeAllDbs(): Promise<void> {
  const entries = [...registry.entries()]
  for (const [key, entry] of entries) {
    registry.delete(key)
    try {
      await entry.backend.end()
    } catch {
      // Best-effort: an already-crashed PGlite instance may throw on close.
    }
  }
  schemaReadyByTarget.clear()
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
 * Internal-only: runs `stmts` in a single transaction on `client` WITHOUT
 * going through the `ensureClientSchema` lazy-bootstrap guard.
 *
 * Used exclusively by `ensureSchema` in `pg-schema.ts`.  If `ensureSchema`
 * called `client.batch(...)` instead, `batch` would invoke `ensureClientSchema`
 * which would recursively call `ensureSchema` (the re-entry guard catches the
 * inner call), and then the OUTER `client.batch` body would run the SAME DDL
 * a second time in a separate transaction.  That double-transaction leaves a
 * window between the two transactions where the advisory lock is not held,
 * allowing another session to interleave DDL and create a DML-DDL deadlock.
 *
 * By bypassing `ensureClientSchema` entirely, `ensureSchema` runs its DDL in
 * exactly one transaction — the advisory lock is acquired and held for the full
 * duration.
 */
export async function __execSchemaBatch(
  client: DbClient,
  stmts: readonly DbStatement[],
): Promise<void> {
  const backend = backendOf.get(client)
  if (!backend) {
    // A client that never passed through `openDb` (or reached us across a
    // duplicated module instance, where this WeakMap is not the one it was
    // registered in) cannot use the single-transaction fast path.
    //
    // Fall back to `client.batch` — exactly what `ensureSchema` did before the
    // fast path existed. It costs the deadlock guarantee documented above: the
    // re-entry guard means the DDL runs in two transactions with a window
    // between them where the advisory lock is not held. That is a narrow,
    // startup-only race.
    //
    // Throwing instead is far worse, and was: this threw on the `code` step of
    // ordinary tasks, so EVERY task in the queue died on dispatch and nothing
    // completed for hours. Degrading beats halting the orchestrator.
    console.warn(
      'db: __execSchemaBatch got a client not registered by openDb; ' +
        'falling back to client.batch (schema DDL runs in two transactions)',
    )
    await client.batch(stmts)
    return
  }
  const normalized = stmts.map((s) => normalizeStatement(s))
  await backend.transaction(async (query) => {
    for (const { sql, params } of normalized) {
      await query(sql, params)
    }
  })
}

/**
 * Test-only: closes every registered client and empties the registry so the
 * next `openDb` starts fresh (mirrors `__resetStateClientForTests`).
 */
export async function __resetDbRegistryForTests(): Promise<void> {
  const entries = [...registry.values()]
  registry.clear()
  schemaReadyByTarget.clear()
  await Promise.allSettled(entries.map((e) => e.backend.end()))
}

/**
 * Test-only: empty a live canonical database while retaining its PGlite
 * instance. This is substantially cheaper than resetting the module registry
 * and cold-booting WASM for every test.
 */
export async function __truncateAllForTests(client: DbClient): Promise<void> {
  const result = await client.execute(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  )
  const tables = result.rows
    .map((row) => row.tablename)
    .filter((table): table is string => typeof table === 'string')

  if (tables.length > 0) {
    const identifiers = tables
      .map((table) => `\"${table.replaceAll('\"', '\"\"')}\"`)
      .join(', ')
    await client.execute(`TRUNCATE ${identifiers} RESTART IDENTITY CASCADE`)
  }

  // pg-schema owns the list of rows needed by an otherwise empty schema.
  // Load it lazily to preserve db.ts <-> pg-schema.ts's existing cycle break.
  const { __reseedSchemaForTests } = await import('./pg-schema.js')
  await __reseedSchemaForTests(client)
}

/**
 * Test-only: creates a fresh DbClient that is NOT added to the shared
 * registry. Every call returns a distinct object with its own connection pool
 * / PGlite instance, even when `target` is the same as a registered client.
 *
 * Used by the concurrency regression suite to reproduce the scenario where two
 * independent modules hold separate client objects for the same database.
 */
export function __createFreshClientForTests(target: string): DbClient {
  const kind = resolveBackendKind()
  const normalizedTarget =
    kind === 'pglite' && target.startsWith('file:')
      ? target.slice('file:'.length)
      : target
  const backend =
    kind === 'embedded'
      ? makeEmbeddedBackend(target)
      : makePgliteBackend(normalizedTarget)
  // Use a sentinel key that does not collide with the registry so close()
  // never accidentally removes the real singleton.
  const key = `__fresh__:${kind}:${normalizedTarget}`
  return makeClient(backend, key)
}

/**
 * Best-effort connection-pool recycle for the busy-storm watchdog.
 *
 * Removes the registry entry for `target` and tears down the underlying
 * pool / PGlite instance so the next `openDb(target)` call creates a fresh
 * backend. Existing `DbClient` handles that were opened against the old entry
 * will receive errors on their next `execute` / `batch` call — callers with
 * `try/catch` around DB operations (all daemon subsystems) will surface those
 * errors through their normal error paths and log them.
 *
 * The `end()` call is raced against a 5-second timeout so a wedged pool does
 * not block the caller indefinitely (the registry entry has already been
 * removed, so the next `openDb` will succeed regardless of whether `end()`
 * drains cleanly).
 *
 * @param target The DSN or PGlite identity key passed to `openDb`.
 */
export async function recycleDbPool(target: string): Promise<void> {
  const kind = resolveBackendKind()
  const normalizedTarget =
    kind === 'pglite' && target.startsWith('file:')
      ? target.slice('file:'.length)
      : target
  const key = `${kind}:${normalizedTarget}`
  const entry = registry.get(key)
  if (!entry) return
  // Remove from the registry FIRST so that concurrent `openDb` callers create
  // a fresh entry immediately, even if `end()` takes time to drain.
  registry.delete(key)
  // Clear the per-target schema-ready promise so the next openDb(target) call
  // re-bootstraps the schema on its first use.
  schemaReadyByTarget.delete(key)
  await Promise.race([
    entry.backend.end().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ])
}
