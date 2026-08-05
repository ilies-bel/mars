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
 * before re-seeding each queued task. TWO independent bounds escalate it to
 * `failed` with an operator action-queue item — whichever trips first:
 *
 *  - {@link REQUEUE_MAX_RETRY_MS} — dispatch-enabled daemon uptime spent in the
 *    re-queue cycle without completing. Catches the slow strand.
 *  - {@link REQUEUE_MAX_ATTEMPTS} — step attempts accumulated. Catches the hot
 *    loop, which can rack up dozens of attempts well inside the time bound.
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

import fs from 'node:fs'
import path from 'node:path'
import type { WorkflowStore } from '@mars/workflow'
import { raiseActionQueueItem } from '../lib/action-queue'
import { updateTask, listTasks, type Task } from '../queue'
import {
  computeStepWindow,
  computeAttemptDensity,
  computeBlockedWaitMs,
  classifyRequeueBreach,
} from './requeue-diagnostics'
import { RingBuffer, collectStallDiagnostics } from '../workers/stall-diagnostics'

/**
 * Maximum dispatch-enabled daemon uptime (ms) a task may spend in the re-queue cycle before
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
 * When effective elapsed time reaches this fraction of REQUEUE_MAX_RETRY_MS,
 * a low-priority warning action-queue item is raised so the operator sees the
 * task approaching the ceiling before it is escalated. Deduped by signature.
 */
export const REQUEUE_WARN_RATIO: number = Number(
  process.env.MARS_REQUEUE_WARN_RATIO ?? 0.8,
)

/**
 * Maximum step attempts a task may accumulate before the poll-fallback
 * escalates it, independent of the clock. Configurable via
 * `MARS_REQUEUE_MAX_ATTEMPTS`; defaults to 12.
 *
 * {@link REQUEUE_MAX_RETRY_MS} alone does not bound a HOT loop. A task that
 * re-queues on a ~60 s cycle burns attempts far faster than dispatch uptime:
 * mars-6cf9774f reached verify attempt 37 in 35 minutes — under a third of the
 * 2 h bound — and the 2026-07-02 post-mortem recorded eight tasks at 1,014
 * attempts overnight. Time answers "has this been stuck too long?"; attempts
 * answer "is this making progress at all?", and a re-queue cycle that has
 * re-run the same step a dozen times has answered no.
 *
 * Set to `Infinity` (via the env var) to disable the attempt bound and rely on
 * the time bound alone.
 */
export const REQUEUE_MAX_ATTEMPTS: number = Number(
  process.env.MARS_REQUEUE_MAX_ATTEMPTS ?? 12,
)

/**
 * Check whether task `t` has been retrying longer than the dispatch-uptime bound.
 *
 * For any task that has been attempted at least once, this function logs the
 * current attempt count and elapsed retry time so the state is always visible.
 *
 * If the time bound is exceeded, the task is failed and an operator
 * action-queue item is raised. The failure reason code is derived from the
 * breach classifier: one of `'requeue-retry-churn'`, `'requeue-blocked-wait'`,
 * `'requeue-queue-starvation'`, or `'requeue-long-running'`.
 *
 * The action-queue payload carries a `diagnostics` object with:
 * `{ class, attemptDensityPerMin, stepWindowMs, blockedWaitMs, maxAttempt,
 * queuedNeighbourCount }`.
 *
 * @param nowMs - injectable clock for testing; defaults to `Date.now()`.
 * @param dispatchUptimeMs - cumulative milliseconds that a live daemon had
 *   dispatch enabled. This counter is persisted across daemon restarts and
 *   stops advancing while paused, so its delta from the task's first dispatch
 *   excludes both pauses and downtime.
 * @returns `true` if the task was escalated (caller must NOT re-seed it);
 *          `false` if the task is within the time bound or has not been
 *          attempted yet (caller may proceed to `tracker.enqueuePending`).
 */
