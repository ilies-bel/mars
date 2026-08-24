/**
 * Raising the "recovery exhausted" action-queue item, as a leaf module.
 *
 * Why this is not in `../queue-retry.ts`, where it used to live: two
 * unrelated callers need it — `../queue-fix-tasks.ts` (the recovery-spawner
 * giving up) and `../blocker-resolution.ts` (a blocked dependent whose
 * origin's single recovery attempt was spent). `queue-retry.ts` also imports
 * `../queue.ts`, and `queue.ts -> arc.ts -> blocker-resolution.ts`, so
 * `blocker-resolution.ts` reaching back into `queue-retry.ts` for this one
 * helper closed a four-module import cycle that `npm run arch` rejects.
 *
 * Nothing here touches the task store: it formats a body and hands it to
 * `raiseActionQueueItem`. Keeping it in `core/lib/` — beside the
 * action-queue primitives it actually uses — makes it importable from both
 * sides of that former cycle.
 */
import { raiseActionQueueItem } from './action-queue'
import type { ActionQueueKind } from './action-queue-kinds'

/**
 * A task that has exhausted its single recovery attempt surfaces as an
 * ordinary `failed` action-queue row; the operator resolves it explicitly.
 */
export const TASK_BLOCKED_ACTION_QUEUE_KIND: ActionQueueKind = 'failed'

export interface RecoveryExhaustedActionQueueInput {
  taskId: string
  lastStep: string
  recoverySpawnedCount: number
  lastErrorSignature: string | null
  lastErrorSummary?: string | null
  branch?: string | null
  worktreePath?: string | null
}

const buildTaskBlockedBody = (
  input: RecoveryExhaustedActionQueueInput,
): string => {
  const isNeverRun = input.lastStep === 'blocked-dependent'
  const whyLine = isNeverRun
    ? `Why you're seeing this: task ${input.taskId} never ran — it was a blocked dependent whose single recovery attempt was exhausted (count: ${input.recoverySpawnedCount}). The orchestrator will not retry it again. It stays blocked until you act.`
    : `Why you're seeing this: task ${input.taskId} failed at step \`${input.lastStep}\` and the single recovery attempt was exhausted (count: ${input.recoverySpawnedCount}) — the orchestrator will not retry it again. It stays blocked until you act.`
  const lines: Array<string | null> = [
    `Unblock task ${input.taskId} now: run /mars:unblock ${input.taskId}, or resolve it from the mars actionQueue.`,
    '',
    whyLine,
    '',
    'Context:',
    input.lastErrorSignature
      ? `  Last failure signature: ${input.lastErrorSignature}`
      : null,
    `  Retry count: ${input.recoverySpawnedCount}`,
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
 * single recovery attempt. Dedup is server-side on (kind, signature); we key both to
 * the task id so re-flips bump `seen_count` instead of duplicating rows.
 */
export const raiseRecoveryExhaustedActionQueue = async (
  input: RecoveryExhaustedActionQueueInput,
): Promise<string> => {
  const title =
    input.lastStep === 'blocked-dependent'
      ? `Unblock ${input.taskId}: never ran — blocked dependent recovery exhausted`
      : `Unblock ${input.taskId}: recovery exhausted at ${input.lastStep}`
  return raiseActionQueueItem({
    kind: TASK_BLOCKED_ACTION_QUEUE_KIND,
    category: 'orchestrator',
    priority: 'high',
    title,
    body: buildTaskBlockedBody(input),
    payload: {
      taskId: input.taskId,
      lastStep: input.lastStep,
      recoverySpawnedCount: input.recoverySpawnedCount,
      lastErrorSignature: input.lastErrorSignature,
    },
    context: {
      branch: input.branch ?? null,
      worktreePath: input.worktreePath ?? null,
    },
    raisedBy: 'orchestrator:recovery-exhausted',
    signature: input.taskId,
    // Recovery exhaustion always fires on the origin task itself
    // (recoveries never enter this path), so collapse on the same key.
    originTaskId: input.taskId,
    occurrence: {
      at: new Date().toISOString(),
      lastStep: input.lastStep,
      recoverySpawnedCount: input.recoverySpawnedCount,
    },
  })
}
