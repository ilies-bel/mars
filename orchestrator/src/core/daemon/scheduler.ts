import type { EventEmitter } from 'node:events'
import type { Semaphore } from './semaphore'
import { getCompositionRootClient } from '../store/task-store'
import { getTask, hasIncompleteBlockers, listTasks, updateTask, type Task } from '../queue'
import type { PauseController } from './pause-state'
import type { DispatchKind, TaskFlightTracker } from './task-flight-tracker'
import { resolveSchedulerIntervalsMs } from '../config/daemon-intervals'

/**
 * Named type for the daemon's per-kind dispatch semaphores. Pulled out of an
 * inline literal so the scheduling closures and the HTTP route-registration
 * deps, both of which read `sems`, can reference the same shape instead of
 * each re-deriving it structurally.
 */
export type DaemonSemaphores = Record<
  Exclude<
    DispatchKind,
    'merge' | 'arc-verify' | 'glossary-write' | 'adr-add' | 'adr-supersede' | 'vision'
  >,
  Semaphore
> & {
  arcVerify: Semaphore
}

/**
 * A pending implement candidate captured during the first phase of
 * {@link pickNextImplement}. Exported so the pure comparator can be unit-tested
 * without mounting a live daemon.
 */
export interface PickCandidate {
  id: string
  priority: number
  createdAt: string
  /** Arc root id (task.originId). Null is treated as "not started". */
  originId: string | null
}

/**
 * Pure comparator used by {@link pickNextImplement} — exported for unit tests.
 *
 * Selection order (earlier rule wins):
 * 1. Higher `priority` wins.
 * 2. At equal priority, a candidate whose `originId` is in `startedOriginIds`
 *    beats one that is not (prefer in-flight arcs over fresh ones).
 * 3. At equal priority and equal started-flag, older `createdAt` wins (FIFO).
 *
 * A null `originId` is never considered started.
 */
export function selectBestCandidate(
  candidates: PickCandidate[],
  startedOriginIds: Set<string>,
): PickCandidate | null {
  let best: PickCandidate | null = null
  for (const c of candidates) {
    if (best === null) {
      best = c
      continue
    }
    // Rule 1: higher priority always wins.
    if (c.priority > best.priority) { best = c; continue }
    if (c.priority < best.priority) continue
    // Rule 2: at equal priority, started-origin beats non-started.
    const cStarted = c.originId !== null && startedOriginIds.has(c.originId)
    const bStarted = best.originId !== null && startedOriginIds.has(best.originId)
    if (cStarted && !bStarted) { best = c; continue }
    if (!cStarted && bStarted) continue
    // Rule 3: older createdAt wins (FIFO fallback).
    if (c.createdAt < best.createdAt) best = c
  }
  return best
}

/**
 * Dependencies `startScheduler` needs from `startDaemon`. Everything here is
 * either a per-daemon-instance closure/collection (bus, tracker, sems, pause)
 * or a callback into the dispatch-execution logic that stays in server.ts
 * (dispatchTriage/dispatchImplement/dispatchArcVerification actually spawn
 * worktrees and worker processes — that is execution, not scheduling).
 */
export interface SchedulerDeps {
  bus: EventEmitter
  tracker: TaskFlightTracker
  sems: DaemonSemaphores
  log: (line: string) => void
  pause: PauseController
  /** Reads the daemon's mutable `acceptingWork` flag (false during shutdown). */
  getAcceptingWork: () => boolean
  dispatchArcVerification: (originId: string) => Promise<void>
  /** Set of origin ids awaiting best-effort arc verification. */
  pendingArcVerifications: Set<string>
  dispatchTriage: (taskId: string) => Promise<void>
  dispatchImplement: (task: Task) => Promise<void>
  /** Dispatch uptime, used by the poll-fallback tick's requeue-ceiling check. */
  getDispatchUptimeMs: () => number | undefined
}

export interface SchedulerHandle {
  /**
   * Drain pulls from the pending sets as semaphore slots free. Bus handlers
   * and dispatcher finally-blocks both call this. It's idempotent and cheap
   * when there's nothing to do. Single-flight: only one drain runs at a time.
   */
  drain: () => Promise<void>
  /** Clears the poll-fallback and queued-dispatch-sweep intervals. */
  stop: () => void
}

