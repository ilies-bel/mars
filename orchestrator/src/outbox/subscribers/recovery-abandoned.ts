import type { DbClient } from '../../core/lib/db.js'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { drainWithStall } from '../../core/daemon/subscriber-drain.js'
import { getTask } from '../../core/queue.js'
import { raiseActionQueueItem } from '../../core/lib/action-queue.js'
import { registerSubscriberName } from '../registry.js'
import { integrationBranchName } from '../../core/lib/blocker-resolution-primitives.js'
import { getRepoRoot } from '../../core/context.js'
import { listUniqueCommitsAhead, type OrphanCommit } from '../../core/lib/sweep.js'
import { SALVAGE_CHECKPOINT_SUBJECT_PREFIX } from '../../core/lib/git/checkpoint.js'
import { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } from '../../core/lib/main-commiter-payload.js'
import { raiseOrphanedCheckpointRow } from '../../core/daemon/main-dirty-action-queue.js'

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

      // Special case — `main-commiter` recoveries: their role is to commit the
      // integration branch's dirty state, not to deliver the origin task's work.
      // When a committer is dropped, the origin is in `blocked` status (not
      // `failed`), so the generic origin-status guard below would silently skip
      // this event.  But the committer may have already captured the operator's
      // uncommitted edits into `refs/mars/checkpoint/<committerTaskId>` before
      // being dropped — those edits are invisible on the integration branch and
      // there is no other notification path.  Surface the checkpoint ref here so
      // the operator knows where their work went.
      const committerPayload = parseMainCommiterPayload(fixTask.recoveryPayload ?? null)
      if (committerPayload?.recipe === MAIN_COMMITER_RECIPE) {
        const itemId = await raiseOrphanedCheckpointRow(fixTask.id, (msg) => log?.(msg))
        if (itemId !== null) {
          log?.(
            `[recovery-abandoned] main-committer ${fixTask.id} dropped; raised orphaned-checkpoint row ${itemId}`,
          )
        }
        // Return true whether or not a checkpoint existed: the event was a
        // valid main-committer drop and we handled it (even if silently).
        return true
      }

      const originId = fixTask.fixForTaskId

      // Suppress when the origin is not in `failed` status. The resolution
      // verbs (mars continue / mars restart) only apply to failed tasks —
      // raising the item for a done, dropped, or still-running origin would
      // prescribe an action the status guard would reject.
      const originTask = await getTask(originId)
      if (!originTask || originTask.status !== 'failed') return false

      // List commits on the origin's branch ahead of the integration branch and
      // classify them as real (operator-authored) vs salvage-checkpoint commits.
      // Best-effort: a failed probe (no branch, missing worktree, git unavailable)
      // falls through to the plain restart advice with no commit qualifier.
      const integration = integrationBranchName()
      let commits: OrphanCommit[] = []
      if (originTask.branch) {
        try {
          commits = await listUniqueCommitsAhead(originTask.branch, integration, getRepoRoot())
        } catch {
          // best-effort; omit commit qualifier when the git probe fails
        }
      }

      const realCommits = commits.filter(
        (c) => !c.subject.startsWith(SALVAGE_CHECKPOINT_SUBJECT_PREFIX),
      )
      const checkpointCommits = commits.filter((c) =>
        c.subject.startsWith(SALVAGE_CHECKPOINT_SUBJECT_PREFIX),
      )
      const formatCommitList = (cs: OrphanCommit[]) =>
        cs.map((c) => `  ${c.shortSha} ${c.subject}`).join('\n')

      let escapeTail: string
      if (realCommits.length > 0) {
        escapeTail =
          `\n\nThe origin branch has ${realCommits.length} real commit(s) ahead of ` +
          `${integration}:\n${formatCommitList(realCommits)}\n\n` +
          `Run \`mars remerge ${originId}\` to land those commits first.`
      } else if (checkpointCommits.length > 0) {
        escapeTail =
          `\n\nThe origin branch has only salvage-checkpoint commit(s) ahead of ` +
          `${integration}:\n${formatCommitList(checkpointCommits)}\n\n` +
          `Run \`mars task add --supersede ${originId}\` to create a new task on this branch.`
      } else {
        escapeTail = ` or run \`mars restart ${originId}\` to wipe and re-run from scratch.`
      }

      const body =
        `Recovery task ${fixTask.id} was manually dropped, not exhausted. ` +
        `Run \`mars continue ${originId}\` to resume on the existing worktree.` +
        escapeTail

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
