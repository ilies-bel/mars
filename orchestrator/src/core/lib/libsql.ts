import { createClient, type Client } from '@libsql/client'

// @libsql/client 0.17.3: Sqlite3Client holds one persistent connection for file: URLs, so a single PRAGMA after createClient suffices.
export function openLibsql(config: { url: string }): Client {
  const client = createClient(config)
  client.execute('PRAGMA foreign_keys = ON').catch(() => {})
  // A 5-second busy-timeout means a contending writer waits instead of
  // immediately failing with SQLITE_BUSY.  WAL autocheckpoint at 1000 pages
  // keeps the WAL from growing unbounded; the daemon's periodic
  // wal-checkpoint-sweeper is the backstop that actually truncates the file.
  client.execute('PRAGMA busy_timeout = 5000').catch(() => {})
  client.execute('PRAGMA wal_autocheckpoint = 1000').catch(() => {})
  return client
}
