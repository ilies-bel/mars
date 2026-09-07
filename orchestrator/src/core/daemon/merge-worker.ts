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
import type { MergeJob, MergeJobStore, EnqueueMergeJobInput, GateCheckEntry } from '../store/merge-job-store.js'
import type { AgentEvent } from '../lib/claude-stream.js'
import { isOperatorAutoCommitDisabled, resolveControlLevers } from '../config/levers.js'
import { readMergeWatchdogMs } from './config.js'
import {
  raiseBrokenAutoCommitAlert,
  speakOperatorAutoCommitNotice,
} from '../lib/notices/operator-auto-commit.js'
// Deliberate non-port dependency: probeMainTypecheck is a build-health probe
// (tsc invocation), not a VCS operation, and has no equivalent in the Vcs port.
import { PROBE_TIMEOUT_MS, probeMainTypecheck } from '../lib/git/operator-auto-commit.js'
import { resolveVcs } from '../ports/vcs/registry.js'
import type { MergeResult, MergeSpec } from '../ports/vcs/types.js'
import { MergeAbortedError, DEFAULT_WATCHDOG_MS } from '../ports/vcs/errors.js'
import { freezeFlow } from '../domain-flow/store.js'

// ---------------------------------------------------------------------------
// Local type aliases (formerly imported from lib/git/merge)
// ---------------------------------------------------------------------------

/**
 * Gate check outcome — mirrors `MergeGateOutcome` in `lib/git/merge.ts`.
 * Defined locally so this module has zero imports from `lib/git/merge`.
 */
type MergeGateOutcome = { passed: true } | { passed: false; output: string }

/**
 * Operator auto-commit callback payload — mirrors `OperatorAutoCommitInfo`
 * in `lib/git/merge.ts`. Defined locally for the same reason.
 */
interface MergeOperatorAutoCommitInfo {
  commitSha: string
  files: string[]
  probe: MergeGateOutcome | null
}

/**
 * Full merge invocation args passed to the `mergeFn` injectable. Extends the
 * serializable {@link MergeSpec} with non-serializable fields (AbortSignal and
 * callbacks). The default implementation routes through `resolveVcs().merge()`
 * which accepts only the `MergeSpec` fields; the callback parameters are
 * preserved here for tests and for future port-aware callers that may wire
 * them through the Vcs interface (PRD aed916c8 slice 7 tracer bullet —
 * wiring callbacks through the port is deferred to a later slice).
 */
interface MergeFnArgs extends MergeSpec {
  signal?: AbortSignal
  onVerifyRebasedTree?: (info: {
    baseSha: string
    taskSha: string
    attempt: number
  }) => Promise<MergeGateOutcome>
  onAfterFastForward?: (info: {
    finalTaskSha: string
    finalIntegrationSha: string
  }) => Promise<void>
  onSupervisorEvent?: (event: AgentEvent) => void
  autoCommitOperatorDirt?: boolean
  onProbeIntegrationAfterAutoCommit?: (info: {
    commitSha: string
  }) => Promise<MergeGateOutcome>
  onOperatorAutoCommit?: (info: MergeOperatorAutoCommitInfo) => Promise<void>
}

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
   * Merge function to invoke for each job. Defaults to a wrapper around
   * `resolveVcs().merge()`. Override in tests to avoid real git operations.
   */
  mergeFn?: (args: MergeFnArgs) => Promise<MergeResult>
  /**
   * Optional callback fired for each streaming event emitted by the
   * vcs-supervisor (Vega) while it resolves a merge conflict. Receives the
   * task's id so the caller can correlate events with the right task.
   *
   * Used in server.ts to:
   *   - update the in-flight activity tracker so the phantom-task watchdog
   *     can tell a healthy (event-emitting) Vega session from a hung one;
   *   - write tool-call trace events so operators polling /events can see
   *     Vega activity in the task's event stream rather than a blank wall.
   *
   * Errors thrown by this callback are silently swallowed — a reporting
   * failure must never abort or slow a merge.
   */
  onSupervisorEvent?: (taskId: string, event: AgentEvent) => void
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

// ── Gate-budget constants ─────────────────────────────────────────────────────

/**
 * Default fallback timeout (minutes) for a single task-tier gate when the gate
 * does not declare its own `timeoutMin`. Mirrored inside `onVerifyRebasedTree`
 * and referenced when sizing the per-job watchdog so the two values cannot
 * drift independently.
 */
