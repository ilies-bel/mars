/**
 * Compatibility fixture harness. Production code must use `db.ts` and the
 * embedded PostgreSQL DSN; this module is deliberately not imported outside
 * tests.
 */
import { openDb, type DbClient, type DbTx, withTransaction as withPgTransaction } from './db.js'

export const openLibsql = (config: { url: string }): DbClient => openDb(config.url)

export const withTransaction = <T>(
  client: DbClient,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> => withPgTransaction(client, fn)
