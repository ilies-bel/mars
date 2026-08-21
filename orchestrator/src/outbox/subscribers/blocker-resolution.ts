import type { DbClient } from '../../core/lib/db.js'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { Arc } from '../../core/arc.js'
import { drainWithStall } from '../../core/daemon/subscriber-drain.js'
import { registerSubscriberName } from '../registry.js'
import { updateTask } from '../../core/queue.js'
import { runDiagnoseFollowup } from '../../core/lib/diagnose-followup.js'
import { RESCUE_OPERATOR_TAG } from '../../core/rescue-operator-spawn.js'

/**
 * Durable Outbox Subscriber: drives blocked-task unblocking in response to
 * `task.terminal { reason: 'done' }` events (ADR-0030/0031).
 *
 * This replaces the boot-time `recoverBlockedTasks` scan. Because the subscriber
 * holds a persistent cursor, any `task.terminal` events that were committed to
 * the outbox while the daemon was offline are replayed on the next drain — a
 * daemon crash between a blocker reaching `done` and its dependents being
 * unblocked is therefore automatically recovered on restart without a
 * full-table scan.
 *
 * On first registration the cursor is placed at the current outbox head (no
 * replay), so pre-existing events from before the subscriber was wired are not
 * re-processed. Re-registration is idempotent — the cursor is never reset.
 */
export const BLOCKER_RESOLUTION_SUBSCRIBER = 'blocker-resolution'
registerSubscriberName(BLOCKER_RESOLUTION_SUBSCRIBER)

/**
 * Register the blocker-resolution subscriber. Idempotent: re-registering an
 * existing subscriber preserves its cursor.
 */
export async function ensureBlockerResolutionSubscriber(client: DbClient): Promise<void> {
  await registerSubscriber(client, BLOCKER_RESOLUTION_SUBSCRIBER, {
    replay: false,
  })
}

/**
 * Cancel any queued or running fix/rescue tasks that were spawned for
 * `originId` now that the origin has reached `done`.
 *
 * - Queued tasks are dropped immediately (status → 'dropped', dropReason →
 *   'origin-succeeded'). This removes them from the dispatch queue before the
 *   drain loop can pick them up.
 * - Running tasks cannot be stopped from within the subscriber (stopping
 *   requires the in-memory `tracker.abort()` in server.ts). Their IDs are
 *   passed to `onCancelInFlight` so the caller can abort them.
 *
 * Best-effort: a failure to drop/report one task is logged but does not block
 * the others. The dispatch-time guard in the drain loop is the primary
 * correctness gate; this function is belt-and-suspenders for tasks that were
 * queued or dispatched concurrently.
 */