const DEFAULT_TASK_TIER_GATE_BUDGET_MIN = 15

/**
 * Default fallback timeout (minutes) for a single integration-tier gate when
 * the gate does not declare its own `timeoutMin`. Mirrored inside
 * `onAfterFastForward` and referenced when sizing the per-job watchdog so the
 * two values cannot drift independently.
 */
const DEFAULT_INTEGRATION_GATE_BUDGET_MIN = 15

// ── Promise-based park / resume (mirrors awaitManualDone pattern) ─────────────

/**
 * Live promise resolvers for in-flight merge jobs, keyed by taskId.
 *
 * A Set per taskId rather than a single resolver so that concurrent callers
 * (e.g. a daemon restart where the workflow engine re-enters the merge step
 * while a previous attempt's resolver would have been overwritten) each
 * register their own slot and all receive the outcome when
 * `resolveMergeJob` is called.
 */
const pendingMergeJobs = new Map<string, Set<(r: MergeJobResult) => void>>()

/**
 * Epoch-ms timestamp of the last merge-job watchdog fire, or null if no
 * watchdog has fired since the process started. Updated by `runMergeJob` when
 * it catches a `MergeAbortedError` with `reason: 'watchdog'`. Read by the
 * Steward autotune bump lane to hold the implement cap for a cooldown window
 * after overload evidence.
 */
let lastMergeWatchdogFireMs: number | null = null

/**
 * Return the epoch-ms timestamp of the last merge-job watchdog fire, or null
 * if no watchdog has fired since the daemon started. Consumed by the Steward
 * autotune bump lane via `StewardRuntimeTuneDeps.getLastWatchdogFireMs`.
 */
export const getLastMergeWatchdogFireMs = (): number | null => lastMergeWatchdogFireMs

/**
 * "Claimed" callbacks registered by `enqueueMergeJobAndAwait` callers that
 * want to be notified the moment the worker picks up the job (after
 * `markRunning`). The hard step-level wall-clock ceiling in the merge
 * primitive starts here — not at enqueue time — so queue wait does not
 * consume execution budget.
 */
const pendingClaimCallbacks = new Map<string, () => void>()

/**
 * Register a pending merge job and return a promise that resolves only when
 * `resolveMergeJob` is called for the same `taskId`, plus a `remove()`
 * function that removes only THIS caller's resolver from the set (used by the
 * outer watchdog so a single caller's timeout does not orphan sibling awaiters
 * for the same task).
 *
 * Set up BEFORE enqueuing the DB row so the resolver is in place before the
 * worker can process the job.
 */
function awaitMergeJobDone(
  taskId: string,
): { promise: Promise<MergeJobResult>; remove: () => void } {
  let myResolve!: (r: MergeJobResult) => void
  const promise = new Promise<MergeJobResult>((resolve) => {
    myResolve = resolve
    let resolvers = pendingMergeJobs.get(taskId)
    if (!resolvers) {
      resolvers = new Set()
      pendingMergeJobs.set(taskId, resolvers)
    }
    resolvers.add(resolve)
  })
  return {
    promise,
    remove(): void {
      const resolvers = pendingMergeJobs.get(taskId)
      if (!resolvers) return
      resolvers.delete(myResolve)
      if (resolvers.size === 0) pendingMergeJobs.delete(taskId)
    },
  }
}

/**
 * Resolve all pending merge jobs registered by `awaitMergeJobDone` for the
 * given `taskId`. Returns `true` if at least one pending promise was found and
 * resolved, `false` if the key was not in the map (duplicate call or worker ran
 * before enqueue was awaited — should not happen in normal operation).
 */
export function resolveMergeJob(taskId: string, result: MergeJobResult): boolean {
  const resolvers = pendingMergeJobs.get(taskId)
  if (!resolvers || resolvers.size === 0) return false
  pendingMergeJobs.delete(taskId)
  pendingClaimCallbacks.delete(taskId) // defensive cleanup: job finished without being claimed
  for (const resolve of resolvers) {
    resolve(result)
  }
  return true
}

