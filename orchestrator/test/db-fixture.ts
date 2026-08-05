import { __truncateAllForTests, openDb, type DbClient } from '../src/core/lib/db.js'

const sharedTarget = `test:shared-pglite:${process.pid}`

/**
 * Return the per-fork PGlite database in its empty, schema-ready state.
 *
 * Call this from `beforeEach`; do not close the returned client. The Vitest
 * worker owns its lifetime, while each caller gets isolation via TRUNCATE.
 */
export async function getTestDb(): Promise<DbClient> {
  // Reacquire by the stable per-fork key so a legacy test that deliberately
  // clears db.ts's registry cannot leave this fixture holding a closed client.
  // In the normal path openDb returns the existing PGlite instance.
  const client = openDb(sharedTarget)
  // Bootstrap through DbClient so its lazy schema-ready registry records the
  // migration. Calling ensureSchema directly would make the first truncate
  // invoke the full idempotent migration a second time.
  await client.execute('SELECT 1')
  await __truncateAllForTests(client)
  return client
}
