/**
 * Stale-queued watchdog — raises an action-queue alert when a task has been
 * sitting in `status='queued'` past a configurable threshold (default 10 min)
 * despite the daemon being healthy.
 *
 * This catches two failure modes:
 *  1. Pool saturation: all worker slots are busy, so new tasks wait in the
 *     queue longer than expected.
 *  2. Dispatcher stall: a bug or deadlock means `drain()` is not being called
 *     and queued work is not being picked up at all.
 *
 * The alert payload carries `activeWorkerCount`, `queueDepth`, and
 * `dispatchDecisionSummary` so the operator can distinguish between the two
 * cases at a glance.
 *
 * Duplicate suppression: `raiseActionQueueItem` deduplicates on the fingerprint
 * `sha1('stale-queued:<taskId>')`, so repeated sweeps while the task remains
 * queued bump `seen_count` on the existing row rather than spawning siblings.
 */

import { listTasks } from '../queue'
import { type ActionQueueKind, raiseActionQueueItem } from '../lib/action-queue'

export const STALE_QUEUED_KIND: ActionQueueKind = 'stale-queued'

/** Default stale-queued threshold: 10 minutes. */
export const DEFAULT_STALE_QUEUED_MS = 10 * 60_000

const resolvedThresholdMs = (): number => {
  const raw = process.env.MARS_STALE_QUEUED_MS
  if (!raw) return DEFAULT_STALE_QUEUED_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_QUEUED_MS
}

export interface StaleQueuedSweepDeps {
  /** Number of worker slots currently occupied (from tracker.inFlightCount()). */
  activeWorkerCount: number
  /** Total number of tasks currently in 'queued' status. */
  queueDepth: number
  /**
   * Recent dispatch-decision log entries (e.g. the last 5 skip/select messages
   * from the dispatcher). Pass an empty array when no ring buffer is wired up.
   */
  dispatchDecisionSummary: string[]
  /** Override current timestamp for testing. */
  nowMs?: number
}

/**
 * Sweep for tasks that have been in `status='queued'` longer than
 * `MARS_STALE_QUEUED_MS` (default 10 min) and raise a `stale-queued`
 * action-queue alert for each one not already alerted-on.
 *
 * @returns IDs of tasks for which a new or bumped alert was raised.
 */
export const runStaleQueuedSweep = async (
  deps: StaleQueuedSweepDeps,
): Promise<{ alerted: string[] }> => {
  const now = deps.nowMs ?? Date.now()
  const threshold = resolvedThresholdMs()
  const { activeWorkerCount, queueDepth, dispatchDecisionSummary } = deps

  const tasks = await listTasks('queued')
  const alerted: string[] = []

  for (const task of tasks) {
    const updatedMs = Date.parse(task.updatedAt)
    if (!Number.isFinite(updatedMs)) continue

    const queuedAgeMs = now - updatedMs
    if (queuedAgeMs <= threshold) continue

    const ageMinutes = Math.round(queuedAgeMs / 60_000)
    const shortGoal =
      task.prompt?.split('\n')[0]?.trim().replace(/[.,:;!?]+$/, '').slice(0, 60) ||
      `task ${task.id}`

    const saturationNote =
      activeWorkerCount > 0
        ? `${activeWorkerCount} worker(s) active — pool may be saturated.`
        : queueDepth > 1
          ? `No active workers despite ${queueDepth} queued task(s) — dispatcher may be stuck.`
          : `No active workers — dispatcher may be stuck.`

    await raiseActionQueueItem({
      kind: STALE_QUEUED_KIND,
      category: 'daemon',
      priority: 'normal',
      title: `Stale-queued ${ageMinutes} min: ${shortGoal}`,
      body:
        `"${shortGoal}" has been waiting in the dispatch queue for ${ageMinutes} min ` +
        `(threshold: ${Math.round(threshold / 60_000)} min). ` +
        saturationNote +
        ` Queue depth: ${queueDepth}.`,
      payload: {
        taskId: task.id,
        queuedAgeMs,
        activeWorkerCount,
        queueDepth,
        dispatchDecisionSummary,
      },
      context: { taskId: task.id },
      raisedBy: 'daemon:stale-queued-watchdog',
      // Signature-keyed (no originTaskId) so the fingerprint is
      // sha1('stale-queued:<taskId>'), giving kind-specific deduplication
      // that does not collide with 'failed' or other per-task kinds.
      signature: task.id,
      occurrence: {
        queuedAgeMs,
        activeWorkerCount,
        queueDepth,
        detectedAt: new Date(now).toISOString(),
      },
    }).catch(() => {
      // Non-fatal: the task stays visible via mars list regardless.
    })

    alerted.push(task.id)
  }

  return { alerted }
}
