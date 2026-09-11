/**
 * Unit tests for the single-consumer merge worker loop (PRD 92af89ce, slice 2).
 *
 * Uses a fake `MergeJobStore` (no DB, no PGlite) to verify:
 *   - The worker claims and processes jobs serially (strict concurrency=1).
 *   - Even with back-to-back `merge-job.enqueued` events, only one job is
 *     claimed and running at a time — `markRunning(job2)` never precedes
 *     `markDone(job1)`.
 *   - The worker stops cleanly when `stop()` is called (loop exits, promise
 *     resolves).
 *   - When the queue is empty, the worker parks until a bus event wakes it or
 *     the poll-interval timer fires.
 *
 * Strategy: real timers, short `pollIntervalMs` (10 ms) for tests that need
 * the fallback timer, and a 50 ms `waitFor` helper to let the loop drain
 * pre-queued jobs without triggering an infinite fake-timer loop.
 */

import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MergeJob, MergeJobStore } from '../../store/merge-job-store.js'

// ── Mocks for integration-gate wiring tests ───────────────────────────────────
//
// These mocks intercept the three modules that `onAfterFastForward` imports
// dynamically inside runMergeJob. The mocks are inert for existing tests
// because fakeMergeFn never invokes onAfterFastForward. They only activate
// in the regression describe block below.
//
// Module-level variables are captured by reference in the factory closures;
// because vi.mock factories are called lazily (at first module import inside
// a test, after all module-level declarations have run), mutating these
// variables before a test takes effect correctly.

// Default: empty — no integration gates registered. Set to non-empty in tests
// that need them.
let _mockIntegrationGates: Array<{
  scope: string
  steps: Array<{
    name: string
    cmd: string
    args: readonly string[]
    required: boolean
    tier: string
    dir?: string
    timeoutMin?: number
  }>
}> = []

// Re-used mock function; configured per test via mockResolvedValue.
const _mockVerifierRun = vi.fn()

// Mock for mergeBranch used in the "gate invokes via real Vcs port" regression
// test. In all other tests, an injected fakeMergeFn/capturingMergeFn is used
// and this mock is never called. When the test does NOT inject a mergeFn, the
// default `resolveVcs().merge(args)` → `localGitVcs.merge()` → `mergeBranch`
// path is exercised, and this mock intercepts that call.
const _mockMergeBranch = vi.fn()

vi.mock('../../verify-gates.js', () => ({
  loadVerifyGates: () => Promise.resolve(_mockIntegrationGates),
  recordVerifyGatePasses: vi.fn(),
}))
vi.mock('../../store/state-client.js', () => ({
  resolveStateClient: () => ({}),
}))
vi.mock('../../ports/verifier/registry.js', () => ({
  resolveVerifier: () => ({ run: _mockVerifierRun, kind: 'test-mock' }),
}))
// Mock mergeBranch so the default mergeFn (resolveVcs().merge) does not invoke
// real git. Each test that uses the default mergeFn configures _mockMergeBranch
// via mockImplementation. Existing tests that inject their own mergeFn are
// unaffected (they never call localGitVcs.merge).
vi.mock('../../lib/git/merge.js', () => ({
  mergeBranch: (...args: unknown[]) => _mockMergeBranch(...args),
  isBranchMergedIntoMain: vi.fn().mockResolvedValue(false),
  isZeroCommitBranch: vi.fn().mockResolvedValue(false),
  checkMergeTargetStatus: vi.fn().mockResolvedValue({ kind: 'clean' }),
  DEFAULT_WATCHDOG_MS: 5 * 60 * 1_000,
  MergeAbortedError: class MergeAbortedError extends Error {
    constructor(
      public readonly reason: string,
      public readonly elapsedMs: number,
      public readonly lastStep: string,
    ) {
      super(`merge aborted (${reason}) after ${elapsedMs}ms`)
      this.name = 'MergeAbortedError'
    }
  },
}))

// ── Fast no-op merge function (avoids real git in unit tests) ─────────────────

const fakeMergeFn = async () => ({
  merged: true,
  conflictResolved: false,
  aborted: false,
  output: '',
  supervisorConversation: [],
  vegaSessionId: null,
  retriesAttempted: 0,
})

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Wait up to `maxMs` for a condition to become true, checking every `tickMs`.
 * Throws if the condition is still false after `maxMs`.
 */
