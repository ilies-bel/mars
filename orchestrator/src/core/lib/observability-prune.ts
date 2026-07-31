import { openDb } from './db.js'

/**
 * Delete telemetry rows from the `trace_events` table in the Mars database
 * at `dbTarget` that are older than `maxAgeDays` days. Pass `maxAgeDays = 0`
 * to delete all rows regardless of age.
 *
 * Returns the count of deleted rows.
 *
 * The table is owned by the canonical schema (`pg-schema.ts` `ensureSchema`,
 * applied at daemon/init start), so prune assumes it exists.
 *
 * Safe to run while the Mars daemon is running — PostgreSQL MVCC permits
 * concurrent readers and writers without coordination from the caller.
 * Space reclamation after the DELETEs is autovacuum's job; there is no
 * explicit compaction step here (`mars db compact` maps to VACUUM (ANALYZE)
 * for deliberate compaction).
 */
export const pruneObservability = async (
  dbTarget: string,
  maxAgeDays: number,
): Promise<number> => {
  const client = openDb(dbTarget)
  try {
    let result
    if (maxAgeDays === 0) {
      result = await client.execute('DELETE FROM trace_events')
    } else {
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
      result = await client.execute({
        sql: 'DELETE FROM trace_events WHERE timestamp < ?',
        args: [cutoff],
      })
    }
    return result.rowsAffected
  } finally {
    await client.close()
  }
}
