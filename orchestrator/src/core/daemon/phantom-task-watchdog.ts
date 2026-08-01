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
 *  2. Wall-clock ceiling (stack-agnostic backstop): catches the "subprocess
 *     hung forever" case where the child process is technically alive but will
 *     never produce output. The ceiling is applied differently depending on
 *     whether a PID and activity heartbeat are available:
 *
 *     a. NO PID in the in-flight entry: ceiling is checked against
 *        `task.updatedAt`. This is the original behaviour; any task-table
 *        write (including a status transition) resets the window.
 *
 *     b. ALIVE PID + heartbeat (`entry.lastActivityMs` is set): ceiling is
 *        checked against `entry.lastActivityMs` — the last claude-event
 *        activity timestamp recorded by the dispatcher. An alive coder that
 *        is streaming output keeps this fresh (~once per minute), so a
 *        legitimately long run (100+ minutes) is NEVER ceiling-killed.
 *        Only a process that is alive but has produced no events for longer
 *        than the ceiling triggers a kill.
 *
 *     c. ALIVE PID + no heartbeat yet (process just started, or the provider
 *        has not emitted its first event): the task is NOT failed. The
 *        dead-PID check in (1) remains the only kill path until the first
 *        heartbeat arrives. Silence alone is not evidence that a worker is
 *        phantom; providers have different startup and streaming behaviour.
 *
 *     The "alive pid must never be ceiling-killed on updatedAt staleness alone"
 *     rule is enforced by routing alive-PID tasks through (b) or (c) — never
 *     through (a).
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
 *
 * PARKED STATUSES ARE NEVER SWEPT:
 * Tasks in 'awaiting-human' or 'awaiting-validation' have no managed subprocess
 * by design — the human or operator owns the worktree session. These statuses
 * are intentionally excluded from PHANTOM_STATUSES; the watchdog MUST NOT
 * phantom-fail them regardless of age.
 *
 * LEASE EXPIRY:
 * `sweepExpiredLeases` is the companion function for 'awaiting-human'. When a
 * lease's age exceeds MARS_LEASE_EXPIRY_MS the function raises a level-triggered
 * action-queue row (ADR-0048) — it NEVER auto-fails the task. The operator
 * resolves the lease explicitly (release → re-queue, or drop).
 */

import { getTask, listTasks, updateTask } from '../queue'
import { type ActionQueueKind, raiseActionQueueItem } from '../lib/action-queue'
import type { DispatchKind, InFlightEntry } from './task-flight-tracker'

export const PHANTOM_TASK_KIND: ActionQueueKind = 'phantom-task'

/** Default wall-clock ceiling: 30 minutes. */
export const DEFAULT_CEILING_MS = 30 * 60_000

/**
 * Override this daemon-wide progress ceiling with
 * `MARS_PHANTOM_WATCHDOG_CEILING_MS`. It applies only after a worker has
 * emitted activity; an alive worker that has not emitted an event is never
 * failed for silence, so no provider-specific first-event timeout is needed.
 */
const resolvedCeilingMs = (): number => {
  const raw = process.env.MARS_PHANTOM_WATCHDOG_CEILING_MS
  if (!raw) return DEFAULT_CEILING_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CEILING_MS
}

/**
 * Phantom-watchdog ceiling for tasks parked in `kind='merge'` (i.e. handed off
 * to the single-consumer merge queue). These tasks legitimately idle for the
 * duration of the merge operation, so they need a longer stall budget than a
 * running coder. The ceiling is read from `MARS_MERGE_WATCHDOG_MS` — the same
 * env var the merge worker uses for its own operation watchdog — defaulting to
 * twice the standard phantom ceiling (60 min) so the merge worker's own watchdog
 * always fires and self-heals before the phantom sweep arrives.
 */
const resolvedMergeCeilingMs = (): number => {
  const raw = process.env.MARS_MERGE_WATCHDOG_MS
  if (!raw) return 2 * DEFAULT_CEILING_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2 * DEFAULT_CEILING_MS
}

/** Default lease expiry window: 4 hours. */
export const DEFAULT_LEASE_EXPIRY_MS = 4 * 60 * 60_000

const resolvedLeaseExpiryMs = (): number => {
  const raw = process.env.MARS_LEASE_EXPIRY_MS
  if (!raw) return DEFAULT_LEASE_EXPIRY_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LEASE_EXPIRY_MS
}

/**
 * Build the human-readable action-queue item body for a phantom detection.
 * Exported for test assertions.
 *
 * @param taskId     Task identifier (used as fallback goal when prompt is absent).
 * @param status     The status the task was stuck in (kept for internal context;
 *                   not surfaced in the human-facing text).
 * @param reason     Detection mechanism ('dead-pid' | 'ceiling').
 * @param ageMinutes How long the task has been stuck, in minutes.
 * @param prompt     The task's prompt text; first line / first 60 chars used as
 *                   a plain-language goal summary.
 */
