/**
 * Phantom-task watchdog — auto-fails tasks that are pinned to an in-flight
 * status ('running' | 'verifying') but whose subprocess is no longer alive,
 * preventing a dead worker from holding an in-flight slot indefinitely.
 *
 * Two detection mechanisms, applied per-task (belt and suspenders):
 *
 *  1. PID liveness (precise, when available): if the task's in-flight entry
 *     carries a PID and `isProcessAlive(pid)` returns false, the task is
 *     phantom immediately — no ceiling wait needed.
 *
 *  2. Wall-clock ceiling (stack-agnostic backstop): if the task's `updatedAt`
 *     is older than MARS_PHANTOM_WATCHDOG_CEILING_MS (default: 30 min), and
 *     we either have no PID or the PID is alive, the task is treated as
 *     phantom. This catches the "subprocess hung forever" case where the child
 *     process is technically alive but will never produce output.
 *
 * For each detected phantom:
 *  - The task row is updated to status='failed' with failedPhase set.
 *  - `reclaimSlot(taskId, kind)` is called so the caller can clear the
 *    in-flight entry and release the semaphore slot.
 *  - Exactly ONE action-queue item is raised per phantom (dedup by taskId
 *    ensures re-detections bump the existing item rather than spawning siblings).
 *
 * A task that is NOT in the inFlightEntries snapshot is also checked against
 * the wall-clock ceiling; if it exceeds the ceiling, it is phantom-failed even
 * without a slot to reclaim (the slot was already leaked somehow).
 */

import { listTasks, updateTask } from '../queue'
import { type ActionQueueKind, raiseActionQueueItem } from '../lib/action-queue'
import type { DispatchKind, InFlightEntry } from './task-flight-tracker'

export const PHANTOM_TASK_KIND: ActionQueueKind = 'phantom-task'

/** Default wall-clock ceiling: 30 minutes. */
export const DEFAULT_CEILING_MS = 30 * 60_000

const resolvedCeilingMs = (): number => {
  const raw = process.env.MARS_PHANTOM_WATCHDOG_CEILING_MS
  if (!raw) return DEFAULT_CEILING_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CEILING_MS
}

/**
 * Build the human-readable action-queue item body for a phantom detection.
 * Exported for test assertions.
 */
export const buildPhantomBody = (
  taskId: string,
  status: string,
  reason: 'dead-pid' | 'ceiling',
  ageMinutes: number,
): string => {
  const detail =
    reason === 'dead-pid'
      ? `its recorded subprocess PID is no longer alive`
      : `its last-updated timestamp is ${ageMinutes} min old (ceiling: ${Math.round(resolvedCeilingMs() / 60_000)} min)`
  return (
    `Task ${taskId} was pinned to status '${status}' with no live subprocess: ${detail}. ` +
    `The daemon auto-failed the task and freed its in-flight slot. ` +
    `Inspect the task output, then restart or drop as appropriate.`
  )
}

/** The in-flight statuses the watchdog scans. */
const PHANTOM_STATUSES = ['running', 'verifying'] as const

/** failedPhase to record per status. */
const FAILED_PHASE_FOR_STATUS: Record<(typeof PHANTOM_STATUSES)[number], 'code' | 'verify'> = {
  running: 'code',
  verifying: 'verify',
}

/**
 * Sweep for tasks stuck in 'running' or 'verifying' whose subprocess is gone.
 *
 * @param inFlightEntries  Point-in-time snapshot of the daemon's inFlight map
 *                         (from `tracker.inFlightSnapshot()`).
 * @param reclaimSlot      Called for each phantom that held an in-flight slot —
 *                         must clear the tracker entry AND release the semaphore.
 * @param isAlive          PID liveness predicate (default: `isProcessAlive` from
 *                         `./paths`). Pass a stub in tests.
 * @param nowMs            Current timestamp override for testing.
 * @returns                IDs of every task that was auto-failed.
 */
