import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { applySchema } from './schema.js';

/**
 * Open a better-sqlite3 connection for the bus database.
 *
 * - Resolves the path from `BUS_DB` if `path` is not supplied.
 * - Applies WAL pragmas + the bus schema (idempotent) before returning.
 * - Callers may freely use the returned connection for both reads and
 *   writes; WAL mode allows concurrent readers (e.g. the daemon).
 */
export function openDb(path: string = process.env.BUS_DB ?? './app.db'): DatabaseType {
  const db = new Database(path);
  applySchema(db);
  return db;
}

export type { DatabaseType as BusDatabase };