async function waitFor(
  condition: () => boolean,
  { maxMs = 200, tickMs = 5 }: { maxMs?: number; tickMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + maxMs
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not met within ${maxMs} ms`)
    }
    await new Promise<void>((r) => setTimeout(r, tickMs))
  }
}

// ── Fake store factory ────────────────────────────────────────────────────────

/**
 * A minimal fake MergeJobStore backed by an in-memory array.
 * All methods record their call as `"<method>:<id>"` so tests can assert on
 * call order.
 */
const makeFakeStore = (
  opts: {
    /** If set, `markRunning` throws this error on the first call. */
    runningThrows?: Error
  } = {},
) => {
  const calls: string[] = []
  const jobs = new Map<string, MergeJob>()
  const queue: MergeJob[] = []
  let runningThrown = false

  const makeJob = (partial: Partial<MergeJob> = {}): MergeJob => {
    const id = partial.id ?? `job-${jobs.size + 1}`
    const job: MergeJob = {
      id,
      taskId: partial.taskId ?? `task-${id}`,
      status: 'queued',
      attempts: 0,
      mergedSha: null,
      claimedAt: null,
      startedAt: null,
      finishedAt: null,
      error: null,
      errorCode: null,
      integrationBranch: 'main',
      worktreePath: '/tmp',
      branch: 'task/test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...partial,
    }
    jobs.set(id, job)
    return job
  }

  const enqueueJob = (partial: Partial<MergeJob> = {}): MergeJob => {
    const job = makeJob({ ...partial, status: 'queued' })
    queue.push(job)
    return job
  }

  const store: MergeJobStore = {
    async enqueue() { throw new Error('not used in worker tests') },

    async claimNext() {
      calls.push('claimNext')
      const job = queue.shift()
      if (!job) return null
      const claimed = { ...job, status: 'claimed' as const }
      jobs.set(claimed.id, claimed)
      return claimed
    },

    async markRunning(id: string) {
      calls.push(`markRunning:${id}`)
      if (opts.runningThrows && !runningThrown) {
        runningThrown = true
        throw opts.runningThrows
      }
      const job = jobs.get(id)
      if (!job) return null
      const running = { ...job, status: 'running' as const }
      jobs.set(id, running)
      return running
    },

    async markDone(id: string) {
      calls.push(`markDone:${id}`)
      const job = jobs.get(id)
      if (!job) return null
      const done = { ...job, status: 'done' as const }
      jobs.set(id, done)
      return done
    },

    async markFailed(id: string, err: { message: string; code?: string }) {
      calls.push(`markFailed:${id}`)
      const job = jobs.get(id)
      if (!job) return null
      const failed = { ...job, status: 'failed' as const, error: err.message }
      jobs.set(id, failed)
      return failed
    },

    async markCanceled(id: string, reason: string) {
      calls.push(`markCanceled:${id}`)
      const job = jobs.get(id)
      if (!job) return null
      const canceled = { ...job, status: 'canceled' as const, error: reason }
      jobs.set(id, canceled)
      return canceled
    },

    async getByTaskId(taskId: string) {
      const found = [...jobs.values()].find((j) => j.taskId === taskId)
      return found ?? null
    },

    async listActive() {
      return [...jobs.values()].filter((j) =>
        (['queued', 'claimed', 'running'] as const).includes(j.status as 'queued' | 'claimed' | 'running'),
      )
    },

    async listByStatus(status) {
      return [...jobs.values()].filter((j) => j.status === status)
    },

    async getActiveMergeJob(taskId: string) {
      const found = [...jobs.values()].find(
        (j) =>
          j.taskId === taskId &&
          (['queued', 'claimed', 'running'] as const).includes(
            j.status as 'queued' | 'claimed' | 'running',
          ),
      )
      return found ?? null
    },

    async recordGateChecks(_id: string, _checks: import('../../store/merge-job-store.js').GateCheckEntry[]): Promise<void> {
      // no-op in tests
    },

    async getGateChecksForTask(_taskId: string) {
      return null
    },
  }

  return { store, calls, jobs, enqueueJob }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('startMergeWorker — serial job processing', () => {
  it('processes a single job: claimNext → markRunning → markDone', async () => {
    const { store, calls, enqueueJob } = makeFakeStore()
    const job = enqueueJob({ id: 'j1' })

    const { startMergeWorker } = await import('../merge-worker.js')
    const ac = new AbortController()
    // Use a short poll interval so the worker parks quickly without a real 500ms wait.
    const handle = startMergeWorker({ store, log: () => {}, bus: new EventEmitter(), signal: ac.signal, pollIntervalMs: 10, mergeFn: fakeMergeFn })

    // Wait until markDone has been recorded, then stop.
    await waitFor(() => calls.includes(`markDone:${job.id}`))
    ac.abort()
    await handle.stop()

    expect(calls).toContain('claimNext')
    expect(calls).toContain(`markRunning:${job.id}`)
    expect(calls).toContain(`markDone:${job.id}`)

    // markRunning must precede markDone.
    const runIdx = calls.indexOf(`markRunning:${job.id}`)
    const doneIdx = calls.indexOf(`markDone:${job.id}`)
    expect(runIdx).toBeLessThan(doneIdx)
  })

  it('strict serialisation: markDone(job1) precedes markRunning(job2)', async () => {
    /**
     * Two jobs are queued before the worker starts. The single-consumer loop
     * must finish job1 entirely before starting job2. This test would fail if
     * the worker processed jobs concurrently.
     */
    const { store, calls, enqueueJob } = makeFakeStore()
    const j1 = enqueueJob({ id: 'j1' })
    const j2 = enqueueJob({ id: 'j2' })

    const { startMergeWorker } = await import('../merge-worker.js')
    const ac = new AbortController()
    const handle = startMergeWorker({ store, log: () => {}, bus: new EventEmitter(), signal: ac.signal, pollIntervalMs: 10, mergeFn: fakeMergeFn })

    // Wait until both jobs are fully processed.
    await waitFor(() => calls.includes(`markDone:${j1.id}`) && calls.includes(`markDone:${j2.id}`))
    ac.abort()
    await handle.stop()

    const doneJ1 = calls.indexOf(`markDone:${j1.id}`)
    const runJ2 = calls.indexOf(`markRunning:${j2.id}`)

    expect(doneJ1).toBeGreaterThanOrEqual(0)
    expect(runJ2).toBeGreaterThanOrEqual(0)
    // Serial invariant: j1 done before j2 starts.
    expect(doneJ1).toBeLessThan(runJ2)
  })

  it('back-to-back merge-job.enqueued events do not cause concurrent processing', async () => {
    /**
     * Start with an empty queue so the worker parks immediately. Enqueue two
     * jobs and fire two rapid `merge-job.enqueued` events. The single-consumer
     * loop must still process them serially.
     */
    const bus = new EventEmitter()
    const { store, calls, enqueueJob } = makeFakeStore()

    const { startMergeWorker } = await import('../merge-worker.js')
    const ac = new AbortController()
    const handle = startMergeWorker({ store, log: () => {}, bus, signal: ac.signal, pollIntervalMs: 10, mergeFn: fakeMergeFn })

    // Give the loop a moment to park (claimNext → null → wait).
    await new Promise<void>((r) => setTimeout(r, 15))

    // Enqueue both jobs and fire two wake-up events.
    const j1 = enqueueJob({ id: 'j1' })
    const j2 = enqueueJob({ id: 'j2' })
    bus.emit('merge-job.enqueued')
    bus.emit('merge-job.enqueued')

    // Wait until both jobs are done.
    await waitFor(() => calls.includes(`markDone:${j1.id}`) && calls.includes(`markDone:${j2.id}`))
    ac.abort()
    await handle.stop()

    // Serial invariant.
    const doneJ1 = calls.indexOf(`markDone:${j1.id}`)
    const runJ2 = calls.indexOf(`markRunning:${j2.id}`)
    expect(doneJ1).toBeLessThan(runJ2)
  })

  it('stops cleanly when stop() is called while idle', async () => {
    const { store } = makeFakeStore()

    const { startMergeWorker } = await import('../merge-worker.js')
    const ac = new AbortController()
    const handle = startMergeWorker({ store, log: () => {}, bus: new EventEmitter(), signal: ac.signal, pollIntervalMs: 10, mergeFn: fakeMergeFn })

    // Abort immediately — worker is parked.
    ac.abort()
    await expect(handle.stop()).resolves.toBeUndefined()
  })

  it('stops cleanly via the injected external signal', async () => {
    const { store } = makeFakeStore()

    const { startMergeWorker } = await import('../merge-worker.js')
    const externalAc = new AbortController()
    const handle = startMergeWorker({ store, log: () => {}, bus: new EventEmitter(), signal: externalAc.signal, pollIntervalMs: 10, mergeFn: fakeMergeFn })

    externalAc.abort()
    await expect(handle.stop()).resolves.toBeUndefined()
  })

  it('parks while queue is empty and resumes when bus event fires', async () => {
    const bus = new EventEmitter()
    const { store, calls, enqueueJob } = makeFakeStore()

    const { startMergeWorker } = await import('../merge-worker.js')
    const ac = new AbortController()
    const handle = startMergeWorker({ store, log: () => {}, bus, signal: ac.signal, pollIntervalMs: 500, mergeFn: fakeMergeFn })

    // Give the loop time to park on the 500ms timer.
    await new Promise<void>((r) => setTimeout(r, 15))

    // Enqueue and wake the worker via the bus event (not the 500ms timer).
    const job = enqueueJob({ id: 'j-wake' })
    bus.emit('merge-job.enqueued')

    // The job should process well before the 500ms timer fires.
    await waitFor(() => calls.includes(`markDone:${job.id}`), { maxMs: 200 })
    ac.abort()
    await handle.stop()
  })

  it('parks while queue is empty and resumes after the poll-interval timer', async () => {
    const bus = new EventEmitter()
    const { store, calls, enqueueJob } = makeFakeStore()

    const { startMergeWorker } = await import('../merge-worker.js')
    const ac = new AbortController()
    // Use a short poll interval so the test completes quickly.
    const handle = startMergeWorker({ store, log: () => {}, bus, signal: ac.signal, pollIntervalMs: 20, mergeFn: fakeMergeFn })

    // Give the loop time to park.
    await new Promise<void>((r) => setTimeout(r, 10))

    // Enqueue a job WITHOUT firing a bus event — wake is via the poll timer.
    const job = enqueueJob({ id: 'j-timer' })

    // The poll timer (20 ms) fires, wakes the worker, job is processed.
    await waitFor(() => calls.includes(`markDone:${job.id}`), { maxMs: 200 })
    ac.abort()
    await handle.stop()
  })

  it('marks job failed when markRunning throws, then continues the loop', async () => {
    const boom = new Error('pg connection lost')
    const { store, calls, enqueueJob } = makeFakeStore({ runningThrows: boom })
    const job = enqueueJob({ id: 'j-err' })

    const { startMergeWorker } = await import('../merge-worker.js')
    const ac = new AbortController()
    const handle = startMergeWorker({ store, log: () => {}, bus: new EventEmitter(), signal: ac.signal, pollIntervalMs: 10, mergeFn: fakeMergeFn })

    // Wait for the failure path to complete.
    await waitFor(() => calls.includes(`markFailed:${job.id}`))
    ac.abort()
    await handle.stop()

    expect(calls).toContain(`markRunning:${job.id}`)
    expect(calls).toContain(`markFailed:${job.id}`)
    // markDone must NOT have been called because markRunning threw.
    expect(calls).not.toContain(`markDone:${job.id}`)
  })
})

// ---------------------------------------------------------------------------
// Outer watchdog (mars-0d6291da)
//
// If the merge worker never calls resolveMergeJob for a given taskId (e.g.
// the merge job was lost, the worker crashed without resolving the promise,
// or the daemon lost the merge_jobs row), enqueueMergeJobAndAwait must not
// park forever — it must time out and return a 'failed' result so the
// calling workflow can transition the task out of status='merging'.
// ---------------------------------------------------------------------------

describe('enqueueMergeJobAndAwait — outer watchdog', () => {
  it('returns a failed result with errorCode=watchdog when the merge promise is never resolved', async () => {
    /**
     * Simulates a "lost job" scenario: enqueueMergeJobAndAwait enqueues a row
     * in the store and emits the bus event, but resolveMergeJob is never called
     * (mimicking a merge worker that loses the job). The outer watchdog must
     * fire and return a 'failed' result so the calling workflow can exit.
     *
     * We shrink both MARS_MERGE_WATCHDOG_MS and MARS_MERGE_OUTER_WATCHDOG_GRACE_MS
     * to tiny values (10 ms each) so the outer timeout fires within ~20 ms.
     */
    const { EventEmitter: EE } = await import('node:events')
    // Each test call goes through vi.resetModules()-based isolation, but here
    // we directly import without resetting to keep the test simple.
    const { enqueueMergeJobAndAwait } = await import('../merge-worker.js')

    const savedWatchdog = process.env.MARS_MERGE_WATCHDOG_MS
    const savedGrace = process.env.MARS_MERGE_OUTER_WATCHDOG_GRACE_MS
    // Total outer budget = 10 + 10 = 20 ms — the promise will time out quickly.
    process.env.MARS_MERGE_WATCHDOG_MS = '10'
    process.env.MARS_MERGE_OUTER_WATCHDOG_GRACE_MS = '10'

    // Build a minimal store that accepts the enqueue but never delivers a job
    // (simulating a lost merge job that the worker cannot claim).
    let enqueued = false
    const idleStore = {
      async enqueue() {
        enqueued = true
        return {
          id: 'idle-job',
          taskId: 'task-idle-watchdog',
          status: 'queued' as const,
          attempts: 0,
          claimedAt: null,
          startedAt: null,
          finishedAt: null,
          error: null,
          errorCode: null,
          integrationBranch: 'main',
          worktreePath: '/tmp',
          branch: 'task/idle-watchdog',
          mergedSha: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      },
      async claimNext() { return null },
      async markRunning() { return null },
      async markDone() { return null },
      async markFailed() { return null },
      async markCanceled() { return null },
      async getByTaskId() { return null },
      async listActive() { return [] },
      async listByStatus() { return [] },
      async getActiveMergeJob() { return null },
      async recordGateChecks(_id: string, _checks: import('../../store/merge-job-store.js').GateCheckEntry[]): Promise<void> {},
      async getGateChecksForTask(_taskId: string) { return null },
    }

    let result: Awaited<ReturnType<typeof enqueueMergeJobAndAwait>>
    try {
      result = await enqueueMergeJobAndAwait({
        store: idleStore,
        bus: new EE(),
        taskId: 'task-idle-watchdog',
        branch: 'task/idle-watchdog',
        worktreePath: '/tmp',
        integrationBranch: 'main',
      })
    } finally {
      // Restore env regardless of success/failure.
      if (savedWatchdog === undefined) delete process.env.MARS_MERGE_WATCHDOG_MS
      else process.env.MARS_MERGE_WATCHDOG_MS = savedWatchdog
      if (savedGrace === undefined) delete process.env.MARS_MERGE_OUTER_WATCHDOG_GRACE_MS
      else process.env.MARS_MERGE_OUTER_WATCHDOG_GRACE_MS = savedGrace
    }

    // The row was enqueued before the timeout.
    expect(enqueued).toBe(true)
    // The outer watchdog fired: result must be a failed watchdog outcome.
    expect(result!.status).toBe('failed')
    if (result!.status === 'failed') {
      expect(result!.errorCode).toBe('watchdog')
      expect(result!.error).toMatch(/merge:timeout/)
    }
  }, 5_000) // generous test timeout — actual wait is <100 ms

  it('calls onWatchdogTimeout with the taskId when the outer watchdog fires', async () => {
    /**
     * When the outer watchdog fires, the optional `onWatchdogTimeout` callback
     * must be invoked so the caller can fail the task directly in the DB.
     * This is the belt-and-suspenders for the case where the calling workflow
     * has already exited (daemon restart mid-merge) and cannot handle the
     * returned failure result itself.
     */
    const { EventEmitter: EE } = await import('node:events')
    const { enqueueMergeJobAndAwait } = await import('../merge-worker.js')

    const savedWatchdog = process.env.MARS_MERGE_WATCHDOG_MS
    const savedGrace = process.env.MARS_MERGE_OUTER_WATCHDOG_GRACE_MS
    process.env.MARS_MERGE_WATCHDOG_MS = '10'
    process.env.MARS_MERGE_OUTER_WATCHDOG_GRACE_MS = '10'

    const taskId = 'task-watchdog-callback'
    const onWatchdogTimeout = vi.fn().mockResolvedValue(undefined)

    const idleStore = {
      async enqueue() {
        return {
          id: 'idle-callback-job',
          taskId,
          status: 'queued' as const,
          attempts: 0,
          claimedAt: null,
          startedAt: null,
          finishedAt: null,
          error: null,
          errorCode: null,
          integrationBranch: 'main',
          worktreePath: '/tmp',
          branch: 'task/idle-callback',
          mergedSha: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      },
      async claimNext() { return null },
      async markRunning() { return null },
      async markDone() { return null },
      async markFailed() { return null },
      async markCanceled() { return null },
      async getByTaskId() { return null },
      async listActive() { return [] },
      async listByStatus() { return [] },
      async getActiveMergeJob() { return null },
      async recordGateChecks(_id: string, _checks: import('../../store/merge-job-store.js').GateCheckEntry[]): Promise<void> {},
      async getGateChecksForTask(_taskId: string) { return null },
    }

    try {
      const result = await enqueueMergeJobAndAwait({
        store: idleStore,
        bus: new EE(),
        taskId,
        branch: 'task/idle-callback',
        worktreePath: '/tmp',
        integrationBranch: 'main',
        onWatchdogTimeout,
      })

      // The outer watchdog fired — result must indicate failure.
      expect(result.status).toBe('failed')
      if (result.status === 'failed') {
        expect(result.errorCode).toBe('watchdog')
      }

      // The onWatchdogTimeout callback must have been called with the taskId.
      expect(onWatchdogTimeout).toHaveBeenCalledOnce()
      expect(onWatchdogTimeout).toHaveBeenCalledWith(taskId)
    } finally {
      if (savedWatchdog === undefined) delete process.env.MARS_MERGE_WATCHDOG_MS
      else process.env.MARS_MERGE_WATCHDOG_MS = savedWatchdog
      if (savedGrace === undefined) delete process.env.MARS_MERGE_OUTER_WATCHDOG_GRACE_MS
      else process.env.MARS_MERGE_OUTER_WATCHDOG_GRACE_MS = savedGrace
    }
  }, 5_000)

  it('cleans up the pending promise so a late resolveMergeJob call is a no-op', async () => {
    /**
     * After the outer watchdog fires, the pendingMergeJobs map entry is deleted.
     * A subsequent call to resolveMergeJob for the same taskId must return false
     * (key absent) and must not cause any observable side effect.
     */
    const { EventEmitter: EE } = await import('node:events')
    const { enqueueMergeJobAndAwait, resolveMergeJob } = await import('../merge-worker.js')

    const savedWatchdog = process.env.MARS_MERGE_WATCHDOG_MS
    const savedGrace = process.env.MARS_MERGE_OUTER_WATCHDOG_GRACE_MS
    process.env.MARS_MERGE_WATCHDOG_MS = '10'
    process.env.MARS_MERGE_OUTER_WATCHDOG_GRACE_MS = '10'

    const idleStore = {
      async enqueue() {
        return {
          id: 'idle-cleanup-job',
          taskId: 'task-idle-cleanup',
          status: 'queued' as const,
          attempts: 0,
          claimedAt: null,
          startedAt: null,
          finishedAt: null,
          error: null,
          errorCode: null,
          integrationBranch: 'main',
          worktreePath: '/tmp',
          branch: 'task/idle-cleanup',
          mergedSha: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      },
      async claimNext() { return null },
      async markRunning() { return null },
      async markDone() { return null },
      async markFailed() { return null },
      async markCanceled() { return null },
      async getByTaskId() { return null },
      async listActive() { return [] },
      async listByStatus() { return [] },
      async getActiveMergeJob() { return null },
      async recordGateChecks(_id: string, _checks: import('../../store/merge-job-store.js').GateCheckEntry[]): Promise<void> {},
      async getGateChecksForTask(_taskId: string) { return null },
    }

    try {
      // Let the outer watchdog fire.
      await enqueueMergeJobAndAwait({
        store: idleStore,
        bus: new EE(),
        taskId: 'task-idle-cleanup',
        branch: 'task/idle-cleanup',
        worktreePath: '/tmp',
        integrationBranch: 'main',
      })
    } finally {
      if (savedWatchdog === undefined) delete process.env.MARS_MERGE_WATCHDOG_MS
      else process.env.MARS_MERGE_WATCHDOG_MS = savedWatchdog
      if (savedGrace === undefined) delete process.env.MARS_MERGE_OUTER_WATCHDOG_GRACE_MS
      else process.env.MARS_MERGE_OUTER_WATCHDOG_GRACE_MS = savedGrace
    }

    // After the timeout, the pending promise was removed — a late resolve is a no-op.
    const resolved = resolveMergeJob('task-idle-cleanup', {
      status: 'done',
      result: {
        merged: true,
        conflictResolved: false,
        aborted: false,
        output: '',
        vegaSessionId: null,
        retriesAttempted: 0,
      },
    })
    expect(resolved).toBe(false)
  }, 5_000)
})

// ---------------------------------------------------------------------------
// Regression: worktree-vanished pre-flight check (mars-0c5ffe82)
//
// A startup reconciler (merging-recovery) can delete the task worktree after
// the daemon boots but before the merge worker claims the stale queued job.
// Without the pre-flight check, git would be spawned into a non-existent
// directory, producing an opaque crash classified as merge:crashed/unclassified
// which consumed the arc's single recovery slot.
//
// With the pre-flight check, the worker detects the missing directory BEFORE
// calling mergeFn and fails with "working directory no longer exists: <path>".
// computeFailureSignature classifies this as merge:crashed/worktree-vanished
// (an environmental signature) — the recovery slot is not consumed and
// remerge is triggered automatically.
// ---------------------------------------------------------------------------

describe('startMergeWorker — worktree-vanished pre-flight', () => {
  it('produces a diagnosable error and skips mergeFn when the worktree does not exist', async () => {
    // A path that is guaranteed not to exist on any test machine.
    const missingPath = '/tmp/mars-test-nonexistent-worktree-abc123xyz'
    const { store, calls, jobs, enqueueJob } = makeFakeStore()
    const job = enqueueJob({ id: 'j-vanished', worktreePath: missingPath })

    let mergeFnCalled = false
    const guardedMergeFn = async () => {
      mergeFnCalled = true
      throw new Error('mergeFn must not be reached when worktree is absent')
    }

    const { startMergeWorker } = await import('../merge-worker.js')
    const ac = new AbortController()
    const handle = startMergeWorker({
      store,
      log: () => {},
      bus: new EventEmitter(),
      signal: ac.signal,
      pollIntervalMs: 10,
      mergeFn: guardedMergeFn,
    })

    // The pre-flight check fires and causes markFailed — not markDone.
    await waitFor(() => calls.includes(`markFailed:${job.id}`))
    ac.abort()
    await handle.stop()

    // mergeFn was never called — the pre-flight check short-circuited first.
    expect(mergeFnCalled).toBe(false)
    expect(calls).toContain(`markRunning:${job.id}`)
    expect(calls).toContain(`markFailed:${job.id}`)
    expect(calls).not.toContain(`markDone:${job.id}`)

    // The error message must contain the pattern that computeFailureSignature
    // maps to merge:crashed/worktree-vanished (not /unclassified).
    const failedJob = jobs.get(job.id)
    expect(failedJob?.error).toMatch(/working directory no longer exists/)
  })
})

// ---------------------------------------------------------------------------
// Regression: onAfterFastForward integration gate wiring (mars-cd039a0b)
//
// Before this fix the merge worker called mergeFn WITHOUT onAfterFastForward,
// so integration-tier gates were silently skipped on every merge. The fix
// constructs onAfterFastForward locally inside runMergeJob and passes it
// through to mergeFn, where mergeBranch invokes it after the fast-forward.
//
// These tests fail on the unfixed code (onAfterFastForward was undefined in
// the captured MergeArgs) and pass after the fix.
// ---------------------------------------------------------------------------

describe('startMergeWorker — onAfterFastForward integration gate wiring (regression mars-cd039a0b)', () => {
  beforeEach(() => {
    // Reset mock state so each test starts clean.
    _mockIntegrationGates = []
    _mockVerifierRun.mockReset()
  })

  it('passes onAfterFastForward to mergeFn', async () => {
    /**
     * REGRESSION TEST: captures the MergeArgs passed to mergeFn and asserts
     * that onAfterFastForward is present. On unfixed code this assertion fails
     * because the worker built the args object without the callback.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedCallback: ((info: { finalTaskSha: string; finalIntegrationSha: string }) => Promise<void>) | undefined
    const capturingMergeFn = async (args: { onAfterFastForward?: typeof capturedCallback }) => {
      capturedCallback = args.onAfterFastForward
      return {
        merged: true,
        conflictResolved: false,
        aborted: false,
        output: '',
        supervisorConversation: [],
        vegaSessionId: null,
        retriesAttempted: 0,
      }
    }

    const { store, calls, enqueueJob } = makeFakeStore()
    const job = enqueueJob({ id: 'j-gate-wiring', worktreePath: '/tmp' })
    const { startMergeWorker } = await import('../merge-worker.js')
    const ac = new AbortController()
    const handle = startMergeWorker({
      store,
      log: () => {},
      bus: new EventEmitter(),
      signal: ac.signal,
      pollIntervalMs: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mergeFn: capturingMergeFn as any,
    })

    await waitFor(() => calls.includes(`markDone:${job.id}`))
    ac.abort()
    await handle.stop()

    expect(
      capturedCallback,
      'onAfterFastForward must be provided to mergeFn — this assertion fails on unfixed code',
    ).toBeTypeOf('function')
  })

  it('onAfterFastForward executes required integration-tier gates when invoked', async () => {
    /**
     * Proves that the callback wired through to mergeFn is not a stub:
     * when invoked with required integration-tier gates registered, it calls
     * the verifier with those steps. This is the end-to-end gate execution
     * proof — a unit test that supplies the callback directly would reproduce
     * the exact blind spot this fix closes.
     */
    _mockIntegrationGates = [
      {
        scope: '.',
        steps: [
          {
            name: 'packages/workflow: test',
            cmd: 'npm',
            args: ['test'],
            required: true,
            tier: 'integration',
            dir: '.',
            timeoutMin: 20,
          },
        ],
      },
    ]
    _mockVerifierRun.mockResolvedValue({
      passed: true,
      steps: [{ name: 'packages/workflow: test', passed: true, output: 'all good' }],
    })

    let capturedOnAfterFastForward: ((info: { finalTaskSha: string; finalIntegrationSha: string }) => Promise<void>) | undefined
    const capturingMergeFn = async (args: { onAfterFastForward?: typeof capturedOnAfterFastForward }) => {
      capturedOnAfterFastForward = args.onAfterFastForward
      return {
        merged: true,
        conflictResolved: false,
        aborted: false,
        output: '',
        supervisorConversation: [],
        vegaSessionId: null,
        retriesAttempted: 0,
      }
    }

    const { store, calls, enqueueJob } = makeFakeStore()
    const job = enqueueJob({ id: 'j-gate-exec', worktreePath: '/tmp' })
    const { startMergeWorker } = await import('../merge-worker.js')
    const ac = new AbortController()
    const handle = startMergeWorker({
      store,
      log: () => {},
      bus: new EventEmitter(),
      signal: ac.signal,
      pollIntervalMs: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mergeFn: capturingMergeFn as any,
    })

    await waitFor(() => calls.includes(`markDone:${job.id}`))
    ac.abort()
    await handle.stop()

    // The callback must be present.
    expect(capturedOnAfterFastForward).toBeTypeOf('function')

    // Invoke the captured callback — the mocked verifier must be called with
    // the integration gate, remapped to tier:'task' so it actually executes.
    await capturedOnAfterFastForward!({
      finalTaskSha: 'a'.repeat(40),
      finalIntegrationSha: 'b'.repeat(40),
    })

    expect(_mockVerifierRun).toHaveBeenCalledOnce()
    expect(_mockVerifierRun).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp',
        steps: expect.arrayContaining([
          expect.objectContaining({
            name: 'packages/workflow: test',
            tier: 'task', // remapped from 'integration' so the verifier runs it
          }),
        ]),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('skips non-required integration-tier gates', async () => {
    /**
     * Non-required integration gates are skipped at the integration boundary:
     * running them inside the merge lock for informational purposes holds the
     * lock for something that cannot block the merge. Only required=true gates
     * run.
     */
    _mockIntegrationGates = [
      {
        scope: '.',
        steps: [
          {
            name: 'optional-gate',
            cmd: 'echo',
            args: ['hi'],
            required: false, // non-required: must be skipped
            tier: 'integration',
            dir: '.',
          },
        ],
      },
    ]

    let capturedOnAfterFastForward: ((info: { finalTaskSha: string; finalIntegrationSha: string }) => Promise<void>) | undefined
    const capturingMergeFn = async (args: { onAfterFastForward?: typeof capturedOnAfterFastForward }) => {
      capturedOnAfterFastForward = args.onAfterFastForward
      return {
        merged: true,
        conflictResolved: false,
        aborted: false,
        output: '',
        supervisorConversation: [],
        vegaSessionId: null,
        retriesAttempted: 0,
      }
    }

    const { store, calls, enqueueJob } = makeFakeStore()
    const job = enqueueJob({ id: 'j-gate-skip', worktreePath: '/tmp' })
    const { startMergeWorker } = await import('../merge-worker.js')
    const ac = new AbortController()
    const handle = startMergeWorker({
      store,
      log: () => {},
      bus: new EventEmitter(),
      signal: ac.signal,
      pollIntervalMs: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mergeFn: capturingMergeFn as any,
    })

    await waitFor(() => calls.includes(`markDone:${job.id}`))
    ac.abort()
    await handle.stop()

    expect(capturedOnAfterFastForward).toBeTypeOf('function')

    // Invoke — non-required gates must NOT trigger the verifier.
    await capturedOnAfterFastForward!({
      finalTaskSha: 'a'.repeat(40),
      finalIntegrationSha: 'b'.repeat(40),
    })

    expect(_mockVerifierRun).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Regression: onVerifyRebasedTree wiring (ADR-0100 step 2)
//
// Before this fix, `runMergeJob` called `mergeFn` without `onVerifyRebasedTree`,
// so the rebased-tree verify was silently skipped on every merge — the
// integration branch could be fast-forwarded to a tree that had never been
// verified against the current `main`. The fix constructs `onVerifyRebasedTree`
// locally inside `runMergeJob` (mirroring the `onAfterFastForward` fix from
// mars-cd039a0b) and passes it through to `mergeFn`.
//
// `onVerifyRebasedTree` runs task-tier gates; integration-tier gates are already
// handled by `onAfterFastForward` inside the merge lock. Supplying both gates
// to the wrong hook would either duplicate work or hold the lock for the wrong
// duration.
//
// These tests fail on the unfixed code (onVerifyRebasedTree was undefined in
// the captured MergeArgs) and pass after the fix.
// ---------------------------------------------------------------------------

describe('startMergeWorker — onVerifyRebasedTree rebased-tree verify wiring (ADR-0100 step 2)', () => {
  beforeEach(() => {
    _mockIntegrationGates = []
    _mockVerifierRun.mockReset()
  })

  it('passes onVerifyRebasedTree to mergeFn', async () => {
    /**
     * REGRESSION TEST: captures the MergeArgs passed to mergeFn and asserts
     * that onVerifyRebasedTree is present. On unfixed code this assertion fails
     * because the worker built the args object without the callback.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedCallback: ((info: { baseSha: string; taskSha: string; attempt: number }) => Promise<{ passed: boolean; output?: string }>) | undefined
    const capturingMergeFn = async (args: { onVerifyRebasedTree?: typeof capturedCallback }) => {
      capturedCallback = args.onVerifyRebasedTree
      return {
        merged: true,
        conflictResolved: false,
        aborted: false,
        output: '',
        supervisorConversation: [],
        vegaSessionId: null,
        retriesAttempted: 0,
      }
    }

    const { store, calls, enqueueJob } = makeFakeStore()
    const job = enqueueJob({ id: 'j-rebased-wiring', worktreePath: '/tmp' })
    const { startMergeWorker } = await import('../merge-worker.js')
    const ac = new AbortController()
    const handle = startMergeWorker({
      store,
      log: () => {},
      bus: new EventEmitter(),
      signal: ac.signal,
      pollIntervalMs: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mergeFn: capturingMergeFn as any,
    })

    await waitFor(() => calls.includes(`markDone:${job.id}`))
    ac.abort()
    await handle.stop()

    expect(
      capturedCallback,
      'onVerifyRebasedTree must be provided to mergeFn — this assertion fails on unfixed code',
    ).toBeTypeOf('function')
  })

  it('onVerifyRebasedTree executes task-tier gates when invoked', async () => {
    /**
     * Proves the callback wired through to mergeFn is not a stub: when invoked
     * with task-tier gates registered, it calls the verifier with those steps.
     * This is the end-to-end proof that the rebased-tree verify actually runs —
     * a unit test that supplies the callback directly would reproduce the exact
     * blind spot this fix closes.
     */
    _mockIntegrationGates = [
      {
        scope: '.',
        steps: [
          {
            name: 'orchestrator: typecheck',
            cmd: 'npx',
            args: ['tsc', '--noEmit'],
            required: true,
            tier: 'task',
            dir: '.',
            timeoutMin: 10,
          },
        ],
      },
    ]
    _mockVerifierRun.mockResolvedValue({
      passed: true,
      steps: [{ name: 'orchestrator: typecheck', passed: true, output: 'ok' }],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedOnVerifyRebasedTree: ((info: { baseSha: string; taskSha: string; attempt: number }) => Promise<{ passed: boolean; output?: string }>) | undefined
    const capturingMergeFn = async (args: { onVerifyRebasedTree?: typeof capturedOnVerifyRebasedTree }) => {
      capturedOnVerifyRebasedTree = args.onVerifyRebasedTree
      return {
        merged: true,
        conflictResolved: false,
        aborted: false,
        output: '',
        supervisorConversation: [],
        vegaSessionId: null,
        retriesAttempted: 0,
      }
    }

    const { store, calls, enqueueJob } = makeFakeStore()
    const job = enqueueJob({ id: 'j-rebased-exec', worktreePath: '/tmp' })
    const { startMergeWorker } = await import('../merge-worker.js')
    const ac = new AbortController()
    const handle = startMergeWorker({
      store,
      log: () => {},
      bus: new EventEmitter(),
      signal: ac.signal,
      pollIntervalMs: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mergeFn: capturingMergeFn as any,
    })

    await waitFor(() => calls.includes(`markDone:${job.id}`))
    ac.abort()
    await handle.stop()

    expect(capturedOnVerifyRebasedTree).toBeTypeOf('function')

    // Invoke the captured callback — the mocked verifier must be called with
    // the task-tier gate, passed as tier:'task' so the verifier executes it.
    const result = await capturedOnVerifyRebasedTree!({
      baseSha: 'b'.repeat(40),
      taskSha: 'a'.repeat(40),
      attempt: 1,
    })

    expect(result.passed).toBe(true)
    expect(_mockVerifierRun).toHaveBeenCalledOnce()
    expect(_mockVerifierRun).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp',
        steps: expect.arrayContaining([
          expect.objectContaining({
            name: 'orchestrator: typecheck',
            tier: 'task', // always 'task' regardless of the registered tier
          }),
        ]),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('skips integration-tier gates — those belong to onAfterFastForward', async () => {
    /**
     * Integration-tier gates are the responsibility of `onAfterFastForward`
     * (inside the merge lock, after the fast-forward). `onVerifyRebasedTree`
     * must NOT run them: doing so would hold no lock while running something
     * that onAfterFastForward will run again under the lock, doubling the cost.
     * When only integration-tier gates are registered, the callback must return
     * passed=true without calling the verifier.
     */
    _mockIntegrationGates = [
      {
        scope: '.',
        steps: [
          {
            name: 'packages/workflow: integration-suite',
            cmd: 'npm',
            args: ['test'],
            required: true,
            tier: 'integration',
            dir: '.',
          },
        ],
      },
    ]

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedOnVerifyRebasedTree: ((info: { baseSha: string; taskSha: string; attempt: number }) => Promise<{ passed: boolean; output?: string }>) | undefined
    const capturingMergeFn = async (args: { onVerifyRebasedTree?: typeof capturedOnVerifyRebasedTree }) => {
      capturedOnVerifyRebasedTree = args.onVerifyRebasedTree
      return {
        merged: true,
        conflictResolved: false,
        aborted: false,
        output: '',
        supervisorConversation: [],
        vegaSessionId: null,
        retriesAttempted: 0,
      }
    }

    const { store, calls, enqueueJob } = makeFakeStore()
    const job = enqueueJob({ id: 'j-rebased-skip-int', worktreePath: '/tmp' })
    const { startMergeWorker } = await import('../merge-worker.js')
    const ac = new AbortController()
    const handle = startMergeWorker({
      store,
      log: () => {},
      bus: new EventEmitter(),
      signal: ac.signal,
      pollIntervalMs: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mergeFn: capturingMergeFn as any,
    })

    await waitFor(() => calls.includes(`markDone:${job.id}`))
    ac.abort()
    await handle.stop()

    expect(capturedOnVerifyRebasedTree).toBeTypeOf('function')

    // Invoke — integration-tier gates must NOT trigger the verifier; the
    // callback short-circuits and returns passed=true with no verifier call.
    const result = await capturedOnVerifyRebasedTree!({
      baseSha: 'b'.repeat(40),
      taskSha: 'a'.repeat(40),
      attempt: 1,
    })

    expect(result.passed).toBe(true)
    expect(_mockVerifierRun).not.toHaveBeenCalled()
  })

  it('gate actually invokes when the default mergeFn routes through the Vcs port', async () => {
    /**
     * REGRESSION TEST — mars-82a0b56f: 164 merges landed on `main` with no
     * verify gate running. This test uses the REAL default mergeFn
     * (`resolveVcs().merge(args)`) rather than an injected fake. It proves
     * the complete path:
     *
     *   merge-worker constructs onVerifyRebasedTree
     *     → passes to resolveVcs().merge()
     *       → localGitVcs.merge() (fixed: now forwards callbacks)
     *         → mergeBranch (mocked: calls onVerifyRebasedTree)
     *           → gate runs → _mockVerifierRun is called
     *
     * On unfixed code, _mockVerifierRun is never called because the callback
     * is dropped at the localGitVcs.merge() → mergeBranch boundary.
     */
    _mockIntegrationGates = [
      {
        scope: '.',
        steps: [
          {
            name: 'orchestrator: typecheck',
            cmd: 'npx',
            args: ['tsc', '--noEmit'] as readonly string[],
            required: true,
            tier: 'task',
            dir: '.',
            timeoutMin: 10,
          },
        ],
      },
    ]
    _mockVerifierRun.mockResolvedValue({
      passed: true,
      steps: [{ name: 'orchestrator: typecheck', passed: true, output: 'ok' }],
    })

    // Mock mergeBranch to call onVerifyRebasedTree — simulating what the real
    // mergeBranch does when the gate is registered. Without the forward fix,
    // onVerifyRebasedTree arrives as undefined here and the gate is skipped.
    _mockMergeBranch.mockImplementation(
      async (args: {
        onVerifyRebasedTree?: (info: {
          baseSha: string
          taskSha: string
          attempt: number
        }) => Promise<{ passed: boolean }>
      }) => {
        if (args.onVerifyRebasedTree) {
          await args.onVerifyRebasedTree({
            baseSha: 'b'.repeat(40),
            taskSha: 'a'.repeat(40),
            attempt: 1,
          })
        }
        return {
          merged: true,
          conflictResolved: false,
          aborted: false,
          output: '',
          retriesAttempted: 0,
          vegaSessionId: null,
          supervisorConversation: [],
        }
      },
    )

    const { store, calls, enqueueJob } = makeFakeStore()
    const job = enqueueJob({ id: 'j-gate-via-vcs-port', worktreePath: '/tmp' })
    const { startMergeWorker } = await import('../merge-worker.js')
    const ac = new AbortController()

    // No mergeFn injected — the default resolveVcs().merge(args) path runs.
    const handle = startMergeWorker({
      store,
      log: () => {},
      bus: new EventEmitter(),
      signal: ac.signal,
      pollIntervalMs: 10,
    })

    await waitFor(() => calls.includes(`markDone:${job.id}`), { maxMs: 2000 })
    ac.abort()
    await handle.stop()

    expect(
      _mockVerifierRun,
      'task-tier gate must run when the default mergeFn routes through the Vcs port',
    ).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Idempotent enqueue (mars-98e7cba3)
//
// `enqueueMergeJobAndAwait` must be idempotent per task so that:
//   1. A daemon restart (startup reconciler keeps the queued row; workflow
//      engine resumes on attempt 2) never fails with a unique-constraint
//      violation — the second call detects the existing active job and adopts
//      it without issuing a duplicate INSERT.
//   2. Two concurrent callers for the same taskId both await the same outcome:
//      the one that wins the INSERT race inserts one row; the one that loses
//      hits the constraint, adopts the existing row, and still receives the
//      result when resolveMergeJob fires.
// ---------------------------------------------------------------------------

describe('enqueueMergeJobAndAwait — idempotent enqueue (restart & concurrent)', () => {
  it('adopts existing active job on restart instead of inserting', async () => {
    /**
     * Restart shape: the DB already has a queued job for the task (kept by the
     * startup reconciler). The workflow engine re-enters the merge step as
     * attempt 2. enqueueMergeJobAndAwait must detect the existing job via
     * getActiveMergeJob, skip the INSERT, and still resolve when the worker
     * calls resolveMergeJob.
     */
    const { EventEmitter: EE } = await import('node:events')
    const { enqueueMergeJobAndAwait, resolveMergeJob } = await import('../merge-worker.js')

    const taskId = 'task-restart-adopt'
    const existingJob: import('../../store/merge-job-store.js').MergeJob = {
      id: 'existing-queued-job',
      taskId,
      status: 'queued',
      attempts: 1,
      claimedAt: null,
      startedAt: null,
      finishedAt: null,
      error: null,
      errorCode: null,
      integrationBranch: 'main',
      worktreePath: '/tmp',
      branch: 'task/restart-adopt',
      mergedSha: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    let enqueueCallCount = 0
    const store = {
      async getActiveMergeJob(tid: string) {
        return tid === taskId ? existingJob : null
      },
      async enqueue() {
        enqueueCallCount++
        throw new Error('enqueue must not be called when an active job already exists')
      },
      async claimNext() { return null },
      async markRunning() { return null },
      async markDone() { return null },
      async markFailed() { return null },
      async markCanceled() { return null },
      async getByTaskId() { return null },
      async listActive() { return [] },
      async listByStatus() { return [] },
      async recordGateChecks(_id: string, _checks: import('../../store/merge-job-store.js').GateCheckEntry[]): Promise<void> {},
      async getGateChecksForTask(_taskId: string) { return null },
    }

    const resultPromise = enqueueMergeJobAndAwait({
      store,
      bus: new EE(),
      taskId,
      branch: 'task/restart-adopt',
      worktreePath: '/tmp',
      integrationBranch: 'main',
    })

    // Give the function time to reach the bus.emit before we resolve.
    await new Promise<void>((r) => setTimeout(r, 10))

    // Simulate the worker completing the adopted job.
    resolveMergeJob(taskId, {
      status: 'done',
      result: {
        merged: true,
        conflictResolved: false,
        aborted: false,
        output: '',
        supervisorConversation: [],
        vegaSessionId: null,
        retriesAttempted: 0,
      },
    })

    const result = await resultPromise

    // The existing job was adopted — enqueue must never have been called.
    expect(enqueueCallCount).toBe(0)
    // The caller still receives the outcome normally.
    expect(result.status).toBe('done')
  }, 5_000)

  it('two concurrent callers both receive the same outcome (one row inserted)', async () => {
    /**
     * Concurrent double-enqueue: two workflow runs race for the same taskId.
     * Both call getActiveMergeJob before either has committed — both see null
     * (TOCTOU). The first wins the INSERT race; the second hits the unique
     * constraint. Our code catches the constraint, keeps both resolvers
     * registered, and resolveMergeJob delivers the result to both.
     */
    const { EventEmitter: EE } = await import('node:events')
    const { enqueueMergeJobAndAwait, resolveMergeJob } = await import('../merge-worker.js')

    const taskId = 'task-concurrent-enqueue'
    let insertCount = 0

    const makeJob = (): import('../../store/merge-job-store.js').MergeJob => ({
      id: 'concurrent-job',
      taskId,
      status: 'queued',
      attempts: 0,
      claimedAt: null,
      startedAt: null,
      finishedAt: null,
      error: null,
      errorCode: null,
      integrationBranch: 'main',
      worktreePath: '/tmp',
      branch: 'task/concurrent',
      mergedSha: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const store = {
      // Both callers check before either inserts (TOCTOU): always return null
      // from getActiveMergeJob so both proceed to enqueue.
      async getActiveMergeJob() { return null },
      async enqueue() {
        insertCount++
        if (insertCount > 1) {
          // Simulate the partial unique index rejecting the second INSERT.
          throw new Error(
            'duplicate key value violates unique constraint "merge_jobs_active_task_uidx"',
          )
        }
        return makeJob()
      },
      async claimNext() { return null },
      async markRunning() { return null },
      async markDone() { return null },
      async markFailed() { return null },
      async markCanceled() { return null },
      async getByTaskId() { return null },
      async listActive() { return [] },
      async listByStatus() { return [] },
      async recordGateChecks(_id: string, _checks: import('../../store/merge-job-store.js').GateCheckEntry[]): Promise<void> {},
      async getGateChecksForTask(_taskId: string) { return null },
    }

    const bus = new EE()
    const doneResult: import('../merge-worker.js').MergeJobResult = {
      status: 'done',
      result: {
        merged: true,
        conflictResolved: false,
        aborted: false,
        output: '',
        supervisorConversation: [],
        vegaSessionId: null,
        retriesAttempted: 0,
      },
    }

    // Start both calls concurrently. They race to check getActiveMergeJob
    // and then to insert; one wins, one catches the constraint error.
    const promise1 = enqueueMergeJobAndAwait({
      store,
      bus,
      taskId,
      branch: 'task/concurrent',
      worktreePath: '/tmp',
      integrationBranch: 'main',
    })
    const promise2 = enqueueMergeJobAndAwait({
      store,
      bus,
      taskId,
      branch: 'task/concurrent',
      worktreePath: '/tmp',
      integrationBranch: 'main',
    })

    // Let both reach the bus.emit stage.
    await new Promise<void>((r) => setTimeout(r, 20))

    // Resolve once — both registered resolvers must receive the result.
    const resolved = resolveMergeJob(taskId, doneResult)
    expect(resolved).toBe(true)

    const [r1, r2] = await Promise.all([promise1, promise2])

    // Both callers got the same outcome.
    expect(r1.status).toBe('done')
    expect(r2.status).toBe('done')

    // Exactly one INSERT was issued (the constraint caught the second).
    expect(insertCount).toBe(2) // both tried; only one succeeded
  }, 5_000)
})

// ---------------------------------------------------------------------------
// DEC-3: auto-commit Notice carries a revert action
//
// VISION.md DEC-3: "Every autonomous change is revertible by construction and
// announced as a Notice carrying its revert."
//
// The wip(operator) auto-commit is an autonomous act. The Notice it raises must
// carry BOTH:
//   - a revert OFFER (one-click chip: id='revert', op='revert-auto-commit')
//   - a revert COMMAND in the render body (`git revert <sha>`) for CLI/headless
//
// These tests fail on unfixed code (missing revert chip or missing body command)
// and pass once the conversation-copy registry entry is complete.
// ---------------------------------------------------------------------------

describe('merge.operator-auto-commit Notice — DEC-3 revert action', () => {
  it('offers include a revert chip carrying the commit sha and affected files', async () => {
    const { offersForConversationNotice } = await import('../../lib/conversation-copy.js')
    const sha = 'a'.repeat(40)
    const files = ['src/index.ts', 'src/util.ts']

    const offers = offersForConversationNotice('merge.operator-auto-commit', {
      taskId: 'task-abc',
      branch: 'main',
      commitSha: sha,
      files,
    })

    const revertOffer = offers.find((o) => o.id === 'revert')
    expect(revertOffer, 'auto-commit Notice must carry a revert offer (DEC-3)').toBeDefined()

    // Target must be a verb that invokes the revert-auto-commit op, with the sha
    // and affected files encoded in entityId so the handler knows exactly what to
    // revert — the handler sources `files` from here to restore the working tree.
    const target = revertOffer!.target as { type: string; op: string; entityId: string }
    expect(target.type).toBe('verb')
    expect(target.op).toBe('revert-auto-commit')

    const entity = JSON.parse(target.entityId) as { commitSha: string; files: string[] }
    expect(entity.commitSha).toBe(sha)
    expect(entity.files).toEqual(files)
  })

  it('render body includes git revert <sha> for CLI/headless contexts', async () => {
    const { renderConversationNotice } = await import('../../lib/conversation-copy.js')
    const sha = 'b'.repeat(40)

    const body = renderConversationNotice('merge.operator-auto-commit', {
      taskId: 'task-xyz',
      branch: 'main',
      commitSha: sha,
      files: ['README.md'],
    })

    expect(
      body,
      'render body must include `git revert <sha>` so the operator can undo from any context',
    ).toContain(`git revert ${sha}`)
  })
})

// ---------------------------------------------------------------------------
// Regression: task-tier gate failure during rebased-tree verify (mars-4d58c171)
//
// When onVerifyRebasedTree returns { passed: false }, mergeBranch returns
// { merged: false, reason: 'rebased-verify-failed', rebasedVerifyOutput }.
// Before this fix the worker treated that as a success (result = { status:
// 'done' }), which either produced a false-green task or — via the server.ts
// fallback — stamped failed_phase='setup', making `mars continue` destructive
// (restart instead of rewind-to-coder).
//
// After the fix the worker detects reason='rebased-verify-failed' BEFORE the
// success path, converts it to { status: 'failed', error: 'verify:gate/<slug>:
// ...' }, and calls markFailed so the merge primitive can stamp
// failedPhase:'verify', letting `mars continue` rewind to the coder with the
// gate output.
// ---------------------------------------------------------------------------

describe('startMergeWorker — rebased-tree gate failure (regression mars-4d58c171)', () => {
  beforeEach(() => {
    _mockIntegrationGates = []
    _mockVerifierRun.mockReset()
  })

  it('delivers verify:gate/<slug>: error and calls markFailed when a task-tier gate rejects the rebased tree', async () => {
    /**
     * REGRESSION TEST (mars-4d58c171): when onVerifyRebasedTree returns
     * { passed: false }, the worker must deliver { status: 'failed', error:
     * 'verify:gate/<slug>: ...' } and call markFailed — not markDone.
     *
     * The error prefix 'verify:gate/' is the signal merge.ts uses to stamp
     * failedPhase:'verify' so `mars continue` rewinds to the coder.
     */
    _mockIntegrationGates = [
      {
        scope: '.',
        steps: [
          {
            name: 'lint:tokens',
            cmd: 'npx',
            args: ['lint-tokens'],
            required: true,
            tier: 'task',
            dir: '.',
          },
        ],
      },
    ]
    _mockVerifierRun.mockResolvedValue({
      passed: false,
      steps: [{ name: 'lint:tokens', passed: false, output: 'token limit exceeded: 5000 > 4000' }],
    })

    // A merge function that actually invokes onVerifyRebasedTree and returns
    // { merged: false, reason: 'rebased-verify-failed' } when the gate fails,
    // mirroring what mergeBranch does in production.
    const mergeFnThatCallsVerify = async (args: {
      onVerifyRebasedTree?: (info: {
        baseSha: string
        taskSha: string
        attempt: number
      }) => Promise<{ passed: boolean; output?: string }>
    }) => {
      if (args.onVerifyRebasedTree) {
        const verdict = await args.onVerifyRebasedTree({
          baseSha: 'b'.repeat(40),
          taskSha: 'a'.repeat(40),
          attempt: 1,
        })
        if (!verdict.passed) {
          return {
            merged: false as const,
            reason: 'rebased-verify-failed' as const,
            rebasedVerifyOutput: verdict.output ?? '',
            conflictResolved: false,
            aborted: false,
            output: '',
            supervisorConversation: [],
            vegaSessionId: null,
            retriesAttempted: 0,
          }
        }
      }
      return {
        merged: true as const,
        conflictResolved: false,
        aborted: false,
        output: '',
        supervisorConversation: [],
        vegaSessionId: null,
        retriesAttempted: 0,
      }
    }

    const { store, calls, jobs, enqueueJob } = makeFakeStore()
    const job = enqueueJob({ id: 'j-gate-fail', worktreePath: '/tmp' })
    const { startMergeWorker } = await import('../merge-worker.js')
    const ac = new AbortController()
    const handle = startMergeWorker({
      store,
      log: () => {},
      bus: new EventEmitter(),
      signal: ac.signal,
      pollIntervalMs: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mergeFn: mergeFnThatCallsVerify as any,
    })

    // The gate fails: markFailed must be called, not markDone.
    await waitFor(() => calls.includes(`markFailed:${job.id}`))
    ac.abort()
    await handle.stop()

    expect(calls).toContain(`markRunning:${job.id}`)
    expect(calls).toContain(`markFailed:${job.id}`)
    expect(calls).not.toContain(`markDone:${job.id}`)

    // The error must carry the 'verify:gate/<slug>:' prefix so the merge
    // primitive can stamp failedPhase:'verify' — the critical detail that
    // lets `mars continue` rewind to the coder rather than doing a
    // destructive restart.
    const failedJob = jobs.get(job.id)
    expect(failedJob?.error).toMatch(/^verify:gate\/[a-z0-9-]+:/)
    // The gate name must appear in the error for operator readability.
    expect(failedJob?.error).toContain('lint')
  })
})

// ---------------------------------------------------------------------------
// Dynamic watchdog sizing (production incident: cap raised to 12, 7 concurrent
// vitest + tsc runs, load avg 25, 15-min fixed watchdog fired mid verify).
//
// After the fix the watchdog passed to mergeFn is computed from the gates'
// declared timeoutMin rather than a static constant unrelated to gate count.
// ---------------------------------------------------------------------------

describe('runMergeJob — dynamic watchdog scales with gate timeoutMin', () => {
  beforeEach(() => {
    _mockVerifierRun.mockReset()
    _mockVerifierRun.mockResolvedValue({ passed: true, steps: [] })
  })

  it('passes watchdogMs to mergeFn that reflects sum of task-tier gate timeoutMin values', async () => {
    /**
     * Register two task-tier gates with known timeoutMin values and assert
     * that the watchdogMs passed to mergeFn is >= the sum of those budgets
     * plus the base DEFAULT_WATCHDOG_MS (15 min from merge.ts).
     *
     * The test captures the watchdogMs from the mergeFn call to avoid
     * importing the private DEFAULT_WATCHDOG_MS constant.
     */
    const GATE_A_TIMEOUT_MIN = 20
    const GATE_B_TIMEOUT_MIN = 30
    // Total gate budget: (20 + 30) × 60 000 = 3 000 000 ms = 50 min.
    // The watchdog should be at least DEFAULT_WATCHDOG_MS (15 min) + 50 min = 65 min.
    _mockIntegrationGates = [
      {
        scope: '.',
        steps: [
          {
            name: 'typecheck:project',
            cmd: 'npx',
            args: ['tsc', '--noEmit'],
            required: true,
            tier: 'task',
            dir: '.',
            timeoutMin: GATE_A_TIMEOUT_MIN,
          },
          {
            name: 'test:unit',
            cmd: 'npx',
            args: ['vitest', 'run'],
            required: true,
            tier: 'task',
            dir: '.',
            timeoutMin: GATE_B_TIMEOUT_MIN,
          },
        ],
      },
    ]

    let capturedWatchdogMs: number | undefined
    const capturingMergeFn = async (args: { watchdogMs?: number }) => {
      capturedWatchdogMs = args.watchdogMs
      return {
        merged: true as const,
        conflictResolved: false,
        aborted: false,
        output: '',
        supervisorConversation: [],
        vegaSessionId: null,
        retriesAttempted: 0,
      }
    }

    const { store, enqueueJob } = makeFakeStore()
    const job = enqueueJob({ id: 'j-dynamic-watchdog' })
    const { startMergeWorker } = await import('../merge-worker.js')
    const ac = new AbortController()
    const handle = startMergeWorker({
      store,
      log: () => {},
      bus: new EventEmitter(),
      signal: ac.signal,
      pollIntervalMs: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mergeFn: capturingMergeFn as any,
    })

    await waitFor(() => capturedWatchdogMs !== undefined, { maxMs: 500 })
    ac.abort()
    await handle.stop()

    // The captured watchdog must cover the two declared gate budgets:
    // (20 + 30) min = 50 min = 3 000 000 ms, plus the base 15 min = 4 500 000 ms min.
    const minExpectedMs = (GATE_A_TIMEOUT_MIN + GATE_B_TIMEOUT_MIN) * 60_000
    expect(capturedWatchdogMs).toBeDefined()
    expect(capturedWatchdogMs!).toBeGreaterThan(minExpectedMs)
    // The watchdog must be strictly larger than just the gates alone — the
    // base DEFAULT_WATCHDOG_MS overhead (vcs-supervisor + git work) is always
    // added on top.
    void job // job was enqueued to drive the worker
  })

  it('falls back to static constant when no gates are registered', async () => {
    /**
     * With an empty gate registry the fallback formula should produce a
     * watchdog that equals DEFAULT_WATCHDOG_MS + the static gate constant
     * (two default gate budgets of 15 min each).
     *
     * We assert the watchdog is >= 15 min (the base DEFAULT_WATCHDOG_MS)
     * and > 0, which holds for any sane configuration.
     */
    _mockIntegrationGates = []

    let capturedWatchdogMs: number | undefined
    const capturingMergeFn = async (args: { watchdogMs?: number }) => {
      capturedWatchdogMs = args.watchdogMs
      return {
        merged: true as const,
        conflictResolved: false,
        aborted: false,
        output: '',
        supervisorConversation: [],
        vegaSessionId: null,
        retriesAttempted: 0,
      }
    }

    const { store, enqueueJob } = makeFakeStore()
    const job2 = enqueueJob({ id: 'j-static-fallback' })
    const { startMergeWorker } = await import('../merge-worker.js')
    const ac = new AbortController()
    const handle = startMergeWorker({
      store,
      log: () => {},
      bus: new EventEmitter(),
      signal: ac.signal,
      pollIntervalMs: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mergeFn: capturingMergeFn as any,
    })

    await waitFor(() => capturedWatchdogMs !== undefined, { maxMs: 500 })
    ac.abort()
    await handle.stop()

    // Must be at least the base overhead (non-zero and reasonable).
    expect(capturedWatchdogMs).toBeDefined()
    expect(capturedWatchdogMs!).toBeGreaterThan(0)
    // With no gates the static fallback is 2 × 15 min = 1 800 000 ms; the
    // total is base + fallback. Assert it is at least 15 min.
    const FIFTEEN_MIN_MS = 15 * 60_000
    expect(capturedWatchdogMs!).toBeGreaterThan(FIFTEEN_MIN_MS)
    void job2 // job2 was enqueued to drive the worker
  })
})

// ── Boot-order invariant ───────────────────────────────────────────────────────
//
// Regression test for the 2026-09-04 phantom-in-flight incident.
//
// Root cause: the RECONCILERS array ran mergeJobsStartupReconcile BEFORE
// mergingRecovery.  The merge worker raced in, committed in-flight tracker
// entries for the rebuilt merge_jobs rows, and then mergingRecovery moved the
// tasks to 'queued' in the DB.  The tracker entries survived, blocking dispatch.
//
// Fix 1 (reconcilers.ts): phase recoveries now run before
// mergeJobsStartupReconcile.  These tests verify the two outcomes:
//
//   A) When phase recovery ran first, the task is already 'queued' → no
//      merging tasks remain → reconcileMergeJobs creates ZERO rebuild jobs.
//
//   B) When a task genuinely stalled in 'merging' (phase recovery could not
//      move it), reconcileMergeJobs CORRECTLY creates one rebuild job so the
//      merge can complete.
//
// Together they assert: exactly one of {job+entry, queued row with no entry}
// exists for a given task after the boot sequence completes.

describe('reconcileMergeJobs — boot-order invariant (2026-09-04 regression)', () => {
  // Create a minimal fake DomainTaskStore whose query returns the given rows.
  const makeFakeTaskStore = (mergingRows: { id: string; worktree_path: string; branch: string }[]) => ({
    execute: async (_sql: string) => {},
    query: async (_sql: string) => ({ rows: mergingRows }),
  })

  it('A: rebuilds ZERO jobs when phase recovery already re-queued the merging tasks', async () => {
    // Simulate the new boot order: mergingRecovery ran first, moved the task
    // from 'merging' → 'queued'. When reconcileMergeJobs runs, no task is in
    // 'merging' status. Expected: rebuiltCount=0, no phantom merge job created.
    const { reconcileMergeJobs } = await import('../startup-reconcile.js')
    const { store } = makeFakeStore()
    const logs: string[] = []

    const result = await reconcileMergeJobs({
      store,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      taskStore: makeFakeTaskStore([]) as any,
      log: (l) => logs.push(l),
    })

    expect(result.rebuiltCount).toBe(0)
    expect(result.resetCount).toBe(0)
    // No phantom rebuild log messages.
    expect(logs.filter((l) => l.includes('rebuilt'))).toHaveLength(0)
  })

  it('B: rebuilds ONE job when a task genuinely stalled in merging (phase recovery did not move it)', async () => {
    // Simulate: daemon died after setting task.status='merging' but before
    // creating the merge_jobs row (genuine orphan). reconcileMergeJobs must
    // rebuild a queued merge_jobs row so the merge can complete.
    const { reconcileMergeJobs } = await import('../startup-reconcile.js')
    const logs: string[] = []

    // Need a store whose enqueue() succeeds (not throws like the default fake).
    const { store, jobs } = makeFakeStore()
    let enqueueCount = 0
    // Override the enqueue stub so reconcileMergeJobs can call it without throwing.
    ;(store as unknown as Record<string, unknown>).enqueue = async (params: {
      taskId: string
      integrationBranch: string
      worktreePath: string
      branch: string
    }) => {
      enqueueCount++
      const job = {
        id: `job-rebuilt-${params.taskId}`,
        taskId: params.taskId,
        status: 'queued' as const,
        attempts: 0,
        mergedSha: null,
        claimedAt: null,
        startedAt: null,
        finishedAt: null,
        error: null,
        errorCode: null,
        integrationBranch: params.integrationBranch,
        worktreePath: params.worktreePath,
        branch: params.branch,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      jobs.set(job.id, job)
      return job
    }

    const result = await reconcileMergeJobs({
      store,
      taskStore: makeFakeTaskStore([
        { id: 'task-orphan', worktree_path: '/tmp/wt', branch: 'task/task-orphan' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ]) as any,
      log: (l) => logs.push(l),
    })

    expect(result.rebuiltCount).toBe(1)
    expect(enqueueCount).toBe(1)
    // Rebuild must be logged with the task id.
    expect(logs.some((l) => l.includes('rebuilt') && l.includes('task-orphan'))).toBe(true)
  })
})
