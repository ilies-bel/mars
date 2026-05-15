import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { applySchema } from './schema.js';

/**
 * Open a better-sqlite3 connection for the bus database.
 *
 * - Resolves the path from `BUS_DB` if `path` is not supplied.
 * - Turns on `foreign_keys` immediately, before any schema work, so every
 *   bus connection enforces FK constraints (better-sqlite3 defaults the
 *   pragma to OFF on each new connection).
 * - Applies WAL pragmas + the bus schema (idempotent) before returning.
 * - Callers may freely use the returned connection for both reads and
 *   writes; WAL mode allows concurrent readers (e.g. the daemon).
 *
 * This is the single Mars-owned construction site for `better-sqlite3`
 * databases; route any new bus open through here so the pragma stays
 * centralised.
 */
export function openDb(path: string = process.env.BUS_DB ?? './app.db'): DatabaseType {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return db;
}

export type { DatabaseType as BusDatabase };
