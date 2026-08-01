/**
 * One-time SQLite → embedded-PostgreSQL importer (migration 0002 §5).
 * Replaces `merge-databases.ts` (the ATTACH-based queue.db/state.db fold —
 * dead since ADR-0034; legacy queue.db/state.db artifacts are ignored).
 *
 * On daemon/init start, when `.mars/mars.db` still exists and PG has not been
 * populated yet, every table present in BOTH the SQLite file and the
 * canonical PG schema is copied row-by-row, then the SQLite file (plus -wal/
 * -shm siblings) is renamed to `mars.db.bak-<unix-ts>` so the import can
 * never run twice and the pre-import data stays recoverable.
 *
 * Mechanics:
 * - The SQLite side is read via `node:sqlite` (`DatabaseSync`, readonly) —
 *   `@libsql/client` is gone from package.json.
 * - The whole copy runs in ONE PG transaction with
 *   `SET LOCAL session_replication_role = replica`, which disables FK
 *   enforcement for the copy (SQLite-era data may violate edge ordering and
 *   even referential integrity; the schema's FKs apply to new writes).
 *   SET LOCAL also guarantees the setting rides the transaction's dedicated
 *   connection on the pool-backed backend and resets on COMMIT/ROLLBACK.
 * - Identity tables (events, self_heal_attempts) are inserted with
 *   `OVERRIDING SYSTEM VALUE` to preserve historic ids (outbox cursors point
 *   at them), then their sequences are re-synced via setval(max(id)+1).
 * - Column mapping: columns present in both sides copy 1:1; SQLite columns
 *   with no PG home are dropped (reported in `droppedColumns`); PG columns
 *   absent from SQLite fall back to their schema defaults. BLOBs arrive as
 *   Uint8Array and land in bytea.
 */

import { existsSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { DatabaseSync, type DatabaseSyncInstance } from '../core/lib/node-sqlite.js'
import {
  withTransaction,
  type DbClient,
  type DbInValue,
  type DbTx,
} from '../core/lib/db.js'
import { ensureSchema, IDENTITY_COLUMNS, SCHEMA_TABLES } from '../core/lib/pg-schema.js'

const BATCH_SIZE = 500

/** schema_migrations marker recorded after a successful import. */
export const IMPORT_MARKER_VERSION = 'sqlite-import'

export interface ImportLegacySqliteOptions {
  /** Absolute path to the legacy `.mars/mars.db` file. */
  sqlitePath: string
  /** An open canonical-schema client (the daemon's shared handle). */
  client: DbClient
}

export type ImportResult =
  | { status: 'no-sqlite' }
  | { status: 'skipped'; reason: 'already-imported' | 'pg-has-data' }
  | {
      status: 'imported'
      /** Rows copied per table (only tables present in both sides). */
      tables: Record<string, number>
      /** SQLite tables with no home in the canonical PG schema. */
      skippedTables: string[]
      /** Per-table SQLite columns dropped for lack of a PG column. */
      droppedColumns: Record<string, string[]>
      /** Where the SQLite file was renamed to. */
      renamedTo: string
    }

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`

const EPOCH_MILLIS_COLUMNS = new Set([
  'task_blockers.created_at',
  'task_progress.created_at',
  'task_transcripts.ts',
  'task_durable_transcripts.created_at',
])

const toDbValue = (value: unknown, table: string, column: string): DbInValue => {
  if (value === null || value === undefined) return null
  if (EPOCH_MILLIS_COLUMNS.has(`${table}.${column}`) && typeof value === 'string') {
    const millis = Date.parse(value)
    if (!Number.isNaN(millis)) return millis
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
  ) {
    return value
  }
  if (value instanceof Uint8Array) return value
  throw new Error(`import-sqlite: unsupported SQLite value type '${typeof value}'`)
}

interface TablePlan {
  table: string
  /** Columns copied 1:1 (present in both SQLite and PG). */
  columns: string[]
  /** SQLite-only columns that will be dropped. */
  dropped: string[]
}

async function planTable(
  tx: DbTx,
  sqlite: DatabaseSyncInstance,
  table: string,
): Promise<TablePlan> {
  const sqliteCols = (
    sqlite.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{
      name: string
    }>
  ).map((r) => r.name)
  const pgColsResult = await tx.execute(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ?`,
    [table],
  )
  const pgCols = new Set(pgColsResult.rows.map((r) => r.column_name as string))
  return {
    table,
    columns: sqliteCols.filter((c) => pgCols.has(c)),
    dropped: sqliteCols.filter((c) => !pgCols.has(c)),
  }
}

