/**
 * Periodic sweep that raises a `stale-worktree` actionQueue item for every
 * non-terminal task whose worktree directory has not been updated within
 * the configurable threshold (default: 24 h, `MARS_STALE_WORKTREE_HOURS`).
 *
 * Deduplication is origin-keyed: `raiseActionQueueItem` with `originTaskId` ensures
 * that re-detecting the same stale worktree on a subsequent sweep bumps the
 * existing open item (seen_count++) rather than inserting a sibling row.
 *
 * Auto-close is handled by the existing `dismissAlertsOnStatusChange` hook
 * in queue.ts — every real status transition on the task (to done, failed,
 * dropped, or back to queued after reconcile) closes any open actionQueue item
 * keyed to that origin task id.
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { listTasks } from '../queue'
import { raiseActionQueueItem } from '../lib/action-queue'
import type { ActionQueueKind } from '../lib/action-queue-kinds'
import { getDefaultMergeJobStore } from '../store/merge-job-store'

export const STALE_WORKTREE_KIND: ActionQueueKind = 'stale-worktree'

const DEFAULT_THRESHOLD_HOURS = 24

const resolveThresholdHours = (): number => {
  const raw = process.env.MARS_STALE_WORKTREE_HOURS
  if (!raw) return DEFAULT_THRESHOLD_HOURS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_THRESHOLD_HOURS
}

/**
 * Build the stale-worktree actionQueue item body. Describes the stale state only;
 * the recovery verbs (Investigate / Prune) are the card's action buttons.
 * Exported so tests can verify the exact template content without coupling
 * to the surrounding raise logic.
 */
export const buildNextActionBody = (
  taskId: string,
  ageHours: number,
  status: string,
): string =>
  `Task ${taskId} has a stale worktree (status: ${status}, last updated ${ageHours}h ago).`

const TERMINAL_STATUSES = new Set(['done', 'failed', 'dropped'])

/**
 * Detect stale worktrees and raise `stale-worktree` actionQueue items for each one.
 *
 * A task qualifies as stale when:
 *   - its status is not terminal (done / failed / dropped)
 *   - its `updatedAt` timestamp is older than the threshold
 *   - a worktree directory exists on disk for it
 *
 * Returns the actionQueue item ids that were raised (or bumped on re-detection).
 */
export const detectAndRaiseStaleWorktrees = async (
  repoRoot: string,
): Promise<string[]> => {
  const thresholdMs = resolveThresholdHours() * 3_600_000
  const now = Date.now()
  const tasks = await listTasks()
  const raised: string[] = []

  for (const task of tasks) {
    if (TERMINAL_STATUSES.has(task.status)) continue

    const updatedMs = Date.parse(task.updatedAt)
    if (!Number.isFinite(updatedMs)) continue
    if (now - updatedMs < thresholdMs) continue

    // Skip tasks whose merge is actively in progress — wiping the worktree
    // while a merge job is running would corrupt the merge operation.
    const activeMergeJob = await getDefaultMergeJobStore().getActiveMergeJob(task.id)
    if (activeMergeJob !== null) {
      console.log(`[stale-worktree] skipping ${task.id}: active merge job ${activeMergeJob.id}`)
      continue
    }

    const worktreePath =
      task.worktreePath ?? join(repoRoot, '.mars', 'worktrees', task.id)
    const exists = await stat(worktreePath)
      .then((s) => s.isDirectory())
      .catch(() => false)
    if (!exists) continue

    const ageHours = Math.round(((now - updatedMs) / 3_600_000) * 10) / 10
    const id = await raiseActionQueueItem({
      kind: STALE_WORKTREE_KIND,
      category: 'daemon',
      priority: 'normal',
      title: `Stale worktree: task ${task.id} (${ageHours}h, ${task.status})`,
      body: buildNextActionBody(task.id, ageHours, task.status),
      payload: {
        ageHours,
        status: task.status,
        branch: task.branch ?? null,
        prompt: task.prompt,
        error: task.error ?? null,
      },
      context: { taskId: task.id },
      raisedBy: 'daemon:stale-worktree-sweep',
      signature: task.id,
      originTaskId: task.id,
      occurrence: {
        ageHours,
        status: task.status,
        detectedAt: new Date().toISOString(),
      },
    })
    raised.push(id)
  }

  return raised
}
