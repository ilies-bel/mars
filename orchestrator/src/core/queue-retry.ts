import { computeFailureSignature } from './lib/failure-signature'
import { type ActionQueueKind, raiseActionQueueItem } from './lib/action-queue'
import { clearBlockers, updateTask } from './queue'

export const DEFAULT_RETRY_BUDGET = 0

export const TASK_BLOCKED_ACTION_QUEUE_KIND: ActionQueueKind = 'failed'

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
  /**
   * Optional failure signature recorded on `failure_reason_code`. Defaults to
   * classifying `reason` under a generic `terminal` step via
   * {@link computeFailureSignature} so the column always holds a
   * `<step>/<error-class>` signature even for callers that don't thread an
   * explicit one. The Failure-kind resolution path keys on the task's
   * structured `failureSignature`, so this is a forensic mirror.
   */
  failureReasonCode?: string | null,
): Promise<void> => {
  const code = failureReasonCode ?? computeFailureSignature('terminal', reason)
  // Route the status write, paired events (task.dropped + task.terminal), and
  // extra column updates through the single validated chokepoint.  An illegal
  // transition (e.g. task already 'done') throws IllegalTransitionError before
  // any DB write.
  await updateTask(taskId, { status: 'dropped', failureReason: reason, failureReasonCode: code })
  // Clear outbound blocker edges through the Arc aggregate (ADR-0052 sole-writer).
  await clearBlockers(taskId)
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
  /**
   * Optional failure signature recorded on `failure_reason_code`. Defaults to
   * classifying `reason` under a generic `terminal` step via
   * {@link computeFailureSignature} so the column always holds a
   * `<step>/<error-class>` signature. Callers that already know the signature
   * (e.g. dispatch-time `verify:main-dirty` parking) pass it explicitly.
   */
  failureReasonCode?: string | null,
): Promise<void> => {
  const code = failureReasonCode ?? computeFailureSignature('terminal', reason)
  // Route the status write, paired events (task.failed + task.terminal), and
  // extra column updates through the single validated chokepoint.  An illegal
  // transition (e.g. task already 'done') throws IllegalTransitionError before
  // any DB write.
  await updateTask(taskId, { status: 'failed', failureReason: reason, failureReasonCode: code })
  // Clear outbound blocker edges through the Arc aggregate (ADR-0052 sole-writer).
  await clearBlockers(taskId)
  // Block downstream queued tasks whose only path to running was this
  // failed prerequisite. Dynamic import breaks the queue-retry <->
  // blocker-resolution module cycle. Best-effort: a cascade failure
  // must not mask the original markTaskFailed success.
  try {
    const { Arc } = await import('./arc')
    await Arc.blockByTaskFailure(taskId)
  } catch {
    // best-effort
  }
}

export interface RetryBudgetExhaustedActionQueueInput {
  taskId: string
  lastStep: string
  retryCount: number
  lastErrorSignature: string | null
  lastErrorSummary?: string | null
  branch?: string | null
  worktreePath?: string | null
}

const buildTaskBlockedBody = (
  input: RetryBudgetExhaustedActionQueueInput,
): string => {
  const isNeverRun = input.lastStep === 'blocked-dependent'
  const whyLine = isNeverRun
    ? `Why you're seeing this: task ${input.taskId} never ran — it was a blocked dependent whose retry budget (${input.retryCount}) has been reached. The orchestrator will not retry it again. It stays blocked until you act.`
    : `Why you're seeing this: task ${input.taskId} failed at step \`${input.lastStep}\` and the retry budget (${input.retryCount}) has been reached — the orchestrator will not retry it again. It stays blocked until you act.`
  const lines: Array<string | null> = [
    `Unblock task ${input.taskId} now: run /mars:unblock ${input.taskId}, or resolve it from the mars actionQueue.`,
    '',
    whyLine,
    '',
    'Context:',
    input.lastErrorSignature
      ? `  Last failure signature: ${input.lastErrorSignature}`
      : null,
    `  Retry count: ${input.retryCount}`,
    input.branch ? `  Branch: ${input.branch}` : null,
    input.worktreePath ? `  Worktree: ${input.worktreePath}` : null,
  ]
  if (input.lastErrorSummary) {
    lines.push('', 'Last error (truncated):', '```', input.lastErrorSummary, '```')
  }
  return lines.filter((line) => line !== null).join('\n')
}

/**
 * Raise (or bump) the actionQueue item that flags a task as having exhausted its
 * retry budget. Dedup is server-side on (kind, signature); we key both to
 * the task id so re-flips bump `seen_count` instead of duplicating rows.
 */
export const raiseRetryBudgetExhaustedActionQueue = async (
  input: RetryBudgetExhaustedActionQueueInput,
): Promise<string> => {
  const title =
    input.lastStep === 'blocked-dependent'
      ? `Unblock ${input.taskId}: never ran — blocked dependent exhausted retry budget`
      : `Unblock ${input.taskId}: retry budget exhausted at ${input.lastStep}`
  return raiseActionQueueItem({
    kind: TASK_BLOCKED_ACTION_QUEUE_KIND,
    category: 'orchestrator',
    priority: 'high',
    title,
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
    // Retry-budget exhaustion always fires on the origin task itself
    // (recoveries never enter this path), so collapse on the same key.
    originTaskId: input.taskId,
    occurrence: {
      at: new Date().toISOString(),
      lastStep: input.lastStep,
      retryCount: input.retryCount,
    },
  })
}
