import type { Client } from '@libsql/client'

export type WalCheckpointResult = {
  busy: number
  log: number
  checkpointed: number
}

/**
 * Runs PRAGMA wal_checkpoint(TRUNCATE) on the provided libsql client and
 * returns the (busy, log, checkpointed) triple.
 *
 * TRUNCATE moves all WAL frames into the main DB file, then truncates the WAL
 * file to zero bytes.  A busy result (busy = 1) means one or more readers are
 * still reading WAL frames — it is expected under load and must be logged by
 * the caller rather than treated as an error.
 */
export const sweepWalCheckpoint = async (client: Client): Promise<WalCheckpointResult> => {
  const result = await client.execute('PRAGMA wal_checkpoint(TRUNCATE)')
  const row = result.rows[0]
  return {
    busy: Number(row[0]),
    log: Number(row[1]),
    checkpointed: Number(row[2]),
  }
}