export const sweepPhantomTasks = async (
  inFlightEntries: readonly InFlightEntry[],
  reclaimSlot: (taskId: string, kind: DispatchKind) => void,
  isAlive?: (pid: number) => boolean,
  nowMs?: number,
): Promise<{ failed: string[] }> => {
  const { isProcessAlive } = await import('./paths')
  const alive = isAlive ?? isProcessAlive
  const now = nowMs ?? Date.now()
  const ceiling = resolvedCeilingMs()

  // Index the in-flight snapshot for O(1) lookup by taskId.
  const inFlightByTask = new Map<string, InFlightEntry>(
    inFlightEntries.map((e) => [e.taskId, e]),
  )

  const failed: string[] = []

  for (const status of PHANTOM_STATUSES) {
    const tasks = await listTasks(status)
    for (const task of tasks) {
      const entry = inFlightByTask.get(task.id)

      let phantomReason: 'dead-pid' | 'ceiling' | null = null

      if (entry?.pid !== undefined) {
        // Belt: PID is known — check liveness. Dead PID ⟹ phantom immediately.
        if (!alive(entry.pid)) {
          phantomReason = 'dead-pid'
        }
        // Alive PID ⟹ not phantom by PID check; fall through to ceiling check
        // as the "suspenders" backstop.
        if (phantomReason === null) {
          const updatedMs = Date.parse(task.updatedAt)
          if (Number.isFinite(updatedMs) && now - updatedMs > ceiling) {
            phantomReason = 'ceiling'
          }
        }
      } else {
        // No PID available — rely solely on the wall-clock ceiling.
        const updatedMs = Date.parse(task.updatedAt)
        if (!Number.isFinite(updatedMs) || now - updatedMs <= ceiling) continue
        phantomReason = 'ceiling'
      }

      if (phantomReason === null) continue

      const ageMinutes = Math.round((now - Date.parse(task.updatedAt)) / 60_000)
      const failedPhase = FAILED_PHASE_FOR_STATUS[status]

      // Mark the task failed BEFORE reclaiming the slot so there is never a
      // window where the slot is free but the task is still 'running'.
      await updateTask(task.id, {
        status: 'failed',
        failedPhase,
        failureReason: `phantom-task watchdog: ${phantomReason}`,
        failureReasonCode: `phantom-task:${phantomReason}`,
        error: `Task auto-failed by phantom-task watchdog (reason: ${phantomReason}, age: ${ageMinutes} min)`,
      }).catch(() => {
        // Best-effort: if the write fails, skip the reclaim and item raise to
        // avoid inconsistency (don't free the slot if the row stays 'running').
      })

      // Verify the write landed before reclaiming.
      const { getTask } = await import('../queue')
      const updated = await getTask(task.id).catch(() => null)
      if (updated?.status !== 'failed') continue

      if (entry) {
        reclaimSlot(task.id, entry.kind)
      }

      // Raise exactly one action-queue item per phantom; dedup by taskId so
      // re-detections bump seen_count rather than spawning siblings.
      await raiseActionQueueItem({
        kind: PHANTOM_TASK_KIND,
        category: 'daemon',
        priority: 'high',
        title: `Phantom task auto-failed: ${task.id} (${status}, ${ageMinutes} min old)`,
        body: buildPhantomBody(task.id, status, phantomReason, ageMinutes),
        payload: {
          taskId: task.id,
          previousStatus: status,
          failedPhase,
          reason: phantomReason,
          ageMinutes,
          pid: entry?.pid ?? null,
        },
        context: { taskId: task.id },
        raisedBy: 'daemon:phantom-task-watchdog',
        signature: task.id,
        originTaskId: task.id,
        occurrence: {
          previousStatus: status,
          reason: phantomReason,
          ageMinutes,
          detectedAt: new Date(now).toISOString(),
        },
      }).catch(() => {
        // Non-fatal: task is already marked failed.
      })

      failed.push(task.id)
    }
  }

  return { failed }
}