export const checkAndEscalateRequeueCeiling = async (
  t: Task,
  store: WorkflowStore,
  log: (msg: string) => void,
  nowMs: number = Date.now(),
  dispatchUptimeMs?: number,
): Promise<boolean> => {
  const steps = await store.listSteps(t.id).catch(() => [])
  const maxAttempt =
    steps.length > 0 ? Math.max(...steps.map((s) => s.attempt)) : 0

  // A fresh task with no step records is not stuck in the re-queue cycle.
  if (maxAttempt === 0) return false

  // Quota-rejected attempts (provider rate/spend-limit rejections) do not
  // represent work the coder performed: the coder never ran, the worktree is
  // untouched, and the rejection is a fleet-wide environmental condition that
  // no per-task retry can resolve. Subtracting them from the attempt count
  // gives the number of real dispatch attempts that count toward the ceiling.
  const effectiveAttempts = Math.max(0, maxAttempt - (t.quotaRejectedAttempts ?? 0))
  if (effectiveAttempts === 0) return false

  // Compute the retry-start anchor.
  //
  // Preference order:
  //   1. t.requeueAnchorMs — set by `mars continue` to the moment the operator
  //      re-queued the task.  Preserving the journal is the entire point of
  //      `mars continue` (checkpoint-resume), so step timestamps from a prior
  //      run could be hours or days old; the anchor must reflect the *current*
  //      episode, not the history.  `mars restart` clears this to null so a
  //      restarted task falls through to (2).
  //   2. MIN(step.startedAt) for steps with a positive timestamp — the original
  //      probe for the hot-loop backstop (mars-c11be862).  Covers poll-fallback
  //      re-seeds that never call `mars continue`.
  //   3. task.createdAt — last resort when no step has a positive timestamp.
  const stepTimestamps = steps.map((s) => s.startedAt).filter((ts) => ts > 0)
  const retryStartMs =
    t.requeueAnchorMs !== null && t.requeueAnchorMs !== undefined
      ? t.requeueAnchorMs
      : stepTimestamps.length > 0
        ? Math.min(...stepTimestamps)
        : new Date(t.createdAt).getTime()

  const elapsedMs = nowMs - retryStartMs
  // Persisting the first observed counter for a legacy task is deliberately a
  // one-time migration safety valve: rows dispatched before this field existed
  // have no reliable way to reconstruct historic pauses or downtime.
  if (
    dispatchUptimeMs !== undefined &&
    (t.requeueDispatchUptimeMs === null || t.requeueDispatchUptimeMs === undefined)
  ) {
    await updateTask(t.id, { requeueDispatchUptimeMs: dispatchUptimeMs }).catch(() => {})
  }
  const effectiveElapsedMs =
    dispatchUptimeMs !== undefined &&
    t.requeueDispatchUptimeMs !== null &&
    t.requeueDispatchUptimeMs !== undefined
      ? Math.max(0, dispatchUptimeMs - t.requeueDispatchUptimeMs)
      : dispatchUptimeMs !== undefined
        ? 0
        : elapsedMs
  const effectiveElapsedMins = Math.round(effectiveElapsedMs / 60_000)

  // Log retry extent on every poll cycle so the state is visible before
  // the time bound is reached.
  log(
    `[dispatch] task ${t.id} still retrying: attempt ${maxAttempt}, ${effectiveElapsedMins}m dispatch uptime elapsed`,
  )

  // Either bound trips the escalation. `attemptsExceeded` is checked as a peer
  // of the time bound rather than nested inside it so a hot loop escalates on
  // its attempt count even while it is nowhere near the dispatch-uptime bound.
  // Use effectiveAttempts (real attempts minus quota-rejected attempts) so a
  // provider quota wall does not burn the ceiling.
  const attemptsExceeded = effectiveAttempts >= REQUEUE_MAX_ATTEMPTS
  if (effectiveElapsedMs < REQUEUE_MAX_RETRY_MS && !attemptsExceeded) {
    // ── Early warning ───────────────────────────────────────────────────────
    if (
      REQUEUE_MAX_RETRY_MS > 0 &&
      effectiveElapsedMs >= REQUEUE_MAX_RETRY_MS * REQUEUE_WARN_RATIO
    ) {
      const boundMins = Math.round(REQUEUE_MAX_RETRY_MS / 60_000)
      const stepWindow = computeStepWindow(steps)
      const breachClass = classifyRequeueBreach(t, stepWindow, 0, effectiveElapsedMs)
      await raiseActionQueueItem({
        kind: 'requeue-warning',
        category: 'orchestrator',
        priority: 'low',
        title: `Task ${t.id}: approaching requeue ceiling (${breachClass.kind})`,
        body:
          `Dispatch uptime ${effectiveElapsedMins}m of bound ${boundMins}m; ` +
          `predicted class ${breachClass.kind}.`,
        payload: {
          taskId: t.id,
          diagnostics: {
            class: breachClass.kind,
            maxAttempt,
            elapsedMs: effectiveElapsedMs,
            boundMs: REQUEUE_MAX_RETRY_MS,
          },
        },
        context: {},
        raisedBy: 'daemon:poll-fallback',
        signature: `requeue-warning:${t.id}`,
        originTaskId: t.id,
      }).catch(() => {})
    }

    return false
  }

  // ── Diagnostics ────────────────────────────────────────────────────────────
  const stepWindow = computeStepWindow(steps)
  const attemptDensityPerMin =
    stepWindow != null ? computeAttemptDensity(stepWindow) : 0
  const blockedWaitMs = await computeBlockedWaitMs(t.id, nowMs).catch(() => 0)
  const breachClass = classifyRequeueBreach(t, stepWindow, blockedWaitMs, effectiveElapsedMs)
  const queuedNeighbourCount = await listTasks('queued')
    .then((tasks) => tasks.filter((qt) => qt.id !== t.id).length)
    .catch(() => 0)

  // ── Map breach class → failure reason code ─────────────────────────────────
  const failureReasonCode =
    breachClass.kind === 'retry-churn'
      ? 'requeue-retry-churn'
      : breachClass.kind === 'blocked-wait'
        ? 'requeue-blocked-wait'
        : breachClass.kind === 'queue-starvation'
          ? 'requeue-queue-starvation'
          : 'requeue-long-running'

  const boundMins = Math.round(REQUEUE_MAX_RETRY_MS / 60_000)
  // Which bound tripped. `failureReason` stays the stable step id either way
  // (see below) so both shapes share one signature; the distinction belongs in
  // the operator-facing prose only.
  const breachedBound = attemptsExceeded
    ? `attempt bound (${maxAttempt} attempt(s), bound ${REQUEUE_MAX_ATTEMPTS})`
    : `retry time bound (${effectiveElapsedMins}m dispatch uptime, bound ${boundMins}m, ${maxAttempt} attempt(s))`
  log(
    `[dispatch] poll-fallback: task ${t.id} exceeded ${breachedBound}, ` +
      `class ${breachClass.kind}; escalating to failed`,
  )

  // ── Stall diagnostics ───────────────────────────────────────────────────────
  // Capture the pty output tail from the task's log file so operators see WHY
  // the coder stalled, not just that it exceeded the time bound.
  const STDERR_TAIL_LINES = Number(process.env.MARS_STDERR_TAIL_LINES ?? 200)
  let stallDiagnosticsJson: string | null = null
  if (t.worktreePath) {
    try {
      const logDir = path.join(t.worktreePath, '.mars', 'pty')
      const logFiles = fs.existsSync(logDir)
        ? fs.readdirSync(logDir).filter((f) => f.endsWith('.log')).sort()
        : []
      if (logFiles.length > 0) {
        const latestLog = fs.readFileSync(
          path.join(logDir, logFiles[logFiles.length - 1]!),
          'utf8',
        )
        const lines = latestLog.split('\n')
        const ring = new RingBuffer(STDERR_TAIL_LINES)
        for (const line of lines) ring.push(line)
        const diag = collectStallDiagnostics({
          outputTail: ring,
          exitCode: null,
          doneSignalFired: false,
          startedAtMs: retryStartMs,
          nowMs,
        })
        stallDiagnosticsJson = JSON.stringify(diag)
      }
    } catch {
      // Best-effort — do not block the escalation path
    }
  }

  // `failureReason` must be a step-id-grammar value so the signature minted
  // by recovery-spawn.ts is stable across occurrences. The varying measurements
  // (attempt count, elapsed minutes) belong in `error` and the action-queue
  // body — not in the identity field. Do NOT set `failedPhase` here: it is
  // typed `code | verify | merge` (queue.ts) and the ceiling fires at dispatch
  // level, outside all three phases.
  await updateTask(t.id, {
    status: 'failed',
    stallDiagnostics: stallDiagnosticsJson,
    error:
      `Re-queue ceiling exceeded — ${breachedBound}: task retried ${maxAttempt} time(s) ` +
      `over ${effectiveElapsedMins} dispatch-uptime minutes without completing ` +
      `(class ${breachClass.kind}). ` +
      `Run \`mars restart ${t.id}\` to reset.`,
    failureReason: 'requeue:time-bound-exceeded',
    failureReasonCode,
  }).catch(() => {})

  await raiseActionQueueItem({
    kind: 'failed',
    category: 'orchestrator',
    priority: 'high',
    title: `Task ${t.id}: re-queue ceiling exceeded (${breachClass.kind})`,
    body:
      `Task was re-dispatched ${maxAttempt} time(s) over ${effectiveElapsedMins} dispatch-uptime minutes ` +
      `without completing — exceeded the ${breachedBound} (class ${breachClass.kind}). ` +
      `${breachClass.reason} ` +
      `Run \`mars restart ${t.id}\` to reset.`,
    payload: {
      taskId: t.id,
      maxAttempt,
      elapsedMs: effectiveElapsedMs,
      boundMs: REQUEUE_MAX_RETRY_MS,
      attemptBound: REQUEUE_MAX_ATTEMPTS,
      breachedBound: attemptsExceeded ? 'attempts' : 'time',
      diagnostics: {
        class: breachClass.kind,
        attemptDensityPerMin,
        stepWindowMs: stepWindow?.spanMs ?? 0,
        blockedWaitMs,
        maxAttempt,
        queuedNeighbourCount,
      },
    },
    context: {},
    raisedBy: 'daemon:poll-fallback',
    signature: `requeue-ceiling:${t.id}`,
    originTaskId: t.id,
  }).catch(() => {})

  return true
}
