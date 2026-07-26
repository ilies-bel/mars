/**
 * requeue-ceiling — time-based backstop on poll-fallback re-seeding.
 *
 * Root cause of the 2026-07-02 overnight loop (mars-c11be862 post-mortem):
 * when a worktree path is nulled but the setup-worktree checkpoint survives,
 * every re-dispatch skips setup, throws "no worktree available", and the
 * poll-fallback re-seeds the task 30 s later — indefinitely. Eight tasks
 * reached 1,014 step attempts overnight.
 *
 * Fix 2 of 2: the poll-fallback calls {@link checkAndEscalateRequeueCeiling}
 * before re-seeding each queued task. If the task has been retrying beyond
 * {@link REQUEUE_MAX_RETRY_MS} wall-clock time without completing, the task is
 * moved to `failed` and an operator action-queue item is raised.
 *
 * A task with fewer than 1 step attempts is never escalated — it has not
 * entered the re-queue cycle yet.
 *
 * Retry count and elapsed retry time are logged on every poll cycle for any
 * task that has been attempted at least once, so an operator can see the state
 * without waiting for the time bound to be reached.
 *
 * Fix 1 (preserve worktree pointers on restart) lives in phase-recovery.ts;
 * this ceiling is a defence-in-depth backstop for any path that still re-queues
 * without making step progress.
 */

import type { WorkflowStore } from '@mars/workflow'
import { raiseActionQueueItem } from '../lib/action-queue'
import { updateTask, type Task } from '../queue'

/**
 * Maximum wall-clock time (ms) a task may spend in the re-queue cycle before
 * the poll-fallback escalates it to `failed`. Configurable via
 * `MARS_REQUEUE_MAX_RETRY_MS`; defaults to 2 hours.
 *
 * Set to `Infinity` (via the env var) to allow truly unbounded retries — but
 * note that removes the loop-protection backstop introduced for mars-c11be862.
 */
export const REQUEUE_MAX_RETRY_MS: number = Number(
  process.env.MARS_REQUEUE_MAX_RETRY_MS ?? 2 * 60 * 60 * 1_000,
)

/**
 * Check whether task `t` has been retrying longer than the wall-clock bound.
 *
 * For any task that has been attempted at least once, this function logs the
 * current attempt count and elapsed retry time so the state is always visible.
 *
 * If the time bound is exceeded, the task is failed and an operator
 * action-queue item is raised.
 *
 * @param nowMs - injectable clock for testing; defaults to `Date.now()`.
 * @returns `true` if the task was escalated (caller must NOT re-seed it);
 *          `false` if the task is within the time bound or has not been
 *          attempted yet (caller may proceed to `tracker.enqueuePending`).
 */
export const checkAndEscalateRequeueCeiling = async (
  t: Task,
  store: WorkflowStore,
  log: (msg: string) => void,
  nowMs: number = Date.now(),
): Promise<boolean> => {
  const steps = await store.listSteps(t.id).catch(() => [])
  const maxAttempt =
    steps.length > 0 ? Math.max(...steps.map((s) => s.attempt)) : 0

  // A fresh task with no step records is not stuck in the re-queue cycle.
  if (maxAttempt === 0) return false

  // Compute the retry-start anchor: earliest step startedAt (if any step has
  // a valid non-zero timestamp), falling back to the task's createdAt field.
  // Note: the createdAt approximation is documented in the JSDoc above.
  const stepTimestamps = steps.map((s) => s.startedAt).filter((ts) => ts > 0)
  const retryStartMs =
    stepTimestamps.length > 0
      ? Math.min(...stepTimestamps)
      : new Date(t.createdAt).getTime()

  const elapsedMs = nowMs - retryStartMs
  const elapsedMins = Math.round(elapsedMs / 60_000)

  // Log retry extent on every poll cycle so the state is visible before
  // the time bound is reached.
  log(
    `[dispatch] task ${t.id} still retrying: attempt ${maxAttempt}, ${elapsedMins}m elapsed`,
  )

  if (elapsedMs < REQUEUE_MAX_RETRY_MS) return false

  const boundMins = Math.round(REQUEUE_MAX_RETRY_MS / 60_000)
  log(
    `[dispatch] poll-fallback: task ${t.id} exceeded retry time bound ` +
      `(${elapsedMins}m elapsed, bound ${boundMins}m, ${maxAttempt} attempt(s)); ` +
      `escalating to failed`,
  )

  // `failureReason` must be a step-id-grammar value so the signature minted
  // by recovery-spawn.ts is stable across occurrences. The varying measurements
  // (attempt count, elapsed minutes) belong in `error` and the action-queue
  // body — not in the identity field. Do NOT set `failedPhase` here: it is
  // typed `code | verify | merge` (queue.ts) and the ceiling fires at dispatch
  // level, outside all three phases.
  await updateTask(t.id, {
    status: 'failed',
    error:
      `Re-queue time bound exceeded: task retried ${maxAttempt} time(s) ` +
      `over ${elapsedMins} minutes without completing ` +
      `(bound ${boundMins}m). ` +
      `Run \`mars restart ${t.id}\` to reset.`,
    failureReason: 'requeue:time-bound-exceeded',
    failureReasonCode: 'requeue-time-bound-exceeded',
  }).catch(() => {})

  await raiseActionQueueItem({
    kind: 'failed',
    category: 'orchestrator',
    priority: 'high',
    title: `Task ${t.id}: re-queue time bound exceeded`,
    body:
      `Task was re-dispatched ${maxAttempt} time(s) over ${elapsedMins} minutes ` +
      `without completing (bound ${boundMins}m). ` +
      `Likely a stale checkpoint / worktree mismatch. ` +
      `Run \`mars restart ${t.id}\` to reset.`,
    payload: {
      taskId: t.id,
      maxAttempt,
      elapsedMs,
      boundMs: REQUEUE_MAX_RETRY_MS,
    },
    context: {},
    raisedBy: 'daemon:poll-fallback',
    signature: `requeue-ceiling:${t.id}`,
    originTaskId: t.id,
  }).catch(() => {})

  return true
}
