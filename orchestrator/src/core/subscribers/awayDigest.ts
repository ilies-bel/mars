/**
 * Away-digest subscriber — writes one `main_thread_entries` row of
 * `kind='away_digest'` for each away→present transition.
 *
 * Reacts to `presence.transition` outbox events published by `recordPing`
 * whenever the UI client returns after an idle gap that meets or exceeds the
 * configured threshold. For each transition the subscriber:
 *
 *   1. Calls `composeAwayDigest(fromMs, toMs, { loadEvents })` to narrate the
 *      away span. Returns early (no row) when `composeAwayDigest` returns null
 *      (empty span — nothing narrable happened while the operator was away).
 *   2. Inserts one `main_thread_entries` row keyed on `transition_id`.
 *      `ON CONFLICT (transition_id) DO NOTHING` makes the handler fully
 *      idempotent: if the subscriber fires twice for the same transition (e.g.
 *      a daemon restart replays the event), only one row is written.
 *
 * The `loadEvents` dependency is injected so the caller can supply either a
 * real DB-backed loader (production daemon) or a test double (unit tests).
 */

import type { DbClient } from '../lib/db.js'
import type { BusEvent } from '../../bus/events.js'
import type { Subscriber } from '../../outbox/dispatcher.js'
import { composeAwayDigest, type LoadEvents } from '../../narration/composeAwayDigest.js'
import { registerSubscriberName } from '../../outbox/registry.js'

/**
 * Unique name for the away-digest subscriber. Registered at module-init time
 * so the ghost-subscriber reconciler sees it without a central import list.
 */
export const AWAY_DIGEST_SUBSCRIBER = 'away-digest:presence.transition'
registerSubscriberName(AWAY_DIGEST_SUBSCRIBER)

/**
 * Build the Subscriber that turns each `presence.transition` event into one
 * `main_thread_entries` row.
 *
 * @param db          Shared DB client — used for the INSERT.
 * @param loadEvents  Loader for `NarrationEvent[]` over a time span. In
 *                    production the daemon passes a DB-backed implementation;
 *                    in tests a fake returns controlled fixtures.
 */
export function buildAwayDigestSubscriber(
  db: DbClient,
  loadEvents: LoadEvents,
): Subscriber {
  return {
    name: AWAY_DIGEST_SUBSCRIBER,
    handler: async (event: BusEvent): Promise<void> => {
      if (event.type !== 'presence.transition') return

      const { transitionId, fromMs, toMs } = event.payload as {
        transitionId: number
        fromMs: number
        toMs: number
      }

      const digest = await composeAwayDigest(fromMs, toMs, { loadEvents })
      if (digest === null) return

      await db.execute({
        sql: `INSERT INTO main_thread_entries (kind, transition_id, payload)
              VALUES ('away_digest', ?, ?)
              ON CONFLICT (transition_id) DO NOTHING`,
        args: [transitionId, JSON.stringify(digest)],
      })
    },
  }
}
