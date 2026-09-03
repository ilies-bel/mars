import type { DbClient } from '../../core/lib/db.js'
import type { BusEvent, EventName } from '../../bus/events.js'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { registerSubscriber } from '../../bus/subscribers.js'
import { drainWithStall } from '../../core/daemon/subscriber-drain.js'
import { getTask } from '../../core/queue.js'
import { raiseActionQueueItem } from '../../core/lib/action-queue.js'
import { registerSubscriberName } from '../registry.js'
import { integrationBranchName } from '../../core/lib/blocker-resolution-primitives.js'

const execFileP = promisify(execFile)

/**
 * Durable outbox subscriber that raises an action-queue row when a fix
 * (recovery) task is manually dropped rather than reaching a terminal verdict
 * through the normal exhaustion path.
 *
 * When a fix task (fix_for_task_id IS NOT NULL) reaches `dropped`, the
 * operator cancelled it before the automated recovery ran to completion.
 * The origin's single recovery slot is effectively forfeited and no
 * action-queue item would otherwise appear — without this subscriber the origin
 * sits silently with no context on how to proceed.
 *
 * This subscriber fires on `task.terminal { reason: 'dropped' }` events,
 * filters for rows where fixForTaskId is non-null, loads the origin task, and
 * suppresses if the origin is not in `failed` status (the resolution verbs only
 * apply to failed tasks). When the origin is failed it raises a
 * `recovery-abandoned` action-queue item against it so the operator sees a
 * clear call to action with the correct resolution verbs.
 *
 * The `mars restart` advice is qualified when the origin's branch has commits
 * ahead of the integration branch — the operator is warned that those commits
 * would be permanently discarded and is directed to `mars remerge` first.
 *
 * The `task.failed` route (recovery exhausted) is handled separately by
 * `recovery-spawn.ts` and `queue-fix-tasks.ts`; those paths are left untouched
 * so the two subscribers do not race.
 */
export const RECOVERY_ABANDONED_SUBSCRIBER = 'recovery-abandoned'
registerSubscriberName(RECOVERY_ABANDONED_SUBSCRIBER)

/**
 * Register the recovery-abandoned subscriber. `replay: false` so the cursor
 * starts at the current outbox head on first registration, observing only
 * future events. Idempotent.
 */
export async function ensureRecoveryAbandonedSubscriber(client: DbClient): Promise<void> {
  await registerSubscriber(client, RECOVERY_ABANDONED_SUBSCRIBER, { replay: false })
}

/**
 * Process every pending `task.terminal { reason: 'dropped' }` event for a fix
 * task. For each such event:
 *  - Load the dropped task row.
 *  - Early-return if `fixForTaskId` is null (a non-fix task being dropped is not
 *    a recovery-abandonment; no action needed).
 *  - Load the origin task. Early-return if the origin is not in `failed` status —
 *    `mars continue` / `mars restart` only apply to failed tasks, so raising the
 *    item for any other origin status would prescribe an invalid action.
 *  - Count commits on the origin's branch ahead of the integration branch. When
 *    commits exist, the `mars restart` advice is qualified with a warning that
 *    those commits would be permanently discarded, directing the operator to
 *    `mars remerge` or `mars continue` first.
 *  - Raise a `recovery-abandoned` action-queue item against the origin so the
 *    operator knows the recovery was manually cancelled.
 *
 * Per-event side effects are wrapped in `drainWithStall`'s at-most-once
 * machinery, so a crash between the handler running and the cursor advancing
 * leaves the dedup row in place — the next drain reads `alreadyProcessed` and
 * skips without re-raising.
 *
 * @param client  The DB client carrying the outbox + subscriber tables.
 * @param log     Optional logger for per-event progress messages.
 * @returns       The count of `task.terminal` events whose side effect ran.
 */
export async function drainRecoveryAbandoned(
  client: DbClient,
  log?: (msg: string) => void,
): Promise<{ processed: number }> {
  return drainWithStall({
    client,
    subscriberId: RECOVERY_ABANDONED_SUBSCRIBER,
    log,
    handle: async (event: BusEvent<EventName>) => {
      if (event.type !== 'task.terminal') return false
      const payload = event.payload as { taskId: string; reason: string }
      if (payload.reason !== 'dropped') return false

      const fixTask = await getTask(payload.taskId)
      if (!fixTask) return false
      if (fixTask.fixForTaskId === null) return false

      const originId = fixTask.fixForTaskId

      // Suppress when the origin is not in `failed` status. The resolution
      // verbs (mars continue / mars restart) only apply to failed tasks —
      // raising the item for a done, dropped, or still-running origin would
      // prescribe an action the status guard would reject.
      const originTask = await getTask(originId)
      if (!originTask || originTask.status !== 'failed') return false

      // Count commits on the origin's branch ahead of the integration branch so
      // the body can qualify the `mars restart` advice when the operator would
      // be permanently discarding real work. Best-effort: a failed probe (no
      // branch, missing worktree, git unavailable) falls through to the plain
      // restart advice with no commit qualifier.
      let commitsAhead: number | null = null
      const integration = integrationBranchName()
      if (originTask.branch) {
        try {
          const { stdout } = await execFileP(
            'git',
            ['rev-list', '--count', `${integration}..${originTask.branch}`],
            { cwd: process.cwd() },
          )
          const count = Number.parseInt(stdout.trim(), 10)
          commitsAhead = Number.isFinite(count) ? count : null
        } catch {
          // best-effort; omit commit qualifier when the git probe fails
        }
      }

      const restartAdvice =
        commitsAhead !== null && commitsAhead > 0
          ? `⚠ The origin branch has ${commitsAhead} commit(s) ahead of ` +
            `${integration} — \`mars restart ${originId}\` will permanently ` +
            `discard that work. Run \`mars remerge ${originId}\` to land those ` +
            `commits first, or \`mars continue ${originId}\` to resume on the ` +
            `existing branch.`
          : `run \`mars restart ${originId}\` to wipe and re-run from scratch.`

      const body =
        `Recovery task ${fixTask.id} was manually dropped, not exhausted. ` +
        `Run \`mars continue ${originId}\` to resume on the existing worktree, or ` +
        restartAdvice

      await raiseActionQueueItem({
        kind: 'recovery-abandoned',
        category: 'orchestrator',
        priority: 'high',
        title: 'Recovery task dropped',
        body,
        payload: { fixTaskId: fixTask.id, originTaskId: originId },
        context: {},
        raisedBy: `outbox:${RECOVERY_ABANDONED_SUBSCRIBER}`,
        signature: `recovery-abandoned:${originId}`,
        originTaskId: originId,
      })

      log?.(
        `[recovery-abandoned] raised action-queue row for origin ${originId} ` +
          `(fix task ${fixTask.id} was manually dropped)`,
      )
      return true
    },
  })
}
