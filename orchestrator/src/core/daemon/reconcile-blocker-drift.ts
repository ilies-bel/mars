/**
 * Startup reconciler: finds tasks that are in status='queued' but still have
 * incomplete blocker edges and demotes them back to 'blocked'.
 *
 * INVARIANT (CLAUDE.md § Blockers):
 *   A task MUST NOT be in status='queued' while any of its task_blockers
 *   edges points to a non-'done' task.
 *
 * This module is the catch-all safety net. It runs early in daemon startup —
 * before the reconcile loop re-seeds the dispatch queue — so the dispatcher
 * never encounters incorrectly-queued rows during the boot burst. Promotion
 * paths (onBlockerTaskCompleted, promoteDraftToQueued) already gate on this
 * invariant; this sweep repairs any drift that slipped through (e.g. due to
 * a crash between the blocker check and the status write, or a code bug in a
 * non-standard promotion path).
 */

import { hasIncompleteBlockers, listTasks, updateTask } from '../queue'
import { runCompositionRootMigrations } from '../store/task-store'

/**
 * Scan all `queued` tasks and demote any that still have incomplete blocker
 * edges back to `blocked`. Returns the IDs of tasks that were demoted.
 *
 * Idempotent: running it on a clean queue produces an empty result with no
 * side effects.
 */
export const repairQueuedWithIncompleteBlockers = async (): Promise<string[]> => {
  await runCompositionRootMigrations()
  const queued = await listTasks('queued')
  const demoted: string[] = []

  for (const t of queued) {
    if (await hasIncompleteBlockers(t.id)) {
      await updateTask(t.id, { status: 'blocked' }).catch(() => {})
      demoted.push(t.id)
    }
  }

  return demoted
}
