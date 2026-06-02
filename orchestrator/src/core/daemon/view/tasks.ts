/**
 * Daemon-side Tasks view: full task list with cluster tag and blocker list.
 *
 * `buildTasksView` is the authoritative builder for `GET /view/tasks`. It
 * enriches every task row with:
 *  - `cluster`: the Progress-tab cluster tag, or `null` for terminal statuses
 *    (draft/done/dropped) that fall outside the kanban scope. Every non-terminal
 *    task maps to exactly one of Queued | In progress | Blocked | Failed.
 *  - `blockedBy`: full list of blocker task IDs sourced from the task_blockers
 *    junction table (empty array when a task has no blockers).
 *
 * By serving this shape from the daemon the UI can proxy a single endpoint
 * (`/view/tasks`) and receive a complete, enriched task list without reading
 * the database directly.
 */

import type { Client } from '@libsql/client'
import {
  clusterFor,
  createProgressTaskStore,
  parseJsonArray,
  type Cluster,
  type ProgressTaskSpec,
} from './progress.js'

export interface TaskViewItem {
  id: string
  prompt: string
  status: string
  cluster: Cluster | null
  plan: { functional: string; technical: string } | null
  branch: string | null
  worktreePath: string | null
  error: string | null
  failureSignature: string | null
  dropReason: string | null
  retryCount: number
  blockerTaskId: string | null
  blockedBy: string[]
  parentProposalId: string | null
  spec: ProgressTaskSpec | null
  createdAt: string
  updatedAt: string
}

/**
 * Build the Tasks view payload: all tasks with their cluster tag and blocker
 * list. Unlike `/view/progress`, this endpoint does NOT filter by cluster — it
 * returns every task row (including done/dropped/draft) so the UI has a
 * complete list for the task table and per-task drawer.
 */
export const buildTasksView = async (
  client: Client,
): Promise<{ tasks: TaskViewItem[] }> => {
  const store = createProgressTaskStore(client)
  const rows = await store.listProgressTasks()

  const tasks: TaskViewItem[] = rows.map((row) => {
    const f = row.planFunctional
    const t = row.planTechnical
    const anySpec =
      row.filesJson !== null ||
      row.verifyCmd !== null ||
      row.doneCriteriaJson !== null ||
      row.taskType !== null
    const spec: ProgressTaskSpec | null = anySpec
      ? {
          files: parseJsonArray(row.filesJson),
          readFirst: parseJsonArray(row.readFirstJson),
          prescriptiveAction: row.prescriptiveAction,
          verifyCmd: row.verifyCmd,
          doneCriteria: parseJsonArray(row.doneCriteriaJson),
          taskType: row.taskType ?? 'auto',
        }
      : null

    return {
      id: row.id,
      prompt: row.prompt,
      status: row.status,
      cluster: clusterFor(row.status),
      plan:
        f !== null || t !== null
          ? { functional: f ?? '', technical: t ?? '' }
          : null,
      branch: row.branch,
      worktreePath: row.worktreePath,
      error: row.error,
      failureSignature: row.failureSignature,
      dropReason: row.dropReason,
      retryCount: row.retryCount,
      blockerTaskId: row.blockerTaskId,
      blockedBy: row.blockedBy,
      parentProposalId: row.parentProposalId,
      spec,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  })

  return { tasks }
}
