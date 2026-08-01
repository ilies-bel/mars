/**
 * Stale-queued watchdog — raises an action-queue alert when a task has been
 * sitting in `status='queued'` past a configurable threshold (default 10 min)
 * despite the daemon being healthy.
 *
 * This catches a dispatcher stall: a bug or deadlock means `drain()` is not
 * being called even though an implement slot is available. A saturated pool is
 * healthy throttling and must not create action-queue noise.
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
import { raiseActionQueueItem } from '../lib/action-queue'
import type { ActionQueueKind } from '../lib/action-queue-kinds'

export const STALE_QUEUED_KIND: ActionQueueKind = 'stale-queued'
export const STALE_QUEUED_SUMMARY_KIND: ActionQueueKind = 'stale-queued-summary'

/** Default stale-queued threshold: 10 minutes. */
export const DEFAULT_STALE_QUEUED_MS = 10 * 60_000

/** Keep one sweep from turning a large backlog into an action-queue flood. */
const MAX_ALERTS_PER_SWEEP = 20

const resolvedThresholdMs = (): number => {
  const raw = process.env.MARS_STALE_QUEUED_MS
  if (!raw) return DEFAULT_STALE_QUEUED_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_QUEUED_MS
}

export interface StaleQueuedSweepDeps {
  /** Number of worker slots currently occupied (from tracker.inFlightCount()). */
  activeWorkerCount: number
  /** Current implement semaphore limit, including steward runtime adjustments. */
  implementCap: number
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
 * action-queue alert for each one not already alerted-on. The twenty oldest
 * alerts are raised individually; a separate summary makes any remainder
 * visible without flooding the human-facing queue.
 *
 * @returns IDs of tasks for which a new or bumped alert was raised.
 */
export const runStaleQueuedSweep = async (
  deps: StaleQueuedSweepDeps,
): Promise<{ alerted: string[] }> => {
  const now = deps.nowMs ?? Date.now()
  const threshold = resolvedThresholdMs()
  const { activeWorkerCount, implementCap, queueDepth, dispatchDecisionSummary } = deps

  // Do not scale the age threshold with a lowered cap: an idle slot is still
  // actionable at any cap. Saturation is the complete distinction between
  // deliberate steward throttling and a dispatcher that has stopped draining.
  if (activeWorkerCount >= implementCap) return { alerted: [] }

  const tasks = await listTasks('queued')
  const alerted: string[] = []
  const staleTasks = tasks
    .map((task) => ({ task, updatedMs: Date.parse(task.updatedAt) }))
    .filter(({ updatedMs }) => Number.isFinite(updatedMs) && now - updatedMs > threshold)
    .sort((a, b) => a.updatedMs - b.updatedMs)

  for (const { task, updatedMs } of staleTasks.slice(0, MAX_ALERTS_PER_SWEEP)) {
    const queuedAgeMs = now - updatedMs

    const ageMinutes = Math.round(queuedAgeMs / 60_000)
    const shortGoal =
      task.prompt?.split('\n')[0]?.trim().replace(/[.,:;!?]+$/, '').slice(0, 60) ||
      `task ${task.id}`

    const idleCapacityNote =
      activeWorkerCount > 0
        ? `${activeWorkerCount} worker(s) active below the ${implementCap}-worker cap — dispatcher may be stuck.`
        : queueDepth > 1
          ? `No active workers despite ${queueDepth} queued task(s) and a ${implementCap}-worker cap — dispatcher may be stuck.`
          : `No active workers despite a ${implementCap}-worker cap — dispatcher may be stuck.`

    await raiseActionQueueItem({
      kind: STALE_QUEUED_KIND,
      category: 'daemon',
      priority: 'normal',
      title: `Stale-queued ${ageMinutes} min: ${shortGoal}`,
      body:
        `"${shortGoal}" has been waiting in the dispatch queue for ${ageMinutes} min ` +
        `(threshold: ${Math.round(threshold / 60_000)} min). ` +
        idleCapacityNote +
        ` Queue depth: ${queueDepth}.`,
      payload: {
        taskId: task.id,
        queuedAgeMs,
        activeWorkerCount,
        implementCap,
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
        implementCap,
        queueDepth,
        detectedAt: new Date(now).toISOString(),
      },
    }).catch(() => {
      // Non-fatal: the task stays visible via mars list regardless.
    })

    alerted.push(task.id)
  }

  const suppressedCount = staleTasks.length - alerted.length
  if (suppressedCount > 0) {
    await raiseActionQueueItem({
      kind: STALE_QUEUED_SUMMARY_KIND,
      category: 'daemon',
      priority: 'normal',
      title: `Stale-queued watchdog suppressed ${suppressedCount} additional alert(s)`,
      body:
        `${suppressedCount} additional stale queued task alert(s) were suppressed in this sweep; ` +
        `only the ${MAX_ALERTS_PER_SWEEP} oldest were raised individually. ` +
        `Queue depth: ${queueDepth}; active workers: ${activeWorkerCount}/${implementCap}.`,
      payload: {
        suppressionSummary: true,
        suppressedCount,
        activeWorkerCount,
        implementCap,
        queueDepth,
        dispatchDecisionSummary,
      },
      context: {},
      raisedBy: 'daemon:stale-queued-watchdog',
      // This is intentionally distinct from the unchanged per-task signature
      // so one summary row is updated on each overflowing sweep.
      signature: 'summary',
      occurrence: {
        suppressedCount,
        activeWorkerCount,
        implementCap,
        queueDepth,
        detectedAt: new Date(now).toISOString(),
      },
    }).catch(() => {
      // Non-fatal: individual alerts still identify the oldest stalled tasks.
    })
  }

  return { alerted }
}
