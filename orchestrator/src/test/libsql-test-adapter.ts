/**
 * Transitional test adapter for suites that still import `@libsql/client`.
 *
 * It preserves the tiny client surface those tests consume while executing on
 * PGlite, so the test suite exercises PostgreSQL semantics rather than opening
 * a second SQLite database.
 */
import { openDb, type DbClient, type DbTx } from '../core/lib/db.js'

export type Client = DbClient
export type Transaction = DbTx

export const createClient = ({ url }: { url: string }): Client => openDb(url)
