/**
 * Durable single-consumer merge worker (PRD 92af89ce, slices 2 + 4).
 *
 * `startMergeWorker` starts a loop that:
 *   1. Calls `store.claimNext()` to atomically claim the oldest queued job.
 *   2. If no job is available, waits for a `merge-job.enqueued` bus event or
 *      500 ms, then retries.
 *   3. If a job is claimed: calls `markRunning`, invokes `runMergeJob` (which
 *      calls the injected `mergeFn`, defaults to the real `mergeBranch`), then
 *      resolves the caller's awaiting promise via `resolveMergeJob`.
 *
 * Concurrency is strictly one: a single `inFlight: Promise<void> | null`
 * variable tracks the active job. The loop `await`s it before picking the
 * next job, so even if many `merge-job.enqueued` events fire simultaneously
 * only one job is ever in flight. The in-process guard exists alongside the
 * DB `FOR UPDATE SKIP LOCKED` claim so correctness does not rely solely on
 * the DB index.
 *
 * Always started by `server.ts` — the merge queue is unconditionally on.
 *
 * ## Promise-based park pattern (slice 4)
 *
 * `enqueueMergeJobAndAwait` mirrors `awaitManualDone` / `resolveManualStep`
 * from `@mars/workflow`:
 *   - The workflow primitive calls `enqueueMergeJobAndAwait(...)` which
 *     registers a pending promise keyed by `taskId`, enqueues a DB row,
 *     wakes the worker, and returns the promise.
 *   - After `runMergeJob` completes (success or failure), `resolveMergeJob`
 *     looks up the promise by `taskId` and resolves it with the outcome.
 */

import type { EventEmitter } from 'node:events'
import type { MergeArgs, MergeResult } from '../lib/git/merge.js'
import { mergeBranch, MergeAbortedError, DEFAULT_WATCHDOG_MS } from '../lib/git/merge.js'
import type { MergeJob, MergeJobStore, EnqueueMergeJobInput } from '../store/merge-job-store.js'

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * The result delivered to a waiting `enqueueMergeJobAndAwait` call.
 * - `done`: `mergeBranch` returned normally; `result` is the full MergeResult.
 * - `failed`: the job failed before or during the merge; `errorCode` carries
 *   the machine-readable reason used for action-queue triage.
 */
export type MergeJobResult =
  | { status: 'done'; result: MergeResult }
  | { status: 'failed'; error: string; errorCode: 'watchdog' | 'crash' | 'canceled' }

export interface MergeWorkerDeps {
  store: MergeJobStore
  log: (msg: string) => void
  bus: EventEmitter
  signal: AbortSignal
  /**
   * How long to wait before re-polling when the queue is empty and no bus
   * event has arrived. Defaults to 500 ms. Tests can set this lower.
   */
  pollIntervalMs?: number
  /**
   * Merge function to invoke for each job. Defaults to the real `mergeBranch`.
   * Override in tests to avoid real git operations.
   */
  mergeFn?: (args: MergeArgs) => Promise<MergeResult>
}

export interface MergeWorkerHandle {
  stop(): Promise<void>
  /**
   * Cancel the in-flight merge job for the given job id, if one is currently
   * running. Aborts the per-job AbortController so `mergeBranch` is interrupted.
   * Returns `true` if the matching job was found and its abort was signalled;
   * `false` if no in-flight job matched the id (it may have already finished or
   * not yet been claimed).
   */
  cancelJob(jobId: string): boolean
}

// ── Promise-based park / resume (mirrors awaitManualDone pattern) ─────────────

/** Live promise resolvers for in-flight merge jobs, keyed by taskId. */
const pendingMergeJobs = new Map<string, (r: MergeJobResult) => void>()

/**
 * Register a pending merge job and return a promise that resolves only when
 * `resolveMergeJob` is called for the same `taskId`.
 *
 * Set up BEFORE enqueuing the DB row so the resolver is in place before the
 * worker can process the job.
 */
export function awaitMergeJobDone(taskId: string): Promise<MergeJobResult> {
  return new Promise<MergeJobResult>((resolve) => {
    pendingMergeJobs.set(taskId, resolve)
  })
}

/**
 * Resolve a pending merge job registered by `awaitMergeJobDone`.
 *
 * Returns `true` if a pending promise was found and resolved, `false` if the
 * key was not in the map (duplicate call or worker ran before enqueue was
 * awaited — should not happen in normal operation).
 */