async function cancelStaleRecoveriesForOrigin(
  client: DbClient,
  originId: string,
  onCancelInFlight: ((taskId: string) => void) | undefined,
  log: ((msg: string) => void) | undefined,
): Promise<void> {
  // Active (non-terminal) statuses split into those we can drop here vs those
  // that need an in-memory abort signal.
  const DROPPABLE_STATUSES = ['queued', 'blocked']
  const IN_FLIGHT_STATUSES = ['running', 'verifying', 'merging', 'vega-reconciling']
  const ACTIVE_STATUSES = [...DROPPABLE_STATUSES, ...IN_FLIGHT_STATUSES]

  const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ')

  // Find all active fix tasks and rescue tasks for this origin.
  // Fix tasks: kind='fix', origin_id = originId — covers BOTH direct fix tasks
  //   (fix_for_task_id = arcRootId, origin_id = arcRootId) AND fix tasks that
  //   target a rescue-operator (fix_for_task_id = rescueTaskId, origin_id = arcRootId).
  //   All fix tasks inherit origin_id from their source task, so using origin_id
  //   as the discriminant captures the full arc without a sub-query.
  // Rescue tasks: origin_id = originId, tagged 'rescue-operator' (kind='task')
  //
  // The tags_json column stores a JSON array as text; use LIKE to detect the
  // rescue-operator tag (consistent with arc.ts listArcMembers query at line 1925).
  const tagPattern = `%${RESCUE_OPERATOR_TAG}%`
  const { rows } = await client.execute({
    sql: `
      SELECT t.id, t.status
        FROM tasks t
       WHERE t.status IN (${placeholders})
         AND (
               (t.kind = 'fix' AND t.origin_id = ? AND t.id != ?)
               OR
               (t.origin_id = ? AND t.id != ? AND t.tags_json LIKE ?)
             )`,
    args: [...ACTIVE_STATUSES, originId, originId, originId, originId, tagPattern],
  })

  for (const row of rows) {
    const taskId = (row as unknown as { id: string; status: string }).id
    const status = (row as unknown as { id: string; status: string }).status

    if (DROPPABLE_STATUSES.includes(status)) {
      try {
        await updateTask(taskId, {
          status: 'dropped',
          dropReason: 'origin-succeeded',
          error: `Origin ${originId} reached done; stale recovery cancelled`,
        })
        log?.(
          `[blocker-resolution] dropped stale recovery ${taskId} (status=${status}): origin ${originId} done`,
        )
      } catch (err) {
        // Best-effort: a concurrent transition (e.g., the dispatch loop
        // dropping it simultaneously) is benign. Log and continue.
        log?.(
          `[blocker-resolution] could not drop stale recovery ${taskId}: ${
            (err as Error).message
          }`,
        )
      }
    } else if (IN_FLIGHT_STATUSES.includes(status)) {
      // The task is already running — signal the daemon's tracker to abort it.
      // The daemon will mark it failed with failureReason='cancelled' so that
      // handleTaskFailureWithFixTask skips re-spawning a new recovery.
      onCancelInFlight?.(taskId)
      log?.(
        `[blocker-resolution] signalling abort for in-flight recovery ${taskId} (status=${status}): origin ${originId} done`,
      )
    }
  }
}

/**
 * Drain all pending `task.terminal` events and settle whatever was waiting on
 * the completing task:
 *
 *  - `reason: 'done'` / `reason: 'dropped'` → unblock any dependent whose every
 *    blocker has now SETTLED (`Arc.unblockByCompletion`). `dropped` is terminal
 *    and can never become `done`, so a dependent left waiting on a dropped
 *    blocker is stranded permanently — the same class of bug as a stranded
 *    origin, and the same reason the operator had to run `mars unblock` by
 *    hand. Dropping is an explicit "this work is not happening" decision that
 *    raises no action-queue row to resolve (ADR-0028 closes rows on `dropped`),
 *    so parking dependents would give the operator nothing to act on; the
 *    row-deleting sibling `Arc.drop` already releases dependents inline.
 *  - `reason: 'done'` on a diagnose Chore → the generic unblock loop is
 *    bypassed by the Arc aggregate (`diagnoseVerdictPending`) and the
 *    verdict-driven branch runs here instead (`runDiagnoseFollowup`): read the
 *    recorded verdict and either dispatch exactly one fix attempt (root-cause)
 *    or raise exactly one action-queue item (inconclusive / no-verdict). The
 *    Chore's parent is never re-queued blindly — the verdict owns that call.
 *  - `reason: 'purged'` → ignored. `Arc.drop` emits it immediately before
 *    `DELETE FROM tasks` and has already released dependents in that same
 *    transaction.
 *  - `reason: 'failed'` → when the failing task is a recovery Chore, fail the
 *    ORIGIN it was spawned for (`Arc.failStrandedOriginOnRecoveryFailure`).
 *    A recovery is a leaf that is never re-run (ADR-0040), so its origin's one
 *    blocker edge can never resolve; leaving the origin in `blocked` stranded
 *    it permanently — `blocked` is not terminal, so neither `mars purge` nor
 *    `mars restart` would accept it. Only the origin↔its-own-recovery edge is
 *    settled here: an ordinary failed blocker still leaves its dependents
 *    waiting in `blocked` (unchanged behaviour).
 *  - `reason: 'done'` on an ORIGIN task → any queued or running fix/rescue tasks
 *    that were spawned for that origin are cancelled. Queued tasks are dropped
 *    immediately; running tasks are passed to `opts.onCancelInFlightRecovery` so
 *    the daemon can abort them via `tracker.abort()`.
 *
 * Implements the ADR-0032 stall contract via {@link drainWithStall}: a handler
 * failure blocks the cursor on the failing event and raises a
 * `subscriber-stalled` action-queue item after K consecutive failures.
 *
 * @returns The number of events that resulted in at least one state change.
 */
