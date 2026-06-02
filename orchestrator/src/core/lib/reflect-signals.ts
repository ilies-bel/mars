import { getDefaultTaskStore, type TaskStore } from './task-store'
import type { UsageTotals } from './claude-usage'

export const isReflectDisabled = (): boolean =>
  process.env.MARS_REFLECT_DISABLED === '1'

/**
 * Superseded by runWorkerWithSpan (PRD 436f14c7 slice 1).
 * Usage signals are now captured as step_ended trace events by the span
 * lifecycle. This stub exists so callers in implement-workflow.ts compile
 * without changes in this slice; it is a no-op.
 */
export const recordSignals = async (
  _taskId: string,
  _stepId: string,
  _totals: UsageTotals,
  _store?: TaskStore,
): Promise<void> => {
  // No-op: usage signals are recorded via runWorkerWithSpan → step_ended events.
}

export interface TaskSignalRow {
  taskId: string
  stepId: string
  inputTokens: number
  outputTokens: number
  cacheCreateTokens: number
  cacheReadTokens: number
  messageCount: number
  recordedAt: string
}

/**
 * Return usage signal rows for a task. After PRD 436f14c7 slice 5,
 * signals live in trace_events as step_ended events with a usageSignals
 * object in the payload. Rows without usageSignals (e.g. verify-output-only
 * events) are skipped.
 */
export const listTaskSignals = async (taskId: string): Promise<TaskSignalRow[]> => {
  const store = await getDefaultTaskStore()
  const r = await store.query({
    sql: `SELECT task_id, timestamp, payload
            FROM trace_events
           WHERE kind = 'step_ended' AND task_id = ?
           ORDER BY timestamp`,
    args: [taskId],
  })
  return r.rows.flatMap((row) => {
    const r0 = row as unknown as { task_id: string; timestamp: string; payload: string }
    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(r0.payload) as Record<string, unknown>
    } catch {
      return []
    }
    const usageSignals = payload.usageSignals as Record<string, unknown> | undefined
    if (!usageSignals) return []
    return [
      {
        taskId: r0.task_id,
        stepId: (payload.stepName as string | undefined) ?? 'code',
        inputTokens: Number(usageSignals.inputTokens ?? 0),
        outputTokens: Number(usageSignals.outputTokens ?? 0),
        cacheCreateTokens: Number(usageSignals.cacheCreateTokens ?? 0),
        cacheReadTokens: Number(usageSignals.cacheReadTokens ?? 0),
        messageCount: Number(usageSignals.messageCount ?? 0),
        recordedAt: r0.timestamp,
      },
    ]
  })
}
