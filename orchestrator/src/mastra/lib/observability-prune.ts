import { openLibsql } from './libsql'

/**
 * Delete telemetry rows from the `trace_events` table in the SQLite DB at
 * `dbPath` that are older than `maxAgeDays` days. Pass `maxAgeDays = 0` to
 * delete all rows regardless of age.
 *
 * Returns the count of deleted rows.
 *
 * The table is created (via `CREATE TABLE IF NOT EXISTS`) if it does not yet
 * exist, so prune is safe to call on a freshly-initialised repo that has
 * never run the daemon.
 *
 * Safe to run while the Mars daemon is running — libsql opens the file in
 * WAL mode which permits concurrent readers and writers on the same path
 * without coordination from the caller.
 */
export const pruneObservability = async (
  dbPath: string,
  maxAgeDays: number,
): Promise<number> => {
  const client = openLibsql({ url: `file:${dbPath}` })
  try {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS trace_events (
        id        TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        kind      TEXT NOT NULL,
        severity  TEXT NOT NULL DEFAULT 'info',
        task_id   TEXT,
        origin_id TEXT,
        phase     TEXT,
        payload   TEXT NOT NULL DEFAULT '{}'
      )
    `)
    let result
    if (maxAgeDays === 0) {
      result = await client.execute('DELETE FROM trace_events')
    } else {
      const cutoff = new Date(
        Date.now() - maxAgeDays * 24 * 60 * 60 * 1000,
      ).toISOString()
      result = await client.execute({
        sql: 'DELETE FROM trace_events WHERE timestamp < ?',
        args: [cutoff],
      })
    }
    return result.rowsAffected
  } finally {
    client.close()
  }
}