export async function drainBlockerResolution(
  client: DbClient,
  log?: (msg: string) => void,
  opts?: {
    /**
     * Called for each in-flight (running/verifying/merging) fix or rescue task
     * whose origin just reached `done`. The daemon passes `(id) => tracker.abort(id)`
     * here so those tasks are stopped immediately rather than running to completion
     * against an arc that no longer needs recovery.
     *
     * No-op when omitted (e.g. in tests that only exercise the drop path).
     */
    onCancelInFlightRecovery?: (taskId: string) => void
  },
): Promise<{ processed: number }> {
  return drainWithStall({
    client,
    subscriberId: BLOCKER_RESOLUTION_SUBSCRIBER,
    log,
    handle: async (event: BusEvent<EventName>) => {
      if (event.type !== 'task.terminal') return false
      const payload = event.payload as { taskId: string; reason: string }

      if (payload.reason === 'failed') {
        const dead = await Arc.failStrandedOriginOnRecoveryFailure(payload.taskId)
        const failed = dead.outcomes.filter((o) => o.outcome === 'failed')
        for (const o of failed) {
          log?.(
            `origin ${o.originTaskId} failed: its recovery ${o.recoveryTaskId} failed (ADR-0040 leaf)`,
          )
        }
        return failed.length > 0
      }

      if (payload.reason !== 'done' && payload.reason !== 'dropped') return false

      const result = await Arc.unblockByCompletion(payload.taskId)

      // Diagnose Chore verdict branch (PRD 06e677fb). The Arc aggregate
      // bypasses the generic unblock loop for a `done` diagnose Chore and
      // reports the bypass; running the verdict-driven branch — which reads
      // the structured verdict and either dispatches exactly one fix attempt
      // or raises exactly one action-queue item — is this subscriber's job.
      // Best-effort: a follow-up failure must not mask the Chore's done event
      // or block the cursor.
      if (result.diagnoseVerdictPending) {
        try {
          const outcome = await runDiagnoseFollowup(payload.taskId)
          log?.(
            `[diagnose] chore ${payload.taskId}: ${outcome.verdictKind} verdict -> ${outcome.action}`,
          )
          return outcome.action !== 'noop'
        } catch (err) {
          log?.(
            `[diagnose] chore ${payload.taskId}: follow-up errored (non-fatal): ${
              (err as Error).message
            }`,
          )
          return false
        }
      }

      // When an origin itself reaches `done`, cancel any queued or running
      // fix/rescue tasks that were spawned for it. This handles the race where
      // the origin succeeds (e.g. via auto-remerge) between when the recovery
      // was enqueued/dispatched and when it actually starts coding.
      //
      // Runs best-effort: errors are logged but do not block the cursor.
      // The dispatch-time guard in server.ts drain() is the primary gate;
      // this subscriber-side cancellation is belt-and-suspenders for tasks
      // that were already past the dispatch check.
      if (payload.reason === 'done') {
        await cancelStaleRecoveriesForOrigin(
          client,
          payload.taskId,
          opts?.onCancelInFlightRecovery,
          log,
        ).catch((err) => {
          log?.(
            `[blocker-resolution] cancelStaleRecoveriesForOrigin(${payload.taskId}) threw (non-fatal): ${
              (err as Error).message
            }`,
          )
        })
      }

      return result.outcomes.some(
        (o) => o.outcome === 'queued' || o.outcome === 'failed' || o.outcome === 'done-via-recovery',
      )
    },
  })
}
