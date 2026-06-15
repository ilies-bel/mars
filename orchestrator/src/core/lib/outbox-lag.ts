import { openLibsql } from './libsql'
import { raiseActionQueueItem } from './action-queue'

/**
 * Outcome of a single lag check.  `lag` is `MAX(events.id) - MIN(subscribers.cursor)`
 * (always `0` when no subscribers are registered).  `raised` is `true` exactly
 * when this call resulted in a `raiseActionQueueItem` invocation; consult the
 * action-queue store for whether the row already existed and was deduped.
 */
export interface OutboxLagCheck {
  lag: number
  raised: boolean
}

/**
 * Inspect the events outbox at `dbPath` and raise (or dedupe) an action-queue
 * item when the lag between the newest event and the slowest durable subscriber
 * exceeds `threshold`.
 *
 * Behaviour:
 *   - Empty `subscribers` table → returns `{ lag: 0, raised: false }`.  No
 *     subscribers means no one is wedged; pruning will skip on its own gate.
 *   - `lag <= threshold` → returns `{ lag, raised: false }`.
 *   - `lag > threshold` → calls `raiseActionQueueItem` with the stable
 *     signature `'outbox-lag'`, so repeated calls with the lag still over
 *     threshold dedupe onto a single open row.
 *
 * The raised row's title and body include the actual lag count and the
 * threshold, so an operator can read the row directly without inspecting
 * the payload.
 */
export const checkOutboxLag = async (
  dbPath: string,
  threshold: number,
): Promise<OutboxLagCheck> => {
  const client = openLibsql({ url: `file:${dbPath}` })
  try {
    const headResult = await client.execute(
      'SELECT COALESCE(MAX(id), 0) AS head FROM events',
    )
    const head = Number(headResult.rows[0].head)

    const tailResult = await client.execute(
      'SELECT COALESCE(MIN(cursor), 0) AS tail, COUNT(*) AS sub_count FROM subscribers',
    )
    const subCount = Number(tailResult.rows[0].sub_count)
    if (subCount === 0) return { lag: 0, raised: false }

    const tail = Number(tailResult.rows[0].tail)
    const lag = head - tail

    if (lag <= threshold) return { lag, raised: false }

    await raiseActionQueueItem({
      kind: 'outbox-lag',
      category: 'daemon',
      priority: 'high',
      title: `Outbox lag ${lag} exceeds threshold ${threshold}`,
      body:
        `A durable subscriber is not advancing; events retention prune is blocked. ` +
        `Lag is ${lag} (head=${head}, tail=${tail}); threshold is ${threshold}.`,
      payload: { lag, threshold, head, tail },
      context: {},
      raisedBy: 'outbox-lag-detector',
      signature: 'outbox-lag',
    })

    return { lag, raised: true }
  } finally {
    client.close()
  }
}
