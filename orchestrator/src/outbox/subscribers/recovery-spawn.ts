import type { Client } from '@libsql/client'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { ensureProcessedOnceSchema } from '../../bus/processed-once.js'
import { drainWithStall } from '../../core/daemon/subscriber-drain.js'
import { handleTaskFailureWithFixTask } from '../../core/queue-fix-tasks.js'
import { getTask } from '../../core/queue.js'

/**
 * Durable outbox subscriber that enforces exactly-one recovery per task
 * failure. Reacts to `task.failed` events and calls
 * `handleTaskFailureWithFixTask` so recovery spawning survives daemon
 * restarts — the side effect is durably gated by `processedOnce` inside
 * `drainWithStall`, making replay idempotent.
 *
 * Exactly-one guarantees:
 *  - A non-recovery task that fails spawns at most one fix task:
 *    `upsertFixTask`'s idempotent dedup prevents a second fix task even if
 *    both the inline workflow call and this subscriber run for the same event.
 *  - A recovery task that fails (`fixForTaskId != null`) is escalated to an
 *    actionQueue item; no second recovery is spawned (ADR-0040 leaf rule).
 *  - Replay of the same event id (cursor not yet advanced) hits
 *    `alreadyProcessed` inside `drainWithStall` and skips the handler.
 */
export const RECOVERY_SPAWN_SUBSCRIBER = 'recovery-spawner'

/**
 * Register the recovery-spawner subscriber and ensure the dedup schema
 * exists. `replay: false` so the cursor starts at the current outbox head on
 * first registration, observing only future events. Idempotent.
 */
export async function ensureRecoverySpawner(client: Client): Promise<void> {
  await ensureProcessedOnceSchema(client)
  await registerSubscriber(client, RECOVERY_SPAWN_SUBSCRIBER, { replay: false })
}

/**
 * Process every pending `task.failed` event the recovery-spawner has not yet
 * acknowledged. For each event, looks up the failing task and delegates to
 * `handleTaskFailureWithFixTask` which decides whether to:
 *  - spawn a fix task (outcome='blocked'), or
 *  - escalate to an actionQueue item (outcome='escalated' for recovery tasks,
 *    'no-recipe' when no registered recipe covers the failure signature).
 *
 * Per-event side effects are wrapped in `drainWithStall`'s at-most-once
 * machinery, so a crash between the handler running and the cursor advancing
 * leaves the dedup row in place — the next drain reads `alreadyProcessed` and
 * skips without re-spawning.
 *
 * @param client The libsql client carrying the outbox + subscriber tables.
 * @param log    Optional logger for per-event failures and stall notices.
 * @returns      The count of `task.failed` events whose side effect ran.
 */
export async function drainRecoverySpawner(
  client: Client,
  log?: (msg: string) => void,
): Promise<{ processed: number }> {
  return drainWithStall({
    client,
    subscriberId: RECOVERY_SPAWN_SUBSCRIBER,
    log,
    handle: async (event: BusEvent<EventName>) => {
      if (event.type !== 'task.failed') return false

      const { taskId, error } = event.payload as { taskId: string; error: string }
      const task = await getTask(taskId)
      if (!task) return false

      await handleTaskFailureWithFixTask({
        taskId,
        // Use the coarse-grained failed phase recorded on the task row as the
        // failingStep. Recovery task failures (fixForTaskId != null) escalate
        // before the signature is used for a recipe lookup, so any value here
        // is safe for that path. For non-recovery tasks the phase is used to
        // compute the signature; callers that need an exact step-level
        // signature should update failedPhase accordingly before failing.
        failingStep: task.failedPhase ?? '',
        errorOutput: error,
      })

      return true
    },
  })
}
