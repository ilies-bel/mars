import { computeFailureSignature } from './lib/failure-signature'
import { clearBlockers, updateTask } from './queue'

// ADR-0101: markTaskFailed, FailureEvidence, and resolveFailureErrorPatch
// relocated into `arc.ts` to break the arc -> queue-retry dependency cycle.
// Re-exported here for backward compatibility.
export { markTaskFailed, type FailureEvidence } from './arc'

export const DEFAULT_FIX_RETRY_BUDGET = 0

export const getRetryBudget = (): number => {
  const raw = process.env.MARS_FIX_RETRY_BUDGET
  if (!raw) return DEFAULT_FIX_RETRY_BUDGET
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_FIX_RETRY_BUDGET
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
