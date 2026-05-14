import { raiseInboxItem } from './lib/inbox'
import { getClient, initQueue } from './queue'

export const DEFAULT_RETRY_BUDGET = 0

export const TASK_BLOCKED_INBOX_KIND_PREFIX = 'task-blocked'

export const getRetryBudget = (): number => {
  const raw = process.env.MARS_FIX_RETRY_BUDGET
  if (!raw) return DEFAULT_RETRY_BUDGET
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETRY_BUDGET
  return Math.floor(n)
}

export const markTaskDropped = async (
  taskId: string,
  reason: string,
): Promise<void> => {
  await initQueue()
  const now = new Date().toISOString()
  await getClient().execute({
    sql: `UPDATE tasks SET status = 'dropped', drop_reason = ?, updated_at = ? WHERE id = ?`,
    args: [reason, now, taskId],
  })
  await getClient().execute({
    sql: `DELETE FROM task_blockers WHERE task_id = ?`,
    args: [taskId],
  })
}

/**
 * Terminal failure path. Use when a task exhausted its retry budget on a
 * real error (verify failure, blocker dependent stuck after unblock).
 * Distinct from `markTaskDropped`, which is reserved for explicit abandonment
 * (user "skip", invalid input). A `failed` task can be retried via
 * `mars restart <id>`; a `dropped` task cannot.
 */
export const markTaskFailed = async (
  taskId: string,
  reason: string,
): Promise<void> => {
  await initQueue()
  const now = new Date().toISOString()
  await getClient().execute({
    sql: `UPDATE tasks SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?`,
    args: [reason, now, taskId],
  })
  await getClient().execute({
    sql: `DELETE FROM task_blockers WHERE task_id = ?`,
    args: [taskId],
  })
}

export interface RetryBudgetExhaustedInboxInput {
  taskId: string
  lastStep: string
  retryCount: number
  lastErrorSignature: string | null
  lastErrorSummary?: string | null
  branch?: string | null
  worktreePath?: string | null
}

const buildTaskBlockedBody = (
  input: RetryBudgetExhaustedInboxInput,
): string => {
  const lines: Array<string | null> = [
    `Task ${input.taskId} exhausted its retry budget at step \`${input.lastStep}\` and is no longer being retried by the orchestrator.`,
    input.lastErrorSignature
      ? `Last failure signature: ${input.lastErrorSignature}`
      : null,
    `Retry count: ${input.retryCount}`,
    input.branch ? `Branch: ${input.branch}` : null,
    input.worktreePath ? `Worktree: ${input.worktreePath}` : null,
    '',
  ]
  if (input.lastErrorSummary) {
    lines.push('Last error (truncated):', '```', input.lastErrorSummary, '```', '')
  }
  lines.push(`Resolve with /mars:unblock ${input.taskId} or via mars inbox.`)
  return lines.filter((line) => line !== null).join('\n')
}

/**
 * Raise (or bump) the inbox item that flags a task as having exhausted its
 * retry budget. Dedup is server-side on (kind, signature); we key both to
 * the task id so re-flips bump `seen_count` instead of duplicating rows.
 */
export const raiseRetryBudgetExhaustedInbox = async (
  input: RetryBudgetExhaustedInboxInput,
): Promise<string> => {
  return raiseInboxItem({
    kind: `${TASK_BLOCKED_INBOX_KIND_PREFIX}(${input.taskId})`,
    category: 'orchestrator',
    priority: 'high',
    title: `task ${input.taskId} blocked after retry budget exhausted at ${input.lastStep}`,
    body: buildTaskBlockedBody(input),
    payload: {
      taskId: input.taskId,
      lastStep: input.lastStep,
      retryCount: input.retryCount,
      lastErrorSignature: input.lastErrorSignature,
    },
    context: {
      branch: input.branch ?? null,
      worktreePath: input.worktreePath ?? null,
    },
    raisedBy: 'orchestrator:retry-budget',
    signature: input.taskId,
    occurrence: {
      at: new Date().toISOString(),
      lastStep: input.lastStep,
      retryCount: input.retryCount,
    },
  })
}
