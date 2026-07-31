/**
 * Awaiting-validation watchdog — keeps dead previews from indefinitely
 * dominating the action queue, while preserving the operator's decision until
 * a bounded age cap turns the parked task into an ordinary terminal failure.
 */

import { listTasks, updateTask } from '../queue'
import {
  demoteAwaitingValidationAction,
  listActionQueueItems,
  supersedeActionQueueItemsForOrigin,
} from '../lib/action-queue'

/** A parked preview may wait for an operator for at most two days. */
export const DEFAULT_AWAITING_VALIDATION_MAX_AGE_MS = 48 * 60 * 60_000

export interface AwaitingValidationSweepDeps {
  /** Override current timestamp for tests. */
  nowMs?: number
}

/**
 * Probe every parked preview with a short HTTP request. A refused, malformed,
 * missing, or timed-out URL demotes its open action row; the task itself stays
 * awaiting-validation until it exceeds the age cap.
 */
export const runAwaitingValidationSweep = async (
  deps: AwaitingValidationSweepDeps = {},
): Promise<{ demoted: string[]; failed: string[] }> => {
  const nowMs = deps.nowMs ?? Date.now()
  const configuredMaxAge = Number(process.env.MARS_AWAITING_VALIDATION_MAX_AGE_MS ?? '')
  const maxAgeMs =
    Number.isFinite(configuredMaxAge) && configuredMaxAge > 0
      ? configuredMaxAge
      : DEFAULT_AWAITING_VALIDATION_MAX_AGE_MS
  const [tasks, openItems] = await Promise.all([
    listTasks('awaiting-validation'),
    listActionQueueItems('open'),
  ])
  const demoted: string[] = []
  const failed: string[] = []

  for (const task of tasks) {
    const action = openItems.find(
      (item) =>
        (item.kind === 'awaiting-validation' || item.kind === 'awaiting-validation-preview-gone') &&
        (item.originTaskId === task.id || item.payload.taskId === task.id),
    )
    const payloadUrl = action
      ? [action.payload.devServerUrl, action.payload.remoteUrl, action.payload.previewUrl].find(
          (value): value is string => typeof value === 'string' && value.length > 0,
        ) ?? null
      : null
    const previewUrl = task.devServerUrl ?? payloadUrl

    let reachable = false
    if (previewUrl !== null) {
      try {
        await fetch(previewUrl, { signal: AbortSignal.timeout(2_000) })
        reachable = true
      } catch {
        // A transport failure is the liveness signal; no status code is needed.
      }
    }

    if (!reachable) {
      const demotedId = await demoteAwaitingValidationAction(task.id, previewUrl, nowMs)
      if (demotedId !== null) demoted.push(task.id)
    }

    const updatedMs = Date.parse(task.updatedAt)
    if (Number.isFinite(updatedMs) && nowMs - updatedMs > maxAgeMs) {
      await updateTask(task.id, {
        status: 'failed',
        failedPhase: 'merge',
        error: 'preview validation expired after 48 hours',
        failureReason: 'awaiting-validation:preview-gone',
        failureReasonCode: 'awaiting-validation:preview-gone',
        failureSignature: 'awaiting-validation:preview-gone',
        devServerUrl: null,
        devServerPid: null,
      })
      await supersedeActionQueueItemsForOrigin(task.id, 'status-changed', 'daemon:awaiting-validation-watchdog')
      failed.push(task.id)
    }
  }

  return { demoted, failed }
}