async function copyTable(
  tx: DbTx,
  sqlite: DatabaseSyncInstance,
  plan: TablePlan,
): Promise<number> {
  const { table, columns } = plan
  if (columns.length === 0) return 0
  const columnList = columns.map(quoteIdent).join(', ')
  // GENERATED ALWAYS AS IDENTITY rejects explicit ids without this clause —
  // and historic ids MUST survive (outbox cursors reference events.id).
  const overriding =
    table in IDENTITY_COLUMNS && columns.includes(IDENTITY_COLUMNS[table])
      ? ' OVERRIDING SYSTEM VALUE'
      : ''
  const select = sqlite.prepare(`SELECT * FROM ${quoteIdent(table)} LIMIT ? OFFSET ?`)
  let copied = 0
  for (let offset = 0; ; offset += BATCH_SIZE) {
    const rows = select.all(BATCH_SIZE, offset) as Array<Record<string, unknown>>
    if (rows.length === 0) break
    const rowTuple = `(${columns.map(() => '?').join(', ')})`
    const values = rows.map(() => rowTuple).join(', ')
    const args = rows.flatMap((row) =>
      columns.map((column) => toDbValue(row[column], table, column)),
    )
    await tx.execute(
      `INSERT INTO ${quoteIdent(table)} (${columnList})${overriding} VALUES ${values}`,
      args,
    )
    copied += rows.length
    if (rows.length < BATCH_SIZE) break
  }
  return copied
}

/**
 * Imports a legacy `.mars/mars.db` into the canonical PG schema, then renames
 * the SQLite file out of the way. Idempotent: a missing file, a prior import
 * marker, or pre-existing PG task data each short-circuit to a no-op result.
 */
export async function importLegacySqlite(
  options: ImportLegacySqliteOptions,
): Promise<ImportResult> {
  const { sqlitePath, client } = options
  if (!existsSync(sqlitePath)) return { status: 'no-sqlite' }

  // The copy targets canonical tables — make sure they exist (idempotent).
  await ensureSchema(client)

  const marker = await client.execute(
    'SELECT 1 FROM schema_migrations WHERE version = ?',
    [IMPORT_MARKER_VERSION],
  )
  if (marker.rows.length > 0) {
    return { status: 'skipped', reason: 'already-imported' }
  }
  const existingTasks = await client.execute('SELECT count(*) AS n FROM tasks')
  if ((existingTasks.rows[0].n as number) > 0) {
    return { status: 'skipped', reason: 'pg-has-data' }
  }

  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true })
  try {
    const sqliteTables = (
      sqlite
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
    const canonical = new Set(SCHEMA_TABLES)
    // schema_migrations never existed on the SQLite side; guard anyway so a
    // pathological legacy table of that name cannot clobber version rows.
    const importable = sqliteTables.filter(
      (t) => canonical.has(t) && t !== 'schema_migrations',
    )
    const skippedTables = sqliteTables.filter((t) => !canonical.has(t))

    const result = await withTransaction(client, async (tx) => {
      await tx.execute('SET LOCAL session_replication_role = replica')
      const tables: Record<string, number> = {}
      const droppedColumns: Record<string, string[]> = {}
      for (const table of importable) {
        const plan = await planTable(tx, sqlite, table)
        if (plan.dropped.length > 0) droppedColumns[table] = plan.dropped
        tables[table] = await copyTable(tx, sqlite, plan)
      }
      // Re-sync identity sequences past the imported ids.
      for (const [table, column] of Object.entries(IDENTITY_COLUMNS)) {
        await tx.execute(
          `SELECT setval(
             pg_get_serial_sequence('${table}', '${column}'),
             COALESCE((SELECT max(${quoteIdent(column)}) FROM ${quoteIdent(table)}), 0) + 1,
             false
           )`,
        )
      }
      await tx.execute(
        `INSERT INTO schema_migrations (version, applied_at)
         VALUES (?, ?) ON CONFLICT (version) DO NOTHING`,
        [IMPORT_MARKER_VERSION, new Date().toISOString()],
      )
      return { tables, droppedColumns }
    })

    sqlite.close()

    // Rename only after the transaction committed: a crash mid-import leaves
    // the SQLite file untouched and the (rolled-back) PG side empty, so the
    // next boot simply retries.
    const backupPath = `${sqlitePath}.bak-${Math.floor(Date.now() / 1000)}`
    await rename(sqlitePath, backupPath)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${sqlitePath}${suffix}`)) {
        await rename(`${sqlitePath}${suffix}`, `${backupPath}${suffix}`)
      }
    }

    return {
      status: 'imported',
      tables: result.tables,
      skippedTables,
      droppedColumns: result.droppedColumns,
      renamedTo: backupPath,
    }
  } finally {
    if (sqlite.isOpen) sqlite.close()
  }
}
