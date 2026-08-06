/**
 * Durable Outbox Subscriber: drives arc-outcome verification in response to
 * `task.terminal { reason: 'done' }` events.
 *
 * When the last task of an arc reaches `done` and the arc has at least one
 * commit on the integration branch, the origin is handed to the daemon's
 * arc-verifier dispatcher. The dispatcher owns concurrency, pause state, and
 * in-flight tracking before running a cheap haiku-tier agent against main.
 *
 * Dedup is enforced at two layers:
 *   1. `processedOnce` inside `drainWithStall` ensures each outbox event is
 *      handled at-most-once per subscriber, even across daemon restarts.
 *   2. The daemon dispatcher uses `triggeredOriginIds` in arc-verifier.ts to
 *      ensure each arc is admitted at most once per daemon lifetime.
 *
 * Arc origin types:
 *   - Task Arc: `origin_id` is a task id (self-rooted when `origin_id === id`).
 *     Single-task arcs complete in one `task.terminal` event; multi-task arcs
 *     (e.g. a task with recovery fix tasks) share the same `origin_id`.
 *   - Proposal Arc: `origin_id` is a proposal id. Produced by `mars proposal
 *     slice`, where every slice task carries `origin_id = proposalId`. The arc
 *     completes only when ALL slice tasks are terminal with at least one done.
 *
 * The subscriber gates dispatch on `arcStatus === 'arc-done'` so intermediate
 * done events for multi-task arcs (including Proposal Arcs) do not consume the
 * per-daemon-lifetime dedup slot prematurely. Only the event that makes the arc
 * fully settled triggers verification.
 */

import type { DbClient } from '../../core/lib/db.js'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { drainWithStall } from '../../core/daemon/subscriber-drain.js'
import { resolveOriginIdForTask } from '../../core/lib/origin.js'
import { registerSubscriberName } from '../registry.js'
import { createTaskStore } from '../../core/store/task-store.js'
import { incrementRescueSuccess } from '../../core/daemon/kpi-store.js'

export const ARC_VERIFIER_SUBSCRIBER = 'arc-verifier'
registerSubscriberName(ARC_VERIFIER_SUBSCRIBER)

export type ArcVerificationDispatchResult =
  | 'triggered'
  | 'skipped-disabled'
  | 'skipped-dedup'
  | 'skipped-paused'
  | 'skipped-capacity'

/**
 * Register the arc-verifier subscriber. Idempotent: re-registering an
 * existing subscriber preserves its cursor.
 */
export async function ensureArcVerifierSubscriber(client: DbClient): Promise<void> {
  await registerSubscriber(client, ARC_VERIFIER_SUBSCRIBER, {
    replay: false,
  })
}

/**
 * Drain all pending `task.terminal { reason: 'done' }` events and trigger
 * arc verification for any arc that has fully completed with merged commits.
 *
 * Implements the ADR-0032 stall contract via {@link drainWithStall}: a handler
 * failure blocks the cursor on the failing event and raises a
 * `subscriber-stalled` action-queue item after K consecutive failures.
 *
 * @returns The number of events that triggered a verification run.
 */
export async function drainArcVerifier(
  client: DbClient,
  dispatchArcVerification: (originId: string) => ArcVerificationDispatchResult,
  log?: (msg: string) => void,
): Promise<{ processed: number }> {
  return drainWithStall({
    client,
    subscriberId: ARC_VERIFIER_SUBSCRIBER,
    log,
    handle: async (event: BusEvent<EventName>) => {
      if (event.type !== 'task.terminal') return false
      const payload = event.payload as { taskId: string; reason: string }
      if (payload.reason !== 'done') return false

      // Resolve the arc origin id from the terminal task.
      const originId = await resolveOriginIdForTask(payload.taskId)

      const store = createTaskStore(client)

      // Check arc completion before doing anything. For multi-task arcs
      // (including Proposal Arcs where origin_id = proposalId), each slice
      // task fires a task.terminal event as it completes. The dedup set in
      // triggerArcVerification is per-daemon-lifetime — consuming the slot
      // on an intermediate event silently suppresses the final arc-done
      // trigger. By gating here, the slot is only consumed once: on the
      // event that makes the arc fully settled.
      const arcStatusResult = await store.arcStatus(originId)
      if (arcStatusResult.status !== 'arc-done') return false

      // Increment rescue_success_total when an arc that had rescue attempts
      // transitions to arc-done (all tasks terminal, at least one done).
      // The guard above guarantees we only reach this when arc-done.
      const arcRescueAttempts = await store.getArcRescueAttempts(originId)
      if (arcRescueAttempts > 0) {
        await incrementRescueSuccess(store)
      }

      // The daemon dispatcher owns admission and execution. The outbox handler
      // must never spawn a provider directly: that would bypass pause/status.
      const result = dispatchArcVerification(originId)
      log?.(`[arc-verifier] ${originId}: ${result}`)
      return result === 'triggered'
    },
  })
}
