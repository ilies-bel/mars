import type { DbClient } from '../../core/lib/db.js'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { drainWithStall } from '../../core/daemon/subscriber-drain.js'
import {
  handleTaskFailureWithFixTask,
  hasUsableWorktree,
} from '../../core/queue-fix-tasks.js'
import { getTask, updateTask } from '../../core/queue.js'
import { apiCircuitBreaker } from '../../core/lib/api-circuit-breaker.js'
import { asStepId, UNKNOWN_STEP_ID } from '../../core/lib/failure-signature.js'
import { registerSubscriberName } from '../registry.js'
import { raiseActionQueueItem } from '../../core/lib/action-queue.js'
import { loadSpendControl } from '../../core/daemon/spend-control/store.js'
import { decideDispatchControl } from '../../core/daemon/spend-control/decide.js'
import { probeSpendWindow } from '../spend-control-inputs.js'

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
 * never consumed.
 */
export const RECOVERY_SPAWN_SUBSCRIBER = 'recovery-spawner'
registerSubscriberName(RECOVERY_SPAWN_SUBSCRIBER)

/**
 * Register the recovery-spawner subscriber. `replay: false` so the cursor
 * starts at the current outbox head on first registration, observing only
 * future events. Idempotent.
 */
export async function ensureRecoverySpawner(client: DbClient): Promise<void> {
  await registerSubscriber(client, RECOVERY_SPAWN_SUBSCRIBER, { replay: false })
}

/**
 * Callback invoked by {@link drainRecoverySpawner} when the
 * signature-storm circuit breaker trips for the first time in an episode.
 * The daemon passes a closure that calls `setIsPaused(true)` and spawns
 * the steward (`investigateWorktree`).
 *
 * `alreadyTripped=false` is guaranteed when this callback fires — it is
 * only called on the first trip, not on subsequent observations of the
 * same tripped episode.
 */
export type SignatureStormTripCallback = (opts: {
  signature: string
  streak: number
  lastTaskId: string
}) => void

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
 * @param client          The DB client carrying the outbox + subscriber tables.
 * @param log             Optional logger for per-event failures and stall notices.
 * @param onStormTripped  Optional daemon-side callback: called (exactly once per
 *                        storm episode) when the signature-storm circuit breaker
 *                        first trips. The callback should pause dispatch and
 *                        spawn the steward. Idempotency is guaranteed by the
 *                        persistent `tripped` flag in `failure_signature_streak`.
 * @returns               The count of `task.failed` events whose side effect ran.
 */
export async function drainRecoverySpawner(
  client: DbClient,
  log?: (msg: string) => void,
  onStormTripped?: SignatureStormTripCallback,
): Promise<{ processed: number }> {
  return drainWithStall({
    client,
    subscriberId: RECOVERY_SPAWN_SUBSCRIBER,
    log,
    handle: async (event: BusEvent<EventName>) => {
      if (event.type !== 'task.failed') return false

      const { taskId, error, note } = event.payload as { taskId: string; error: string; note?: string }
      const task = await getTask(taskId)
      if (!task) return false

      // Failures that happen before setup have no origin worktree for a fix
      // task to reuse. Route them directly through the shared escalation before
      // spend-control or outage gates can produce a less actionable notice.
      if (
        task.status === 'failed' &&
        task.fixForTaskId === null &&
        !(await hasUsableWorktree(task))
      ) {
        const failingStep =
          asStepId(task.failureReason) ?? asStepId(task.failedPhase) ?? UNKNOWN_STEP_ID
        await handleTaskFailureWithFixTask({
          taskId,
          failingStep,
          errorOutput: error,
          qaNote: note,
        })
        return true
      }

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

      // Spend-control suppression gate: consult the persisted dispatch spend
      // controller. When suppressRecovery is true (operator lever set, spend
      // pressure, or too many recent recovery failures), skip fix-task spawn,
      // land the origin as failed, and raise a task-blocked action-queue item
      // so the operator knows budget pressure prevented self-heal. This
      // preserves the origin's single recovery slot for when pressure clears.
      const [levers, spendWindow] = await Promise.all([
        loadSpendControl(client),
        probeSpendWindow(client, false),
      ])
      const decision = decideDispatchControl({
        spendWindow,
        breaker: { open: false, reason: null, openedAt: null },
        health: { recentRecoveryFailures: 0 },
        levers,
        nowMs: Date.now(),
      })

      if (decision.suppressRecovery) {
        const suppressionReason = `spend-control suppression: ${decision.reason}`
        await updateTask(taskId, {
          status: 'failed',
          failureReason: suppressionReason,
        })
        await raiseActionQueueItem({
          kind: 'failed',
          category: 'orchestrator',
          priority: 'high',
          title: `Task ${taskId} recovery suppressed by spend controller`,
          body:
            `Recovery for task ${taskId} was suppressed by the dispatch spend controller. ` +
            `Reason: ${decision.reason}. ` +
            `The task is left in a failed/restartable state — restart it once spend pressure clears ` +
            `or after adjusting the controller levers (\`mars spend-control set\`).`,
          payload: { taskId, suppressedBy: 'spend-control', reason: decision.reason },
          context: { suppressedBy: 'spend-control', reason: decision.reason },
          raisedBy: 'recovery-spawn:spend-control-gate',
          signature: `spend-control-suppressed:${taskId}`,
          originTaskId: taskId,
        })
        log?.(`recovery suppressed by spend controller: ${decision.reason}`)
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
      //
      // `asStepId` validates the step-id grammar (lower-case, digits, hyphens,
      // colon-separated segments). Terminal paths such as requeue-ceiling write
      // prose to `failure_reason`; `asStepId` returns null for those, falling
      // back to `failed_phase` (also validated) or `UNKNOWN_STEP_ID` so no
      // prose ever reaches `computeFailureSignature` as the step half.
      const failingStep =
        asStepId(task.failureReason) ?? asStepId(task.failedPhase) ?? UNKNOWN_STEP_ID

      // Gate meta-monitor suppression AND signature-storm circuit breaker both
      // live INSIDE handleTaskFailureWithFixTask (the shared chokepoint) so they
      // apply to the inline verify dispatch too, which fires before this
      // subscriber does — see the module docblock.
      const result = await handleTaskFailureWithFixTask({
        taskId,
        failingStep,
        errorOutput: error,
        // Carry the optional QA note from the `task.failed` event through to
        // the fix-task prompt so the recovery agent sees the operator feedback.
        qaNote: note,
      })

      // When the signature-storm circuit breaker first trips, signal the
      // daemon-side caller so it can pause dispatch and spawn the steward.
      // The `alreadyTripped` guard inside handleTaskFailureWithFixTask ensures
      // this outcome fires exactly once per storm episode, even across drains.
      if (result.outcome === 'signature-storm-tripped' && onStormTripped) {
        onStormTripped({
          signature: result.failureSignature ?? failingStep,
          streak: result.stormStreak ?? 0,
          lastTaskId: taskId,
        })
      }

      return true
    },
  })
}
