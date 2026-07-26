/**
 * Durable Outbox Subscriber: drives arc-outcome verification in response to
 * `task.terminal { reason: 'done' }` events.
 *
 * When the last task of an arc reaches `done` and the arc has at least one
 * commit on the integration branch, {@link triggerArcVerification} is called
 * (fire-and-forget). The verifier then runs a cheap haiku-tier Claude agent
 * against main to spot-check done criteria and verifyCmd results.
 *
 * Dedup is enforced at two layers:
 *   1. `processedOnce` inside `drainWithStall` ensures each outbox event is
 *      handled at-most-once per subscriber, even across daemon restarts.
 *   2. `triggeredOriginIds` in arc-verifier.ts ensures each arc is verified
 *      at most once per daemon lifetime (guards against multiple `task.terminal`
 *      events for tasks in the same arc).
 */

import type { DbClient } from '../../core/lib/db.js'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { drainWithStall } from '../../core/daemon/subscriber-drain.js'
import { resolveOriginIdForTask } from '../../core/lib/origin.js'
import { triggerArcVerification } from '../../core/lib/arc-verifier.js'
import { registerSubscriberName } from '../registry.js'
import { createTaskStore } from '../../core/store/task-store.js'
import { incrementRescueSuccess } from '../../core/daemon/kpi-store.js'

export const ARC_VERIFIER_SUBSCRIBER = 'arc-verifier'
registerSubscriberName(ARC_VERIFIER_SUBSCRIBER)

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

      // Increment rescue_success_total when an arc that had rescue attempts
      // transitions to arc-done (all tasks terminal, at least one done).
      // The sequential outbox drain guarantees this fires exactly once per
      // arc completion: prior events see in-progress; only the last done
      // event sees arc-done.
      const store = createTaskStore(client)
      const arcRescueAttempts = await store.getArcRescueAttempts(originId)
      if (arcRescueAttempts > 0) {
        const arcStatusResult = await store.arcStatus(originId)
        if (arcStatusResult.status === 'arc-done') {
          await incrementRescueSuccess(store)
        }
      }

      // triggerArcVerification handles dedup, flag-check, and concurrency.
      // It returns immediately; the actual verification runs asynchronously.
      const result = triggerArcVerification(originId, {
        cwd: process.env.MARS_REPO,
      })
      log?.(`[arc-verifier] ${originId}: ${result}`)
      return result === 'triggered'
    },
  })
}
