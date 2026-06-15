import { pruneOutbox } from '../lib/outbox-prune.js'
import { openLibsql } from '../lib/libsql.js'
import { raiseActionQueueItem } from '../lib/action-queue.js'

const OUTBOX_LAG_WARN_THRESHOLD_DEFAULT = 100_000

/** Seconds of event retention kept even after all cursors have passed. */
const OUTBOX_MAX_AGE_SECONDS = 86_400 // 24 hours

/**
 * Query the events outbox at `dbPath` and return the overall lag
 * (`MAX(events.id) - COALESCE(MIN(subscribers.cursor), 0)`) along with the
 * name(s) of any subscriber(s) sitting at the minimum cursor.
 *
 * Returns `{ lag: 0, wedged: [] }` when no subscribers are registered.
 * Returns `{ lag, wedged: [] }` when `lag <= threshold`.
 * Returns `{ lag, wedged: [name, ...] }` when `lag > threshold`, where
 * `wedged` lists every subscriber whose cursor equals `MIN(cursor)`.
 */
export const detectOutboxLag = async (
  dbPath: string,
  threshold: number,
): Promise<{ lag: number; wedged: string[] }> => {
  const client = openLibsql({ url: `file:${dbPath}` })
  try {
    const subResult = await client.execute(
      'SELECT COUNT(*) AS cnt, COALESCE(MIN(cursor), 0) AS min_cursor FROM subscribers',
    )
    const subRow = subResult.rows[0] as unknown as {
      cnt: number | bigint
      min_cursor: number | bigint
    }
    const subCount = Number(subRow.cnt)
    if (subCount === 0) return { lag: 0, wedged: [] }

    const minCursor = Number(subRow.min_cursor)

    const headResult = await client.execute(
      'SELECT COALESCE(MAX(id), 0) AS head FROM events',
    )
    const head = Number(
      (headResult.rows[0] as unknown as { head: number | bigint }).head,
    )

    const lag = head - minCursor
    if (lag <= threshold) return { lag, wedged: [] }

    const wedgedResult = await client.execute({
      sql: 'SELECT name FROM subscribers WHERE cursor = ?',
      args: [minCursor],
    })
    const wedged = wedgedResult.rows.map(
      (r) => (r as unknown as { name: string }).name,
    )

    return { lag, wedged }
  } finally {
    client.close()
  }
}

/**
 * Sweep the events outbox: prune aged events, then raise a per-subscriber
 * action-queue item for any subscriber whose lag exceeds
 * `MARS_OUTBOX_LAG_WARN_THRESHOLD` (default: 100 000).
 *
 * The raise is idempotent: a second sweep with the same wedged subscriber
 * and an unresolved item bumps `seen_count` on the existing row rather than
 * inserting a duplicate (deduped on `signature = 'outbox-lag:<subscriber>'`).
 */
export const sweepOutbox = async (dbPath: string): Promise<void> => {
  const rawThreshold = Number.parseInt(
    process.env.MARS_OUTBOX_LAG_WARN_THRESHOLD ?? '',
    10,
  )
  const threshold = Number.isFinite(rawThreshold)
    ? rawThreshold
    : OUTBOX_LAG_WARN_THRESHOLD_DEFAULT

  await pruneOutbox(dbPath, OUTBOX_MAX_AGE_SECONDS)

  const { lag, wedged } = await detectOutboxLag(dbPath, threshold)

  for (const subscriber of wedged) {
    await raiseActionQueueItem({
      kind: 'outbox-lag',
      category: 'daemon',
      priority: 'high',
      title: `Outbox subscriber "${subscriber}" is wedged (lag: ${lag})`,
      body:
        `Subscriber "${subscriber}" has not advanced its cursor; events retention pruning is blocked. ` +
        `Lag: ${lag} (threshold: ${threshold}).`,
      payload: { subscriber, lag, threshold },
      context: {},
      raisedBy: 'outbox-sweeper',
      signature: `outbox-lag:${subscriber}`,
    })
  }
}
