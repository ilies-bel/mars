import { openLibsql } from './libsql'

/**
 * Delete rows from the `events` outbox table that have been consumed by
 * every registered subscriber AND are older than `maxAgeSeconds` seconds.
 *
 * Two-axis safety:
 *   - Cursor gate: only deletes rows with id <= MIN(subscribers.cursor), so
 *     no row is removed before every subscriber has acknowledged it.
 *   - Age gate: only deletes rows where ts < (unixepoch() - maxAgeSeconds),
 *     so a recently-consumed row is kept until it ages out.
 *
 * If the `subscribers` table has no rows (no consumers registered), returns 0
 * immediately — age alone never triggers a delete.
 *
 * Returns the count of deleted rows.
 */
export const pruneOutbox = async (
  dbPath: string,
  maxAgeSeconds: number,
): Promise<number> => {
  const client = openLibsql({ url: `file:${dbPath}` })
  try {
    const cursorResult = await client.execute(
      'SELECT COALESCE(MIN(cursor), -1) AS min_cursor, COUNT(*) AS sub_count FROM subscribers',
    )
    const subCount = Number(cursorResult.rows[0].sub_count)
    if (subCount === 0) return 0

    const minCursor = Number(cursorResult.rows[0].min_cursor)
    const result = await client.execute({
      sql: 'DELETE FROM events WHERE id <= ? AND ts < (unixepoch() - ?)',
      args: [minCursor, maxAgeSeconds],
    })
    return result.rowsAffected
  } finally {
    client.close()
  }
}