/**
 * Owns dispatch scheduling: the single-flight `drain` loop that decides which
 * pending triage/implement/arc-verify candidate to dispatch next, plus the two
 * timer-driven backstops that re-arm `drain` if a bus event was missed or a
 * drain pass threw (poll-fallback tick, queued-dispatch sweep). Per-task
 * dispatch EXECUTION (spawning worktrees, running providers, verify, merge)
 * stays in server.ts and is invoked here only via the `dispatchTriage` /
 * `dispatchImplement` / `dispatchArcVerification` callbacks.
 */
export const startScheduler = (deps: SchedulerDeps): SchedulerHandle => {
  const {
    bus,
    tracker,
    sems,
    log,
    pause,
    getAcceptingWork,
    dispatchArcVerification,
    pendingArcVerifications,
    dispatchTriage,
    dispatchImplement,
    getDispatchUptimeMs,
  } = deps
  // Read once per `startScheduler` call (per daemon boot) — see
  // ../config/daemon-intervals.ts for why this is the one place the
  // underlying env is read.
  const schedulerIntervalsMs = resolveSchedulerIntervalsMs()

  // Pick the highest-priority pending task. Ties broken first by whether the
  // task's arc has already started (a sibling in running/verifying/merging/done),
  // then by oldest createdAt (FIFO). Returns null if no pending row resolves
  // to a real task (drained while we looked).
  const pickNextImplement = async (): Promise<string | null> => {
    // Phase 1: collect all eligible candidates.
    const candidates: PickCandidate[] = []
    for (const id of tracker.drainPending('implement')) {
      // Skip ids already claimed by an in-flight (or about-to-be-in-flight)
      // dispatch — without this the same id can be picked by parallel
      // drains during the gap between pop-from-pending and acquire-slot.
      if (tracker.isClaimed(id, 'implement') || tracker.isInFlight(id)) continue
      const t = await getTask(id)
      if (!t) continue
      candidates.push({ id, priority: t.priority, createdAt: t.createdAt, originId: t.originId ?? null })
    }
    if (candidates.length === 0) return null

    // Phase 2: determine which origins already have started siblings.
    // An origin is STARTED iff any task with origin_id = <that id> has a
    // status in ('running','verifying','merging','done').
    // Guard the empty-candidate case so we never send an empty IN ().
    const distinctOriginIds = [
      ...new Set(
        candidates
          .map((c) => c.originId)
          .filter((o): o is string => o !== null),
      ),
    ]
    let startedOriginIds = new Set<string>()
    if (distinctOriginIds.length > 0) {
      const placeholders = distinctOriginIds.map(() => '?').join(', ')
      const { rows: startedRows } = await getCompositionRootClient().execute({
        sql: `SELECT DISTINCT origin_id
                FROM tasks
               WHERE origin_id IN (${placeholders})
                 AND status IN ('running', 'verifying', 'merging', 'done')`,
        args: distinctOriginIds,
      })
      startedOriginIds = new Set(
        startedRows.map((r) => r['origin_id'] as string),
      )
    }

    // Phase 3: pick the best candidate by the three-level comparator.
    return selectBestCandidate(candidates, startedOriginIds)?.id ?? null
  }

  // Drain single-flight gate. While `drainRunning` is true, a second call
  // sets `drainAgain` and returns; the running drain re-runs once it finishes.
  let drainRunning = false
  let drainAgain = false

  // Drain pulls from the pending sets as semaphore slots free. Bus handlers
  // and dispatcher finally-blocks both call this. It's idempotent and cheap
  // when there's nothing to do.
  // Single-flight: only one drain runs at a time. Concurrent invocations
  // (from bus events, dispatcher finally-blocks, etc.) flip drainAgain so
  // the running drain re-enters once it finishes — no double-pick races.
  const drain = async (): Promise<void> => {
    if (!getAcceptingWork()) return
    if (pause.isPaused()) return
    if (drainRunning) {
      drainAgain = true
      return
    }
    drainRunning = true
    try {
      do {
        drainAgain = false
        // A throw from any await below (getTask / hasIncompleteBlockers
        // hitting a transient connection or query error under load)
        // must not escape: drain() is invoked fire-and-forget
        // (`void drain()`), so an uncaught rejection silently kills the
        // loop with no log line and the daemon stops claiming work while
        // staying alive. Catch per-pass, log, and let the do/while exit
        // cleanly — the poll-fallback tick (or the next bus event) retries.
        try {
          // Arc verification: the outbox subscriber only queues an admitted
          // origin here. Start it through the same drain-owned acquire/release
          // lifecycle as other daemon work; excess events were shed on entry.
          while (sems.arcVerify.inUse < sems.arcVerify.limit) {
            const originId = pendingArcVerifications.values().next().value
            if (originId === undefined) break
            void dispatchArcVerification(originId)
          }

          // Triage: pick a candidate that isn't already claimed/in-flight,
          // mark it claimed BEFORE the dispatchTriage call so the next drain
          // pass can't pick it again. tracker.claim returns false when the id
          // is already claimed/in-flight, folding the old has-checks in.
          while (sems.triage.inUse < sems.triage.limit) {
            let pickedTriage: string | null = null
            for (const id of tracker.drainPending('triage')) {
              if (!tracker.claim(id, 'triage')) continue
              pickedTriage = id
              break
            }
            if (pickedTriage === null) break
            tracker.removePending(pickedTriage, 'triage')
            void dispatchTriage(pickedTriage)
          }
          // Implement: same guarantee but priority-ordered.
          while (sems.implement.inUse < sems.implement.limit) {
            const id = await pickNextImplement()
            if (id === null) break
            // Mark claimed BEFORE any further await so concurrent drains
            // (which we've gated, but belt-and-suspenders) can't double-pick.
            tracker.claim(id, 'implement')
            tracker.removePending(id, 'implement')
            const t = await getTask(id)
            if (!t || t.status !== 'queued') {
              tracker.unclaim(id, 'implement')
              continue
            }
            if (await hasIncompleteBlockers(id)) {
              // Distinguish terminal (failed) blockers so operators know when
              // manual intervention is required vs. waiting for in-progress work.
              const { rows: failedBlockerRows } = await getCompositionRootClient().execute({
                sql: `SELECT b.blocker_task_id
                        FROM task_blockers b
                        JOIN tasks t ON t.id = b.blocker_task_id
                       WHERE b.task_id = ? AND t.status = 'failed'
                         AND b.state IN ('confirmed', 'pending-review')
                       LIMIT 1`,
                args: [id],
              })
              if (failedBlockerRows.length > 0) {
                const failedId = (failedBlockerRows[0] as unknown as { blocker_task_id: string }).blocker_task_id
                log(`[dispatch] ${id} blocked; blocker ${failedId} is failed and will never complete — needs operator`)
              } else {
                log(`[dispatch] ${id} blocked; deferring until blockers complete`)
              }
              tracker.unclaim(id, 'implement')
              continue
            }
            // Stale-recovery guard: if this is a fix or rescue task whose
            // arc root origin has already reached 'done', drop it without
            // dispatching. Handles the race where the origin succeeds (e.g.
            // via auto-remerge) between when the recovery was enqueued and
            // when the dispatch loop picks it up.
            //
            // - Fix tasks:    kind='fix'. Use t.originId (the arc root) rather
            //   than t.fixForTaskId (the immediate target) so that fix tasks
            //   targeting a rescue-operator are also caught: their
            //   fixForTaskId points at the rescue task (which may not be
            //   'done'), but their originId points at the true arc root.
            // - Rescue tasks: tagged 'rescue-operator', originId != self.
            {
              const recoveryOriginId =
                t.kind === 'fix' && t.fixForTaskId != null
                  ? t.originId  // arc root; always populated on fix tasks
                  : t.tags.includes('rescue-operator') && t.originId !== t.id
                    ? t.originId
                    : null
              if (recoveryOriginId !== null) {
                const origin = await getTask(recoveryOriginId)
                if (origin?.status === 'done') {
                  log(
                    `[dispatch] dropping stale recovery ${t.id} (kind=${t.kind ?? 'task'}): origin ${recoveryOriginId} already done`,
                  )
                  await updateTask(t.id, {
                    status: 'dropped',
                    dropReason: 'origin-succeeded',
                    error: `Origin ${recoveryOriginId} reached done; stale recovery dropped at dispatch`,
                  }).catch((err) =>
                    log(
                      `[dispatch] drop stale recovery ${t.id}: ${(err as Error).message}`,
                    ),
                  )
                  tracker.unclaim(id, 'implement')
                  void drain()
                  continue
                }
              }
            }
            void dispatchImplement(t)
          }
        } catch (err) {
          // Log and stop this drain. drainAgain is left as-is so a pending
          // re-entry request still re-runs; otherwise the poll-fallback
          // tick picks the queue back up on its next interval.
          log(
            `[dispatch] drain pass errored (will retry): ${
              (err as Error).message
            }`,
          )
          break
        }
      } while (drainAgain)
    } finally {
      drainRunning = false
    }
  }

  // ── Poll-fallback tick ────────────────────────────────────────────────────
  // drain() is otherwise purely event-driven (bus 'task.added'/'task.queued'
  // and dispatcher finally-blocks). If a drain pass throws and exits, or a
  // bus emit is missed, nothing re-arms it and the daemon sits idle with a
  // full queue while staying alive — the failure mode this fixes. This timer
  // is a safety net: only when the daemon is accepting work, not draining,
  // and has nothing in flight (i.e. genuinely wedged, not just busy) does it
  // re-seed the pending sets from the DB and kick drain(). During healthy
  // operation it is a no-op. .unref() so it never keeps the process alive.
  //
  // Re-queue loop defence (mars-c11be862 post-mortem, 2026-07-02): before
  // re-seeding any queued task, we check its retry duration. A task retrying
  // longer than MARS_REQUEUE_MAX_RETRY_MS of dispatch uptime (default 2 h)
  // without completing is
  // escalated to 'failed' + an operator action-queue item rather than re-seeded.
  // Retry count and elapsed time are logged for any task that has been attempted
  // at least once so the state is visible before the bound is reached.
  // See orchestrator/src/core/daemon/requeue-ceiling.ts for the ceiling logic.
  const POLL_FALLBACK_MS = schedulerIntervalsMs.pollFallback
  const pollFallback = setInterval(() => {
    if (!getAcceptingWork() || pause.isPaused() || drainRunning || tracker.inFlightCount() > 0) return
    void (async () => {
      try {
        const [drafts, queued] = await Promise.all([
          listTasks('draft'),
          listTasks('queued'),
        ])
        const seedable = drafts.length + queued.length
        if (seedable === 0) return
        for (const t of drafts) {
          if (!tracker.isInFlight(t.id)) tracker.enqueuePending(t.id, 'triage')
        }
        const { createQueueWorkflowStore: makeWFStore } = await import(
          '../../workflows/queue-workflow-store'
        )
        const { checkAndEscalateRequeueCeiling } = await import('./requeue-ceiling')
        const wfStore = makeWFStore()
        for (const t of queued) {
          if (tracker.isInFlight(t.id)) continue
          const escalated = await checkAndEscalateRequeueCeiling(
            t,
            wfStore,
            log,
            Date.now(),
            getDispatchUptimeMs(),
          )
          if (!escalated) tracker.enqueuePending(t.id, 'implement')
        }
        log(
          `[dispatch] poll-fallback re-seeding ${seedable} task(s) (idle with non-empty queue)`,
        )
        await drain()
      } catch (err) {
        log(`[dispatch] poll-fallback errored: ${(err as Error).message}`)
      }
    })()
  }, POLL_FALLBACK_MS)
  pollFallback.unref()

  // ── Queued-dispatch sweep ─────────────────────────────────────────────────
  // Writers inside the daemon normally call the dispatch-hint seam immediately
  // after their transaction commits. This periodic DB re-read is the durable
  // backstop for a missed hint: unlike pollFallback it also runs while other
  // workers are active, so one forgotten handoff cannot strand a queued row
  // until the daemon goes idle or restarts. Re-emitting task.queued intentionally
  // takes the normal bus path, which feeds pendingImplement and invokes drain();
  // drain then re-reads the row and validates its status and blockers before it
  // can claim a worker slot.
  const QUEUED_DISPATCH_SWEEP_MS = schedulerIntervalsMs.queuedDispatchSweep
  const queuedDispatchSweep = setInterval(() => {
    if (!getAcceptingWork() || pause.isPaused()) return
    void (async () => {
      try {
        const queued = await listTasks('queued')
        for (const task of queued) {
          if (!tracker.isInFlight(task.id)) {
            bus.emit('task.queued', { taskId: task.id })
          }
        }
      } catch (err) {
        log(`[queued-dispatch-sweep] errored: ${(err as Error).message}`)
      }
    })()
  }, QUEUED_DISPATCH_SWEEP_MS)
  queuedDispatchSweep.unref()

  return {
    drain,
    stop: () => {
      clearInterval(pollFallback)
      clearInterval(queuedDispatchSweep)
    },
  }
}