export function resolveMergeJob(taskId: string, result: MergeJobResult): boolean {
  const resolve = pendingMergeJobs.get(taskId)
  if (!resolve) return false
  pendingMergeJobs.delete(taskId)
  resolve(result)
  return true
}

/**
 * Enqueue a merge job for `taskId` and suspend until the worker completes it.
 *
 * This is the primary entry point for the workflow `merge` primitive. It:
 *   1. Registers an awaiting promise (BEFORE enqueuing to avoid a race).
 *   2. Inserts a `merge_jobs` row via the store.
 *   3. Emits `merge-job.enqueued` on the bus to wake a parked worker.
 *   4. Returns the promise — the caller suspends here until `resolveMergeJob`
 *      is called by the worker after the job finishes.
 */
export async function enqueueMergeJobAndAwait(args: {
  store: MergeJobStore
  bus: EventEmitter
  taskId: string
  branch: string
  worktreePath: string
  integrationBranch: string
  /**
   * Optional callback invoked when the outer watchdog fires. Call this to
   * directly fail the task in the DB so it exits status='merging' even if
   * the calling workflow has already exited (e.g. after a daemon restart).
   * Without this callback, the task relies on the phantom-task watchdog
   * (which has a longer ceiling for merge tasks) to eventually detect it.
   * When the workflow IS alive, the returned {status:'failed',
   * errorCode:'watchdog'} result is sufficient — the caller re-throws and
   * the crash handler transitions the task. This callback is the
   * belt-and-suspenders for the "calling workflow is gone" case.
   */
  onWatchdogTimeout?: (taskId: string) => Promise<void>
}): Promise<MergeJobResult> {
  // Register BEFORE enqueue so we can never miss the termination event.
  const resultPromise = awaitMergeJobDone(args.taskId)
  await args.store.enqueue({
    taskId: args.taskId,
    branch: args.branch,
    worktreePath: args.worktreePath,
    integrationBranch: args.integrationBranch,
  } satisfies EnqueueMergeJobInput)
  args.bus.emit('merge-job.enqueued')

  // Belt-and-suspenders outer watchdog: if the merge worker never resolves
  // this promise (e.g. the job was lost, the worker crashed without calling
  // resolveMergeJob, or the daemon restarted mid-merge), fail after
  // watchdogMs + OUTER_WATCHDOG_GRACE_MS so the calling workflow never parks
  // in status='merging' forever.
  //
  // The internal per-job watchdog (passed to mergeFn as watchdogMs) fires at
  // watchdogMs; the grace period ensures the internal one always fires first
  // under normal conditions — this outer timeout is the last resort.
  const watchdogMs = Number(process.env.MARS_MERGE_WATCHDOG_MS ?? DEFAULT_WATCHDOG_MS)
  const graceMs = Number(process.env.MARS_MERGE_OUTER_WATCHDOG_GRACE_MS ?? DEFAULT_OUTER_WATCHDOG_GRACE_MS)
  const outerMs = watchdogMs + graceMs

  let outerTimer!: ReturnType<typeof setTimeout>
  const outerTimeoutPromise = new Promise<MergeJobResult>((resolve) => {
    outerTimer = setTimeout(() => {
      // Remove the pending resolver before resolving so that if resolveMergeJob
      // is called after the timeout it is a harmless no-op (key already absent).
      pendingMergeJobs.delete(args.taskId)
      // Belt-and-suspenders: directly fail the task in the DB so it leaves
      // status='merging' even if the calling workflow has already exited (e.g.
      // the daemon restarted mid-merge and the workflow promise was abandoned).
      // The onWatchdogTimeout callback is intentionally fire-and-forget here —
      // we resolve the outer promise immediately so the caller gets the result.
      if (args.onWatchdogTimeout) {
        args.onWatchdogTimeout(args.taskId).catch(() => {
          // Non-fatal: if the DB write fails, the phantom-task watchdog will
          // eventually detect the stuck 'merging' row via its no-merge-job check.
        })
      }
      resolve({
        status: 'failed',
        error: `merge:timeout — merge job for task ${args.taskId} was not resolved within ${Math.round(outerMs / 60_000)} min; the merge worker may have lost this job`,
        errorCode: 'watchdog',
      })
    }, outerMs)
  })

  try {
    return await Promise.race([resultPromise, outerTimeoutPromise])
  } finally {
    clearTimeout(outerTimer)
  }
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Default extra grace time added on top of the internal per-job merge watchdog
 * (`MARS_MERGE_WATCHDOG_MS`) for the outer promise-level timeout inside
 * `enqueueMergeJobAndAwait`. Override with `MARS_MERGE_OUTER_WATCHDOG_GRACE_MS`
 * for testing. The inner watchdog fires at `watchdogMs`; this grace period
 * ensures the inner one always fires first under normal conditions. The outer
 * timeout is the last resort: it fires if the merge worker itself dies or the
 * job is lost without `resolveMergeJob` ever being called.
 */
export const DEFAULT_OUTER_WATCHDOG_GRACE_MS = 10 * 60_000 // 10 minutes

/**
 * Execute a single merge job. Calls `mergeFn` with the job's stored args and
 * an AbortSignal that mirrors the worker's shutdown signal (so an in-flight
 * merge is interrupted on daemon shutdown). Resolves the caller's awaiting
 * promise via `resolveMergeJob` before returning. Does NOT throw — all error
 * paths are caught, logged, and delivered as `{status:'failed'}` outcomes.
 */
/** Resolve `branch` to a full SHA from inside the task's worktree. */
async function readIntegrationTip(
  worktreePath: string,
  branch: string,
): Promise<string | null> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { stdout } = await promisify(execFile)('git', ['rev-parse', branch], {
    cwd: worktreePath,
  })
  const sha = stdout.trim()
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null
}

