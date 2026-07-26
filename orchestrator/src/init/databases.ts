import { resolve } from 'node:path'
import { openDb } from '../core/lib/db'
import { ensureSchema } from '../core/lib/pg-schema'
import { resolveContext, resolveDbTarget } from '../core/context'
import { importLegacySqlite } from './import-sqlite'
import { ensureVerifyGatesSchema } from '../core/verify-gates'
import { ensureCredentialSchema } from '../core/lib/credential-store'

/**
 * Materialise the canonical Mars schema in the per-repo database (the
 * daemon-provisioned embedded PostgreSQL instance; PGlite in tests) and fold
 * in any legacy `.mars/mars.db` SQLite file left behind by a pre-migration
 * install.
 *
 * `ensureSchema` applies the complete canonical DDL idempotently, so calling
 * this on a repo whose database is already populated is a safe no-op.
 * `importLegacySqlite` is equally idempotent: a missing file, a prior import
 * marker, or pre-existing PG task data each short-circuit to a no-op.
 *
 * Requires a reachable database: under the embedded backend the daemon must
 * be running (it publishes `.mars/pg.dsn`); `resolveDbTarget` throws an
 * operator-facing error otherwise. Callers that want to skip instead of fail
 * (e.g. `mars init` before the daemon exists) check reachability first.
 */
export const initDatabases = async (): Promise<void> => {
  const ctx = resolveContext()
  const client = openDb(resolveDbTarget())
  try {
    await ensureSchema(client)
    await ensureVerifyGatesSchema(client)
    await ensureCredentialSchema(client)
    // Fold a pre-migration `.mars/mars.db` into PG before anything writes new
    // rows. The importer renames the SQLite file to `mars.db.bak-<ts>` on
    // success, so subsequent runs are no-sqlite no-ops.
    await importLegacySqlite({
      sqlitePath: resolve(ctx.stateDir, 'mars.db'),
      client,
    })
  } finally {
    await client.close()
  }
}
