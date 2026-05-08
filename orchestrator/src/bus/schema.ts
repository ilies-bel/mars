import type { Database } from 'better-sqlite3';

/**
 * Apply the bus schema to a SQLite connection.
 *
 * Idempotent: safe to call on every connection open. Sets WAL pragmas so
 * multiple writer processes can append while the daemon tails the outbox
 * concurrently.
 *
 * TODO(retention): events grow unbounded. A future sweeper should delete
 * rows below `MIN(cursor)` once we track per-subscriber cursors, or apply
 * an age cap (e.g. `DELETE FROM events WHERE ts < unixepoch() - 7*86400`).
 */
export function applySchema(db: Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      type    TEXT    NOT NULL,
      payload TEXT    NOT NULL,
      ts      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_events_id ON events(id);

    CREATE TABLE IF NOT EXISTS tasks (
      id      TEXT PRIMARY KEY,
      status  TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}
