import type { Client } from '@libsql/client'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { ensureProcessedOnceSchema } from '../../bus/processed-once.js'
import { drainWithStall } from '../../core/daemon/subscriber-drain.js'
import { handleTaskFailureWithFixTask } from '../../core/queue-fix-tasks.js'
import { getTask, updateTask } from '../../core/queue.js'
import { ensureGateMetaMonitorSchema } from '../../core/lib/gate-meta-monitor.js'
import { apiCircuitBreaker } from '../../core/lib/api-circuit-breaker.js'

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
 *
 * Gate meta-monitor suppression (draft proposal acd01d23): the verdict-tracking
 * and suppression short-circuit live one layer down, inside
 * {@link handleTaskFailureWithFixTask} — the shared chokepoint that both this
 * durable subscriber AND the inline verify-primitive dispatch funnel through.
 * Placing the gate there (not here) makes suppression authoritative regardless
 * of which path fires first: a suppressed verify-gate verdict marks its origin
 * `failed` (restartable) and spawns NO recovery, so the one recovery slot is
 * never consumed. This subscriber only ensures the monitor's schema exists.
 */
export const RECOVERY_SPAWN_SUBSCRIBER = 'recovery-spawner'

/**
 * Register the recovery-spawner subscriber and ensure the dedup schema
 * exists. `replay: false` so the cursor starts at the current outbox head on
 * first registration, observing only future events. Idempotent.
 */
export async function ensureRecoverySpawner(client: Client): Promise<void> {
  await ensureProcessedOnceSchema(client)
  await ensureGateMetaMonitorSchema(client)
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

      // If the API circuit breaker is open — or was opened within a 60 s grace
      // window — this failure is environmental, not a code or verify bug. Skip
      // the fix-task insert and re-queue the origin so it retries once the
      // outage clears, preserving its single recovery slot for a real failure.
      const breaker = apiCircuitBreaker.state()
      const GRACE_MS = 60_000
      const isEnvironmental =
        breaker.open ||
        (breaker.openedAt !== null && Date.now() - breaker.openedAt < GRACE_MS)

      if (isEnvironmental) {
        await updateTask(taskId, { status: 'queued' })
        log?.('requeued (environmental outage), recovery slot spared')
        return true
      }

      // Prefer the FINE-grained failing step the verify primitive stamped on
      // `failure_reason` (`verify:<gate>`) over the coarse `failed_phase`
      // (`verify`). This matters for the gate meta-monitor: its verify-gate
      // gate keys on a `verify:`-prefixed step, and using the fine step also
      // makes the signature this path computes match the one the verify
      // primitive already stamped, so `upsertFixTask`'s (taskId, signature)
      // dedup agrees across the inline and durable dispatch paths. Recovery
      // task failures (fixForTaskId != null) escalate before the signature is
      // used for a recipe lookup, so the exact value is safe for that path too.
      const failingStep = task.failureReason ?? task.failedPhase ?? ''

      // Gate meta-monitor suppression lives INSIDE handleTaskFailureWithFixTask
      // (the shared chokepoint) so it applies to the inline verify dispatch too,
      // which fires before this subscriber does — see the module docblock.
      await handleTaskFailureWithFixTask({
        taskId,
        failingStep,
        errorOutput: error,
      })

      return true
    },
  })
}