async function runMergeJob(
  job: MergeJob,
  store: MergeJobStore,
  log: (msg: string) => void,
  mergeFn: (args: MergeArgs) => Promise<MergeResult>,
  signal: AbortSignal,
): Promise<void> {
  log(
    `[merge-worker] executing job ${job.id} for task ${job.taskId} branch=${job.branch}`,
  )

  // Defaults to the merge primitive's own budget, which is derived from the
  // vcs-supervisor timeout. Hardcoding a second literal here is how the two
  // inverted: this worker capped merges at 5 minutes while a conflict-resolving
  // merge legitimately needs the supervisor's 30.
  const watchdogMs = Number(process.env.MARS_MERGE_WATCHDOG_MS ?? DEFAULT_WATCHDOG_MS)

  let result: MergeJobResult
  try {
    // Pre-flight: fail fast with a diagnosable message if the worktree is gone.
    // A startup reconciler (merging-recovery) may have deleted the worktree
    // between daemon boot and this job being claimed.  Throwing here produces
    // the "working directory no longer exists" pattern that
    // computeFailureSignature classifies as merge:crashed/worktree-vanished
    // (an environmental failure) so the arc's single recovery slot is not
    // consumed and remerge is triggered automatically.
    const { existsSync } = await import('node:fs')
    if (!existsSync(job.worktreePath)) {
      throw new Error(`working directory no longer exists: ${job.worktreePath}`)
    }
    const mergeResult = await mergeFn({
      branch: job.branch,
      worktreePath: job.worktreePath,
      integrationBranch: job.integrationBranch,
      // Belt-and-suspenders single-daemon file guard: the queue's
      // single-consumer loop already serialises merges; 30 s is sufficient
      // to cover any transient lock-file conflict without blocking long.
      lockTimeoutMs: 30_000,
      watchdogMs,
      signal,
    })
    result = { status: 'done', result: mergeResult }
    // Where the integration branch now points. Recorded here rather than
    // inside the merge itself so the merge logic stays untouched: this is
    // bookkeeping, and a failure to read it must never fail a landed merge.
    const mergedSha = await readIntegrationTip(job.worktreePath, job.integrationBranch)
      .catch(() => null)
    // Best-effort: failure here is non-fatal — the job status in the DB is
    // cosmetic at this point; the promise is what drives the primitive.
    await store.markDone(job.id, mergedSha).catch((e: unknown) => {
      log(
        `[merge-worker] job ${job.id} markDone failed (non-fatal): ${(e as Error).message}`,
      )
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const errorCode: 'watchdog' | 'crash' | 'canceled' =
      signal.aborted
        ? 'canceled'
        : err instanceof MergeAbortedError && err.reason === 'watchdog'
          ? 'watchdog'
          : 'crash'
    result = { status: 'failed', error: msg, errorCode }
    log(`[merge-worker] job ${job.id} failed (errorCode=${errorCode}): ${msg}`)
    await store
      .markFailed(job.id, { message: msg, code: errorCode })
      .catch((e: unknown) => {
        log(
          `[merge-worker] job ${job.id} markFailed failed (non-fatal): ${(e as Error).message}`,
        )
      })
  }

  resolveMergeJob(job.taskId, result)
}

/**
 * Wait until either the `merge-job.enqueued` bus event fires, the timeout
 * elapses, or the abort signal fires — whichever comes first.
 */
function waitForJobOrTimeout(signal: AbortSignal, bus: EventEmitter, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }

    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      bus.off('merge-job.enqueued', done)
      signal.removeEventListener('abort', done)
      resolve()
    }

    const timer = setTimeout(done, ms)
    bus.once('merge-job.enqueued', done)
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Start the single-consumer merge worker loop.
 *
 * @param deps.store        - The merge-job store (injected; testable via a fake).
 * @param deps.log          - Logger function.
 * @param deps.bus          - The daemon event bus (EventEmitter).
 * @param deps.signal       - AbortSignal that stops the worker (e.g. daemon shutdown).
 * @param deps.mergeFn      - Merge function; defaults to `mergeBranch`.
 *
 * @returns A handle with a `stop()` method that signals the loop to exit
 *          and waits for any in-flight job to finish.
 */
export function startMergeWorker({
  store,
  log,
  bus,
  signal,
  pollIntervalMs = 500,
  mergeFn = mergeBranch,
}: MergeWorkerDeps): MergeWorkerHandle {
  const ac = new AbortController()

  // Mirror external signal into our internal controller so callers can also
  // stop the worker by aborting the signal they passed in.
  if (signal.aborted) {
    ac.abort()
  } else {
    signal.addEventListener('abort', () => ac.abort(), { once: true })
  }

  // Serialisation guard: non-null while a job is being processed.
  let inFlight: Promise<void> | null = null
  // Tracks the currently-running job id and its per-job AbortController so
  // `cancelJob` can interrupt it by id.
  let currentJobId: string | null = null
  let currentJobAc: AbortController | null = null

  const loop = async (): Promise<void> => {
    while (!ac.signal.aborted) {
      // Safety net: if inFlight is somehow set (should never happen in this
      // single loop), await it before claiming the next job.
      if (inFlight !== null) {
        await inFlight
        continue
      }

      const job = await store.claimNext()

      if (job === null) {
        // Queue is empty — park until a new job arrives or the timer fires.
        await waitForJobOrTimeout(ac.signal, bus, pollIntervalMs)
        continue
      }

      // Create a per-job AbortController that mirrors the worker shutdown
      // signal so the in-flight mergeBranch is interrupted on daemon exit.
      const jobAc = new AbortController()
      if (ac.signal.aborted) {
        jobAc.abort()
      } else {
        ac.signal.addEventListener('abort', () => jobAc.abort(), { once: true })
      }

      // Process the job. Set inFlight BEFORE awaiting so the guard is always
      // accurate from the perspective of any concurrent inspect.
      let resolveInFlight!: () => void
      inFlight = new Promise<void>((res) => {
        resolveInFlight = res
      })
      currentJobId = job.id
      currentJobAc = jobAc

      try {
        await store.markRunning(job.id)
        await runMergeJob(job, store, log, mergeFn, jobAc.signal)
      } catch (err) {
        const msg = (err as Error).message
        log(`[merge-worker] job ${job.id} failed: ${msg}`)
        await store.markFailed(job.id, { message: msg }).catch(() => {
          // best-effort: if markFailed itself fails, the job will be cleaned up
          // by the startup reconcile on next daemon boot.
        })
        // Resolve any pending primitive promise if runMergeJob never ran
        // (i.e., markRunning threw before runMergeJob was called).
        resolveMergeJob(job.taskId, { status: 'failed', error: msg, errorCode: 'crash' })
      } finally {
        currentJobId = null
        currentJobAc = null
        inFlight = null
        resolveInFlight()
      }
    }
  }

  const loopPromise = loop().catch((err) => {
    log(`[merge-worker] unexpected loop error: ${(err as Error).message}`)
  })

  return {
    stop: async (): Promise<void> => {
      ac.abort()
      await loopPromise
    },
    cancelJob(jobId: string): boolean {
      if (currentJobId === jobId && currentJobAc !== null) {
        currentJobAc.abort()
        return true
      }
      return false
    },
  }
}
