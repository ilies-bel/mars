import type { Task } from '../queue.js'
import {
  computeBudgetPressure,
  type BudgetPressureConfig,
} from './budget-pressure.js'
import type { UsageSnapshotRow } from './usage-snapshot-store.js'

export interface DispatchDeferralDecision {
  defer: boolean
  reason?: string
}

/**
 * Decide whether queued work should wait for the next provider usage window.
 * Recovery work always runs so a failed task cannot be stranded by a quota
 * window, even when its copied priority or deferrable flag says otherwise.
 */
export const shouldDeferDispatch = (
  task: Task,
  snapshot: UsageSnapshotRow | null,
  cfg: BudgetPressureConfig,
): DispatchDeferralDecision => {
  if (task.fixForTaskId != null || snapshot === null) return { defer: false }

  const pressure = computeBudgetPressure(snapshot, cfg)
  if (pressure === 'ok' || (!task.deferrable && task.priority > 0)) {
    return { defer: false }
  }

  return { defer: true, reason: `usage pressure is ${pressure}` }
}
