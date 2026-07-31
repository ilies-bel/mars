/**
 * Who else is standing on this worktree?
 *
 * A recovery (`kind='fix'`) does NOT carve its own worktree: `attachToOriginWorktree`
 * binds it to the ORIGIN's directory and branch so it can continue that work in
 * place. Both rows therefore carry the same `worktree_path` / `branch`.
 *
 * Post-merge cleanup did not know that. It removed the directory AND deleted
 * the branch for whichever task merged — so when a recovery's work landed, the
 * origin's worktree was reclaimed out from under a row that was still live and
 * still dispatchable. The origin was then re-dispatched into a deleted
 * directory, which surfaces as `setup:origin-worktree-missing` if it fails at
 * setup and `verify:worktree-missing` if it gets as far as verify. Observed on
 * mars-a13334fd: its recovery fix-7a001daa merged, cleanup ran, and the origin
 * re-dispatched into nothing ten times in under a minute.
 *
 * This module answers the question cleanup should have been asking first.
 */
import { TERMINAL_TASK_STATUSES } from '../queue'
import type { DomainTaskStore } from '../store/task-store'

export interface WorktreeDependent {
  id: string
  status: string
}

/**
 * Non-terminal tasks OTHER than `taskId` bound to the same worktree path or
 * branch.
 *
 * Terminal rows (`done` / `failed` / `dropped` …) are excluded: they will never
 * be dispatched again, so they cannot be harmed by the removal. Anything else —
 * `queued`, `running`, `blocked`, `awaiting-human`, … — still needs the tree.
 *
 * Best-effort by contract: a query failure returns `[]` rather than throwing,
 * because this guard runs on the success path of a merge that has already
 * landed. Failing the merge over a bookkeeping read would be worse than the
 * stale directory it is trying to prevent.
 */
export const findLiveWorktreeDependents = async (args: {
  taskId: string
  worktreePath: string | null
  branch: string | null
  store: DomainTaskStore
}): Promise<WorktreeDependent[]> => {
  const { taskId, worktreePath, branch, store } = args
  if (worktreePath === null && branch === null) return []

  const terminal = [...TERMINAL_TASK_STATUSES]
  const statusPlaceholders = terminal.map(() => '?').join(', ')
  try {
    const rows = await store.query({
      sql: `SELECT id, status
              FROM tasks
             WHERE id != ?
               AND status NOT IN (${statusPlaceholders})
               AND (
                 (? IS NOT NULL AND worktree_path = ?)
                 OR (? IS NOT NULL AND branch = ?)
               )
             ORDER BY created_at ASC`,
      args: [
        taskId,
        ...terminal,
        worktreePath,
        worktreePath,
        branch,
        branch,
      ],
    })
    return rows.rows.map((r) => {
      const row = r as unknown as { id: string; status: string }
      return { id: row.id, status: row.status }
    })
  } catch (err: unknown) {
    console.error(
      `[worktree-dependents] lookup failed for task ${taskId}; assuming none:`,
      err,
    )
    return []
  }
}