/**
 * Fire the "claimed" callback registered by the enqueueMergeJobAndAwait caller
 * for `taskId`, if one was registered. Called by the worker loop immediately
 * after `markRunning` so the step-level hard timeout starts at execution time
 * rather than at enqueue time.
 *
 * No-op when no callback is registered (the caller opted out).
 */
function signalMergeJobClaimed(taskId: string): void {
  const cb = pendingClaimCallbacks.get(taskId)
  if (cb) {
    pendingClaimCallbacks.delete(taskId)
    cb()
  }
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
   * Optional callback invoked the moment the merge worker claims this job
   * (immediately after `markRunning`). The merge primitive uses this to start
   * its step-level hard wall-clock ceiling at claim time rather than at
   * enqueue time — so queue wait does not consume execution budget and a task
   * sitting behind a long-running merge is not failed for a merge that never
   * ran.
   */
  onClaimed?: () => void
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
  const { promise: resultPromise, remove: removeMyResolver } = awaitMergeJobDone(args.taskId)

  // Register the claim callback before enqueuing so the worker can never
  // claim and call it before we store it.
  if (args.onClaimed) {
    pendingClaimCallbacks.set(args.taskId, args.onClaimed)
  }

  // Idempotent enqueue: if an active (queued/claimed/running) job already
  // exists for this task — e.g. after a daemon restart where the startup
  // reconciler kept the queued row and the workflow engine is resuming on
  // attempt 2 — adopt that row instead of inserting a duplicate.
  // The partial unique index (merge_jobs_active_task_uidx) would reject the
  // INSERT anyway; this check avoids the error path entirely.
  const existingJob = await args.store.getActiveMergeJob(args.taskId)
  if (!existingJob) {
    try {
      await args.store.enqueue({
        taskId: args.taskId,
        branch: args.branch,
        worktreePath: args.worktreePath,
        integrationBranch: args.integrationBranch,
      } satisfies EnqueueMergeJobInput)
    } catch (err: unknown) {
      // A concurrent second call may have won the INSERT race and the
      // partial unique index fired (Postgres 23505, SQLite "UNIQUE constraint
      // failed"). Adopt the row that was just inserted rather than propagating
      // the constraint error — our resolver stays registered in
      // pendingMergeJobs and resolveMergeJob will deliver the outcome to both
      // callers when the worker finishes.
      const msg = err instanceof Error ? err.message : String(err)
      const isConstraintViolation =
        msg.includes('23505') || msg.toLowerCase().includes('unique constraint')
      if (!isConstraintViolation) {
        // Not a constraint error — remove our resolver before re-throwing so
        // resolveMergeJob does not call a promise that nothing awaits.
        removeMyResolver()
        throw err
      }
      // Constraint violation: fall through to bus.emit — the worker needs to
      // be woken to claim the row the winning caller just inserted.
    }
  }

  // Wake the worker whether we inserted a new row or adopted an existing one.
  // In the adopt case the original bus event may have been lost across the
  // daemon restart, so re-emitting here ensures the worker unparks.
  args.bus.emit('merge-job.enqueued')

  // Belt-and-suspenders outer watchdog: if the merge worker never resolves
  // this promise (e.g. the job was lost, the worker crashed without calling
  // resolveMergeJob, or the daemon restarted mid-merge), fail after
  // watchdogMs + OUTER_WATCHDOG_GRACE_MS so the calling workflow never parks
  // in status='merging' forever.
  //
  // watchdogMs is sized to cover DEFAULT_WATCHDOG_MS (vcs-supervisor +
  // git work) PLUS the gate budgets supplied by the worker's
  // onVerifyRebasedTree and onAfterFastForward hooks. Both hooks can run
  // for up to their per-tier default before yielding — omitting their
  // budgets would let the outer watchdog fire while a legitimate gate is
  // still running. Override with MARS_MERGE_WATCHDOG_MS when needed.
  //
  // The internal per-job watchdog (passed to mergeFn as watchdogMs) fires at
  // watchdogMs; the grace period ensures the internal one always fires first
  // under normal conditions — this outer timeout is the last resort.
  const watchdogMs = Number(
    process.env.MARS_MERGE_WATCHDOG_MS ??
      DEFAULT_WATCHDOG_MS +
        (DEFAULT_TASK_TIER_GATE_BUDGET_MIN + DEFAULT_INTEGRATION_GATE_BUDGET_MIN) * 60_000,
  )
  const graceMs = Number(process.env.MARS_MERGE_OUTER_WATCHDOG_GRACE_MS ?? DEFAULT_OUTER_WATCHDOG_GRACE_MS)
  const outerMs = watchdogMs + graceMs

  let outerTimer!: ReturnType<typeof setTimeout>
  const outerTimeoutPromise = new Promise<MergeJobResult>((resolve) => {
    outerTimer = setTimeout(() => {
      // Remove only THIS caller's resolver slot — a sibling awaiter for the
      // same task (e.g. another workflow run racing on the same taskId) must
      // not lose its pending promise just because this caller's watchdog fired.
      removeMyResolver()
      pendingClaimCallbacks.delete(args.taskId) // defensive cleanup
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
const DEFAULT_OUTER_WATCHDOG_GRACE_MS = 10 * 60_000 // 10 minutes

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
  mergeFn: (args: MergeFnArgs) => Promise<MergeResult>,
  signal: AbortSignal,
  onSupervisorEvent?: (taskId: string, event: AgentEvent) => void,
): Promise<void> {
  log(
    `[merge-worker] executing job ${job.id} for task ${job.taskId} branch=${job.branch}`,
  )

  // Preload verify gates once so both callbacks (onVerifyRebasedTree and
  // onAfterFastForward) share the same snapshot and the watchdog can be sized
  // from the gates' own declared timeoutMin values rather than a static
  // constant that is unrelated to how many gates are registered.
  const { loadVerifyGates, recordVerifyGatePasses } = await import('../../core/verify-gates.js')
  const { resolveStateClient } = await import('../store/state-client.js')
  const preloadedGateScopes = await loadVerifyGates(resolveStateClient())

  // Accumulated gate check results for both task-tier and integration-tier gates.
  // Written by the onVerifyRebasedTree and onAfterFastForward closures and
  // persisted after markDone so the task drawer can show "Checks: X ✓ Y ✓".
  const collectedGateChecks: GateCheckEntry[] = []

  // Derive the gate-tier budget from the declared timeoutMin of every step.
  // Fall back to the module-level constant for each gate that has no declared
  // timeout so the watchdog never shrinks below what the defaults already
  // promised. The minimum overall gate budget is the static fallback so that
  // an empty gate registry does not silently shrink the watchdog below the
  // historical baseline.
  const taskTierBudgetMs = preloadedGateScopes
    .flatMap((sc) => sc.steps.filter((s) => s.tier !== 'integration'))
    .reduce(
      (sum, s) => sum + (s.timeoutMin ?? DEFAULT_TASK_TIER_GATE_BUDGET_MIN) * 60_000,
      0,
    )
  const integrationTierBudgetMs = preloadedGateScopes
    .flatMap((sc) => sc.steps.filter((s) => s.tier === 'integration' && s.required))
    .reduce(
      (sum, s) => sum + (s.timeoutMin ?? DEFAULT_INTEGRATION_GATE_BUDGET_MIN) * 60_000,
      0,
    )
  const gateBudgetMs = Math.max(
    taskTierBudgetMs + integrationTierBudgetMs,
    (DEFAULT_TASK_TIER_GATE_BUDGET_MIN + DEFAULT_INTEGRATION_GATE_BUDGET_MIN) * 60_000,
  )

  // The watchdog must cover the full call:
  //   - VCS supervisor session + surrounding git work (DEFAULT_WATCHDOG_MS)
  //   - onVerifyRebasedTree: sum of task-tier gate timeoutMin values
  //   - onAfterFastForward: sum of required integration-tier gate timeoutMin values
  // gateBudgetMs is derived above from the gates' own declared timeoutMin so
  // the watchdog scales with the actual gate suite rather than a static
  // constant that was unrelated to gate count (production incident: 15 min
  // constant fired while a 10-gate suite was still running).
  // Priority: operator-pinned mergeWatchdogMs > MARS_MERGE_WATCHDOG_MS > dynamic.
  const watchdogMs = (() => {
    const operatorMs = readMergeWatchdogMs()
    if (operatorMs !== null) return operatorMs
    const envMs = process.env.MARS_MERGE_WATCHDOG_MS
    if (envMs !== undefined) return Number(envMs)
    return DEFAULT_WATCHDOG_MS + gateBudgetMs
  })()
  log(
    `[merge-worker] task ${job.taskId}: watchdog ${Math.round(watchdogMs / 60_000)}min ` +
      `(base ${Math.round(DEFAULT_WATCHDOG_MS / 60_000)}min + gates ${Math.round(gateBudgetMs / 60_000)}min; ` +
      `${preloadedGateScopes.flatMap((s) => s.steps).length} gate step(s))`,
  )

  // Per-gate fallback timeout for integration-tier gates. Uses the module-level
  // constant so the watchdog sizing above and the per-gate AbortSignal below
  // are derived from the same value and cannot drift.
  const DEFAULT_INTEGRATION_TIMEOUT_MIN = DEFAULT_INTEGRATION_GATE_BUDGET_MIN

  // Construct the integration-gate hook that runs required integration-tier
  // gates after the fast-forward, inside the merge lock, before it releases.
  // This replaces the dead `integrationGateRunner` in tools/merge/merge.ts,
  // which was declared but never wired to mergeFn (mars-cd039a0b).
  //
  // Decision: non-required integration gates are SKIPPED at this boundary.
  // Running an informational gate inside the merge lock would hold the lock
  // for something that cannot block the merge — counter-productive.
  //
  // Per-gate timeout: each gate runs with its own AbortSignal.timeout derived
  // from step.timeoutMin (fallback DEFAULT_INTEGRATION_TIMEOUT_MIN). This
  // replaces the old single global 120 s budget (INTEGRATION_GATE_TIMEOUT_MS)
  // that covered all gates combined and ignored per-gate declared budgets.
  // Mirrors the sibling fix in server.ts:runGate (4d093d011).
  const onAfterFastForward = async (info: {
    finalTaskSha: string
    finalIntegrationSha: string
  }): Promise<void> => {
    const { resolveVerifier } = await import('../ports/verifier/registry.js')

    // Uses preloadedGateScopes captured above — avoids a second DB round-trip
    // and guarantees the watchdog budget and the callback see the same gates.
    const gateScopes = preloadedGateScopes

    // Only required, active integration-tier steps. `loadVerifyGates` already
    // applies the `state='active'` filter in its SQL query; `required` is an
    // explicit secondary filter here so informational-only gates do not hold
    // the merge lock.
    const integrationSteps = gateScopes.flatMap((sc) =>
      sc.steps
        .filter((s) => s.tier === 'integration' && s.required)
        .map((s) => ({ ...s, dir: sc.scope })),
    )

    if (integrationSteps.length === 0) return

    log(
      `[merge-worker] task ${job.taskId}: running ${integrationSteps.length} required ` +
        `integration-tier gate(s) under merge lock ` +
        `(pre-merge: ${info.finalIntegrationSha.slice(0, 9)}, ` +
        `post-merge: ${info.finalTaskSha.slice(0, 9)})`,
    )

    const outputParts: string[] = []

    // Run gates sequentially, fail-fast: we are inside the merge lock and
    // should release it as quickly as possible on a failed gate.
    for (const step of integrationSteps) {
      const timeoutMs =
        (step.timeoutMin ?? DEFAULT_INTEGRATION_TIMEOUT_MIN) * 60_000
      const gateSignal = AbortSignal.timeout(timeoutMs)

      const gateResult = await resolveVerifier().run(
        {
          cwd: job.worktreePath,
          // Remap tier to 'task' so the verifier actually executes the step
          // (verifyChanges defers integration-tier steps to this boundary).
          steps: [{ ...step, tier: 'task' as const }],
          // No branch/integrationBranch: skip the has-diff gate for this run.
        },
        { signal: gateSignal },
      )

      for (const s of gateResult.steps) {
        const durationBadge =
          s.duration !== undefined ? ` ${s.duration}ms` : ''
        outputParts.push(
          `=== ${s.name} (${s.passed ? 'pass' : 'FAIL'}) [integration]${durationBadge} ===\n${s.output}`,
        )
        collectedGateChecks.push({
          name: s.name,
          gateId: step.gateId ?? null,
          passed: s.passed,
          durationMs: s.duration ?? null,
        })
      }

      if (!gateResult.passed) {
        const failed = gateResult.steps.filter((s) => !s.passed)
        const formattedOutput = outputParts.join('\n\n')
        if (gateSignal.aborted) {
          throw new Error(
            `merge:integration-gate task ${job.taskId}: step "${failed[0]?.name ?? 'unknown'}" ` +
              `timed out after ${timeoutMs}ms\n\n${formattedOutput}`,
          )
        }
        const summary = failed
          .map((s) => `${s.name}:\n${s.output.slice(0, 500)}`)
          .join('\n\n')
        throw new Error(
          `merge:integration-gate task ${job.taskId} failed (${failed.length} gate(s)):\n` +
            `${summary}\n\n${formattedOutput}`,
        )
      }
    }

    log(
      `[merge-worker] task ${job.taskId}: all ${integrationSteps.length} required ` +
        `integration-tier gate(s) passed`,
    )
  }

  // ADR-0100 step 2: verify the REBASED tree in the task's own worktree,
  // BEFORE the merge lock is taken. `mergeBranch` calls this hook immediately
  // after `git rebase <integration>` completes and before `acquireLock`, so the
  // integration branch is untouched on failure. The merge lock is never held
  // while the test suite runs.
  //
  // Mirrors the `onAfterFastForward` pattern but for task-tier gates (not
  // integration-tier). Integration gates already run via `onAfterFastForward`
  // inside the lock after the fast-forward; running them here would duplicate
  // that work while holding no lock for something that cannot block the
  // fast-forward.
  //
  // Returns { passed: boolean } — a false result causes `mergeBranch` to
  // short-circuit, leaving `main` untouched, and the merge loop ends without
  // ever acquiring the lock.
  // Per-gate fallback timeout for task-tier gates. Uses the module-level
  // constant so the watchdog sizing above and the per-gate AbortSignal here
  // are derived from the same value and cannot drift.
  const DEFAULT_TASK_TIER_TIMEOUT_MIN = DEFAULT_TASK_TIER_GATE_BUDGET_MIN
  const onVerifyRebasedTree = async (info: {
    baseSha: string
    taskSha: string
    attempt: number
  }): Promise<MergeGateOutcome> => {
    const { resolveVerifier } = await import('../ports/verifier/registry.js')

    // Uses preloadedGateScopes captured above — avoids a second DB round-trip
    // and guarantees the watchdog budget and the callback see the same gates.
    const gateScopes = preloadedGateScopes

    // All non-integration steps. Integration-tier steps are handled by
    // `onAfterFastForward` (inside the merge lock, after the fast-forward).
    const taskSteps = gateScopes.flatMap((sc) =>
      sc.steps
        .filter((s) => s.tier !== 'integration')
        .map((s) => ({ ...s, dir: sc.scope })),
    )

    if (taskSteps.length === 0) return { passed: true }

    log(
      `[merge-worker] task ${job.taskId}: running ${taskSteps.length} task-tier gate(s) ` +
        `on rebased tree ${info.taskSha.slice(0, 9)} (attempt ${info.attempt}, ` +
        `rebased onto ${info.baseSha.slice(0, 9)})`,
    )

    const outputParts: string[] = []

    for (const step of taskSteps) {
      const timeoutMs =
        (step.timeoutMin ?? DEFAULT_TASK_TIER_TIMEOUT_MIN) * 60_000
      const gateSignal = AbortSignal.timeout(timeoutMs)

      const gateResult = await resolveVerifier().run(
        {
          cwd: job.worktreePath,
          // Pass as tier:'task' so the verifier executes the step rather than
          // deferring it (integration-tier steps are deferred by the verifier).
          steps: [{ ...step, tier: 'task' as const }],
        },
        { signal: gateSignal },
      )

      for (const s of gateResult.steps) {
        const durationBadge =
          s.duration !== undefined ? ` ${s.duration}ms` : ''
        outputParts.push(
          `=== ${s.name} (${s.passed ? 'pass' : 'FAIL'}) [task]${durationBadge} ===\n${s.output}`,
        )
        collectedGateChecks.push({
          name: s.name,
          gateId: step.gateId ?? null,
          passed: s.passed,
          durationMs: s.duration ?? null,
        })
      }

      if (!gateResult.passed) {
        const failed = gateResult.steps.filter((s) => !s.passed)
        const formattedOutput = outputParts.join('\n\n')
        if (gateSignal.aborted) {
          return {
            passed: false,
            output:
              `merge:rebased-verify task ${job.taskId}: step ` +
              `"${failed[0]?.name ?? 'unknown'}" timed out after ${timeoutMs}ms` +
              `\n\n${formattedOutput}`,
          }
        }
        return { passed: false, output: formattedOutput }
      }
    }

    log(
      `[merge-worker] task ${job.taskId}: all ${taskSteps.length} task-tier gate(s) ` +
        `passed on rebased tree`,
    )
    return { passed: true }
  }

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
      // ADR-0100 step 2: verify the rebased tree in the task's own worktree,
      // outside the merge lock, before the fast-forward. Constructed locally
      // (above) so the callback crosses the queue boundary — job payloads are
      // serialisable data; functions cannot be threaded through them. A false
      // result ends the merge without ever acquiring the lock.
      onVerifyRebasedTree,
      // Integration-tier gate: runs required integration gates after the
      // fast-forward, inside the merge lock, before it releases. Constructed
      // locally (above) so the callback crosses the queue boundary — job
      // payloads are serialisable data; functions cannot be threaded through
      // them. A throw reverts the fast-forward via mergeBranch semantics.
      onAfterFastForward,
      // Forward vcs-supervisor streaming events to the caller-supplied
      // callback (wired in server.ts to the activity tracker + trace store).
      // A swallowed-error wrapper here so a reporting failure can never
      // abort or slow a merge.
      onSupervisorEvent: onSupervisorEvent
        ? (event: AgentEvent) => {
            try {
              onSupervisorEvent(job.taskId, event)
            } catch {
              // intentionally swallowed
            }
          }
        : undefined,
      // ADR-0100: the operator's own uncommitted edits on the integration
      // checkout are swept into a wip(operator) commit so the queue keeps
      // moving. Resolved per job rather than per daemon so `mars operator set
      // operator-auto-commit off` takes effect on the next merge without a
      // restart — the same live-effect guarantee every other control lever has.
      autoCommitOperatorDirt: !isOperatorAutoCommitDisabled(resolveControlLevers()),
      // ADR-0100 slice 7: a cheap typecheck of the integration checkout right
      // after the auto-commit. A detector, not a gate — `mergeBranch` reports
      // the outcome through `onOperatorAutoCommit` and fast-forwards either
      // way. A timeout is inconclusive (no signal), so it passes: the operator
      // is told a commit was made regardless, and a false "your edit is
      // broken" is worse than a missed detection the scheduled baseline health
      // check will catch anyway.
      onProbeIntegrationAfterAutoCommit: async ({ commitSha }) => {
        const root = (await resolveVcs().repoRoot({ cwd: job.worktreePath })) ?? job.worktreePath
        const probe = await probeMainTypecheck({
          repoRoot: root,
          timeoutMs: PROBE_TIMEOUT_MS,
        })
        if (probe.ok === false) return { passed: false, output: probe.output }
        if (probe.ok === 'timeout') {
          log(
            `[merge-worker] task ${job.taskId}: post-auto-commit typecheck probe of ` +
              `${commitSha.slice(0, 9)} timed out after ${PROBE_TIMEOUT_MS}ms — no signal`,
          )
        }
        return { passed: true }
      },
      onOperatorAutoCommit: async (info) => {
        await speakOperatorAutoCommitNotice({
          taskId: job.taskId,
          branch: job.integrationBranch,
          commitSha: info.commitSha,
          files: info.files,
        })
        if (info.probe && !info.probe.passed) {
          // Best-effort: the commit and the merge have already landed, so a
          // raise failure must never surface as a merge failure.
          await raiseBrokenAutoCommitAlert({
            taskId: job.taskId,
            branch: job.integrationBranch,
            commitSha: info.commitSha,
            output: info.probe.output,
          }).catch((raiseErr: unknown) => {
            log(
              `[merge-worker] task ${job.taskId}: broken-auto-commit alert raise errored ` +
                `(non-fatal): ${raiseErr instanceof Error ? raiseErr.message : String(raiseErr)}`,
            )
          })
        }
      },
    })

    // Task-tier gate failure at the rebased-tree verify step.
    //
    // When onVerifyRebasedTree returns { passed: false }, mergeBranch returns
    // { merged: false, reason: 'rebased-verify-failed', rebasedVerifyOutput }.
    // This is a CODE failure (the coder's change failed a gate), not a merge
    // infrastructure failure. Deliver it as a { status: 'failed' } result with
    // a 'verify:gate/<name>: ...' error prefix so the merge primitive can stamp
    // failedPhase:'verify' — letting `mars continue` rewind to the coder with
    // the gate output rather than doing a destructive restart (which is the
    // behaviour triggered by failedPhase:'setup').
    //
    // Without this intercept, the worker would treat { merged: false } as a
    // success (result = { status: 'done', result: mergeResult }) and the
    // primitive would fall through to mark the task done — a false-green that
    // silently discards the coder's branch.
    if (!mergeResult.merged && mergeResult.reason === 'rebased-verify-failed') {
      const gateOutput = mergeResult.rebasedVerifyOutput ?? ''

      // Extract the gate name from the "=== <gate-name> (FAIL) [task] ===" header.
      const gateNameRaw = gateOutput.match(/^=== ([^\s(]+) \(FAIL\)/m)?.[1] ?? null
      // Sanitize to a valid step-id slug (lowercase alphanum + hyphens only).
      const gateSlug = gateNameRaw !== null
        ? gateNameRaw.replace(/[^a-z0-9]/gi, '-').toLowerCase().replace(/-{2,}/g, '-').replace(/^-|-$/g, '')
        : 'unknown'
      // First non-header output line: the human-readable violation.
      const firstViolation = gateOutput.split('\n').find(l => l.trim() !== '' && !l.startsWith('===')) ?? ''
      const readableReason = gateNameRaw !== null
        ? `Gate ${gateNameRaw} rejected the change: ${firstViolation}`.slice(0, 400).trim()
        : 'task-tier gate rejected the rebased tree'
      const errorMsg = `verify:gate/${gateSlug}: ${readableReason}`

      result = { status: 'failed', error: errorMsg, errorCode: 'crash' }
      log(`[merge-worker] job ${job.id}: task-tier rebased-tree gate failure → ${errorMsg}`)
      await store
        .markFailed(job.id, { message: errorMsg, code: 'crash' })
        .catch((e: unknown) => {
          log(
            `[merge-worker] job ${job.id} markFailed failed (non-fatal): ${(e as Error).message}`,
          )
        })
      resolveMergeJob(job.taskId, result)
      return
    }

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
    // Persist gate check results and record passes for Control Room status display.
    // Both are best-effort — never allowed to fail the merge.
    if (collectedGateChecks.length > 0) {
      await store.recordGateChecks(job.id, collectedGateChecks).catch((e: unknown) => {
        log(
          `[merge-worker] job ${job.id} recordGateChecks failed (non-fatal): ${(e as Error).message}`,
        )
      })
      const passedGateIds = collectedGateChecks
        .filter((c) => c.passed && c.gateId !== null)
        .map((c) => c.gateId as string)
      await recordVerifyGatePasses(passedGateIds).catch(() => {})
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const errorCode: 'watchdog' | 'crash' | 'canceled' =
      signal.aborted
        ? 'canceled'
        : err instanceof MergeAbortedError && err.reason === 'watchdog'
          ? 'watchdog'
          : 'crash'
    if (errorCode === 'watchdog') {
      // Stamp the watchdog fire time so the Steward autotune bump lane can
      // hold for WATCHDOG_COOLDOWN_MS before raising the implement cap again.
      lastMergeWatchdogFireMs = Date.now()
    }
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

  // Freeze the Domain Flow (if any) once a merge succeeds — makes it a
  // permanent record of the domain reading at merge time. Best-effort:
  // a missing flow is a silent no-op; try/catch swallows both "not found"
  // and "already frozen" so this never fails the merge.
  if (result.status === 'done') {
    try {
      await freezeFlow(resolveStateClient(), job.taskId)
    } catch (_) {
      // best-effort — a missing flow is fine
    }
  }
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
  mergeFn = (args: MergeFnArgs): Promise<MergeResult> => resolveVcs().merge(args),
  onSupervisorEvent,
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
        // Signal to the waiting merge primitive that this job has been claimed
        // and execution is beginning. The primitive uses this to start its
        // step-level hard timeout at execution time, not at enqueue time.
        signalMergeJobClaimed(job.taskId)
        await runMergeJob(job, store, log, mergeFn, jobAc.signal, onSupervisorEvent)
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
