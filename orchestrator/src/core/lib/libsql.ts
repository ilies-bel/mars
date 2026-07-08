import { createClient, type Client, type Transaction } from '@libsql/client'

// @libsql/client 0.17.3: Sqlite3Client holds one persistent connection for file: URLs.
// All execute() calls on a file: URL client are serialised through that single
// connection's internal queue.  Queuing the four pragmas below synchronously
// before returning guarantees they run before any caller-queued statement —
// the "applied before first use" contract holds without making this function async.
export function openLibsql(config: { url: string }): Client {
  const client = createClient(config)

  // PRAGMA journal_mode = WAL must be first.  WAL allows concurrent readers to
  // proceed while the daemon writes, eliminating the SQLITE_BUSY that rollback-
  // journal mode (the SQLite default) produces under read/write concurrency.
  // The PRAGMA returns the resulting mode; anything other than 'wal' means the
  // switch failed (e.g. read-only filesystem or unsupported VFS) and warrants
  // a visible warning so the operator can act.
  void client
    .execute('PRAGMA journal_mode = WAL')
    .then(result => {
      const mode = result.rows[0]?.['journal_mode']
      if (typeof mode === 'string' && mode !== 'wal') {
        console.warn(
          `[libsql] journal_mode=WAL not applied; running in '${mode}' mode. ` +
            'Concurrent CLI reads and daemon writes may still produce SQLITE_BUSY.',
        )
      }
    })
    .catch(err => {
      console.error('[libsql] Failed to set PRAGMA journal_mode = WAL:', err)
    })

  // Remaining pragmas.  Errors are now surfaced rather than silently swallowed
  // so real configuration failures (e.g. corrupt DB, mismatched libsql build)
  // are visible in logs.
  void client.execute('PRAGMA foreign_keys = ON').catch(err => {
    console.error('[libsql] Failed to set PRAGMA foreign_keys = ON:', err)
  })
  // A 5-second busy-timeout means a contending writer waits instead of
  // immediately failing with SQLITE_BUSY.  WAL autocheckpoint at 1000 pages
  // keeps the WAL from growing unbounded; the daemon's periodic
  // wal-checkpoint-sweeper is the backstop that actually truncates the file.
  void client.execute('PRAGMA busy_timeout = 5000').catch(err => {
    console.error('[libsql] Failed to set PRAGMA busy_timeout = 5000:', err)
  })
  void client.execute('PRAGMA wal_autocheckpoint = 1000').catch(err => {
    console.error('[libsql] Failed to set PRAGMA wal_autocheckpoint = 1000:', err)
  })

  return client
}

/**
 * Run `fn` inside a libsql write transaction, committing on success and
 * rolling back on any error so an exception can never strand an open write
 * transaction (the root cause of the SQLITE_BUSY wedge incidents on
 * 2026-07-03 and 2026-07-05).
 *
 * Pattern:
 * - `BEGIN IMMEDIATE` is implicit in `client.transaction('write')`.
 * - `COMMIT` runs when `fn` returns normally.
 * - `ROLLBACK` runs in the catch path when `fn` throws, then the original
 *   error is rethrown.  Rollback errors are swallowed so the caller always
 *   sees the original failure.
 * - `tx.close()` in the finally block tears down the transaction object
 *   regardless of outcome (no-op when already committed or rolled back).
 */
export async function withTransaction<T>(
  client: Client,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const tx = await client.transaction('write')
  try {
    const result = await fn(tx)
    await tx.commit()
    return result
  } catch (err) {
    try {
      await tx.rollback()
    } catch {
      // Swallow rollback errors; the original error takes priority.
    }
    throw err
  } finally {
    tx.close()
  }
}
