import type { DbClient } from './db.js'
import { nextAdrNumber } from './adr.js'

/**
 * Atomically claim the next ADR number while keeping ADR contents in Git.
 *
 * The filesystem supplies a floor for repositories that predate the counter;
 * PostgreSQL supplies the durable, cross-process reservation boundary.
 */
export const reserveAdrNumber = async (
  client: DbClient,
  recordsDir: string,
): Promise<number> => {
  const onDiskFloor = (await nextAdrNumber(recordsDir)) - 1
  const result = await client.execute({
    sql: `INSERT INTO document_number_counters (name, next_value, updated_at)
          VALUES (?, ?, now())
          ON CONFLICT (name) DO UPDATE
            SET next_value = GREATEST(
              document_number_counters.next_value,
              EXCLUDED.next_value - 1
            ) + 1,
                updated_at = now()
          RETURNING next_value - 1 AS number`,
    args: ['adr', onDiskFloor + 2],
  })
  const number = result.rows[0]?.number
  if (typeof number !== 'number') {
    throw new Error('ADR number reservation did not return a number')
  }
  return number
}
