import { createClient, type Client } from '@libsql/client'

// @libsql/client 0.17.3: Sqlite3Client holds one persistent connection for file: URLs, so a single PRAGMA after createClient suffices.
export function openLibsql(config: { url: string }): Client {
  const client = createClient(config)
  client.execute('PRAGMA foreign_keys = ON').catch(() => {})
  return client
}