export const buildPhantomBody = (
  taskId: string,
  status: string,
  reason: 'dead-pid' | 'ceiling',
  ageMinutes: number,
  prompt?: string,
): string => {
  const goal =
    prompt?.split('\n')[0]?.trim().replace(/[.,:;!?]+$/, '').slice(0, 60) || `task ${taskId}`
  const reasonDetail =
    reason === 'dead-pid'
      ? `its worker process was not alive when checked`
      : `the worker made no progress for ${ageMinutes} min (ceiling: ${Math.round(resolvedCeilingMs() / 60_000)} min)`
  return (
    `"${goal}" stalled — ${reasonDetail}, so Mars stopped it. ` +
    `Restart to try again, or drop it if the work is no longer needed.`
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
 * @returns                IDs of every task that was auto-failed, and IDs of
 *                         every orphaned 'running' task that was re-queued as a
 *                         safety net (no in-flight entry from this daemon).
 */
export const sweepPhantomTasks = async (
  inFlightEntries: readonly InFlightEntry[],
  reclaimSlot: (taskId: string, kind: DispatchKind) => void,
  isAlive?: (pid: number) => boolean,
  nowMs?: number,
): Promise<{ failed: string[]; requeued: string[] }> => {
  const { isProcessAlive } = await import('./paths')
  const alive = isAlive ?? isProcessAlive
  const now = nowMs ?? Date.now()
  const ceiling = resolvedCeilingMs()

  // Index the in-flight snapshot for O(1) lookup by taskId.
  const inFlightByTask = new Map<string, InFlightEntry>(
    inFlightEntries.map((e) => [e.taskId, e]),
  )

  const failed: string[] = []
  const requeued: string[] = []

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
        // Alive PID: never ceiling-kill based on updatedAt staleness alone.
        // Use the activity heartbeat (lastActivityMs) instead — a coder
        // streaming output keeps this fresh, so long runs are never killed.
        if (phantomReason === null && entry.lastActivityMs !== undefined) {
          if (now - entry.lastActivityMs > ceiling) {
            phantomReason = 'ceiling'
          }
        }
      } else if (entry !== undefined) {
        // In-flight entry exists but PID not yet recorded — rely on the
        // wall-clock ceiling against updatedAt (bare-ceiling backstop).
        // Merge-parked tasks (kind='merge') use a longer ceiling because they
        // are legitimately idle while the single-consumer merge worker processes
        // their job; the merge worker's own watchdog self-heals them first.
        const updatedMs = Date.parse(task.updatedAt)
        const effectiveCeiling =
          entry.kind === 'merge' ? resolvedMergeCeilingMs() : ceiling
        if (!Number.isFinite(updatedMs) || now - updatedMs <= effectiveCeiling) continue
        phantomReason = 'ceiling'
      } else if (status === 'running') {
        // No in-flight entry AND task is 'running': this task is orphaned from
        // a prior daemon. The startup reconcile (requeue-stale-running) should
        // have re-queued it on boot, but either missed it (race) or the
        // updateTask call silently failed. Re-queue as a safety net rather than
        // phantom-failing — the task has not been worked on by this daemon at all.
        const updatedMs = Date.parse(task.updatedAt)
        if (!Number.isFinite(updatedMs) || now - updatedMs <= ceiling) continue
        // Attempt the re-queue. If the DB write fails, leave the task as-is;
        // the next sweep will retry.
        //
        // The pointers CANNOT be nulled without also discarding the run
        // journal: a task orphaned mid-run has `setup` recorded 'completed', so
        // the next dispatch short-circuits it, finds no worktree (we just
        // nulled the pointers), and throws "no worktree available" — the exact
        // shape of the mars-c11be862 overnight loop. resetForSetupReplay is the
        // one seam that does both halves; `mars restart` uses the same one.
        const { resetForSetupReplay } = await import('./restart-task')
        const { createQueueWorkflowStore } = await import(
          '../../workflows/queue-workflow-store'
        )
        const replayPatch = await resetForSetupReplay(
          task.id,
          createQueueWorkflowStore(),
        ).catch(() => null)
        if (replayPatch === null) {
          // Journal delete failed — re-queueing now would resume into the
          // skipped-setup loop. Leave the row alone; the next sweep retries.
          continue
        }
        await updateTask(task.id, {
          status: 'queued',
          ...replayPatch,
          error: null,
          failedPhase: null,
          failureSignature: null,
          failureReasonCode: null,
        }).catch(() => {})
        const recheckd = await getTask(task.id).catch(() => null)
        if (recheckd?.status === 'queued') requeued.push(task.id)
        continue
      } else {
        // 'verifying' (or any future status) with no in-flight entry: fall back
        // to the wall-clock ceiling backstop. The startup reconcile's
        // verifying-recovery step handles this case; this is the safety net.
        const updatedMs = Date.parse(task.updatedAt)
        if (!Number.isFinite(updatedMs) || now - updatedMs <= ceiling) continue
        phantomReason = 'ceiling'
      }

      if (phantomReason === null) continue

      const ageMinutes = Math.round((now - Date.parse(task.updatedAt)) / 60_000)
      const failedPhase = FAILED_PHASE_FOR_STATUS[status]
      const observation =
        phantomReason === 'dead-pid'
          ? `worker PID ${entry?.pid ?? 'unrecorded'} was not alive when checked; last event: ${entry?.lastActivityMs === undefined ? 'none recorded' : new Date(entry.lastActivityMs).toISOString()}`
          : entry?.lastActivityMs !== undefined
            ? `worker PID ${entry.pid} was alive but its event stream was silent for ${Math.round((now - entry.lastActivityMs) / 60_000)} min (ceiling: ${Math.round(ceiling / 60_000)} min)`
            : `no worker PID was recorded and the task row was unchanged for ${ageMinutes} min (ceiling: ${Math.round(ceiling / 60_000)} min)`

      // Mark the task failed BEFORE reclaiming the slot so there is never a
      // window where the slot is free but the task is still 'running'.
      await updateTask(task.id, {
        status: 'failed',
        failedPhase,
        failureReason: `phantom-task watchdog: ${phantomReason}`,
        failureReasonCode: `phantom-task:${phantomReason}`,
        error: `Task auto-failed by phantom-task watchdog (reason: ${phantomReason}; observation: ${observation}; task age: ${ageMinutes} min)`,
      }).catch(() => {
        // Best-effort: if the write fails, skip the reclaim and item raise to
        // avoid inconsistency (don't free the slot if the row stays 'running').
      })

      // Verify the write landed before reclaiming.
      const updated = await getTask(task.id).catch(() => null)
      if (updated?.status !== 'failed') continue

      if (entry) {
        reclaimSlot(task.id, entry.kind)
      }

      // Raise exactly one action-queue item per phantom; dedup by taskId so
      // re-detections bump seen_count rather than spawning siblings.
      const shortGoal =
        task.prompt?.split('\n')[0]?.trim().replace(/[.,:;!?]+$/, '').slice(0, 60) || task.id
      await raiseActionQueueItem({
        kind: PHANTOM_TASK_KIND,
        category: 'daemon',
        priority: 'high',
        title: `Stuck ${ageMinutes} min: ${shortGoal}`,
        body: buildPhantomBody(task.id, status, phantomReason, ageMinutes, task.prompt),
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

  return { failed, requeued }
}

/**
 * Sweep tasks parked in 'awaiting-human' whose lease has exceeded the expiry
 * window and raise a level-triggered action-queue row for each (ADR-0048).
 *
 * NEVER auto-fails the task — lease expiry is an advisory alert, not a kill
 * signal. The operator resolves the situation explicitly (release the lease and
 * re-queue, or drop the task). This upholds the phantom-watchdog rule: a task
 * in a parked status with an active lease is NEVER phantom-failed.
 *
 * The action-queue row's `signature` is `lease-expiry:<taskId>`, so repeated
 * sweep detections bump `seen_count` on the existing row rather than spawning
 * siblings (level-triggered, ADR-0048).
 *
 * @param nowMs  Current timestamp override for testing.
 * @returns      IDs of tasks whose expired lease triggered a new alert row.
 */
export const sweepExpiredLeases = async (
  nowMs?: number,
): Promise<{ alerted: string[] }> => {
  const now = nowMs ?? Date.now()
  const expiry = resolvedLeaseExpiryMs()
  const tasks = await listTasks('awaiting-human')
  const alerted: string[] = []

  for (const task of tasks) {
    if (!task.leasedAt) continue
    const leasedMs = Date.parse(task.leasedAt)
    if (!Number.isFinite(leasedMs)) continue
    const ageMs = now - leasedMs
    if (ageMs <= expiry) continue

    const ageMinutes = Math.round(ageMs / 60_000)
    await raiseActionQueueItem({
      kind: 'awaiting-human',
      category: 'daemon',
      priority: 'normal',
      title: `Lease expired: task ${task.id} awaiting human for ${ageMinutes} min`,
      body:
        `Task ${task.id} has been parked in 'awaiting-human' for ${ageMinutes} min ` +
        `(expiry threshold: ${Math.round(expiry / 60_000)} min). ` +
        `Lease holder: ${task.leaseOwner ?? 'unknown'}. ` +
        `Release the lease to resume the pipeline, or drop the task if the work is abandoned.`,
      payload: {
        taskId: task.id,
        leaseOwner: task.leaseOwner,
        leasedAt: task.leasedAt,
        leaseNote: task.leaseNote,
        ageMinutes,
      },
      context: { taskId: task.id },
      raisedBy: 'daemon:phantom-task-watchdog',
      signature: `lease-expiry:${task.id}`,
      originTaskId: task.id,
      occurrence: {
        leaseOwner: task.leaseOwner,
        ageMinutes,
        detectedAt: new Date(now).toISOString(),
      },
    }).catch(() => {
      // Non-fatal: the task remains parked and the operator will see it via
      // status/list even if the action-queue write failed.
    })

    alerted.push(task.id)
  }

  return { alerted }
}
