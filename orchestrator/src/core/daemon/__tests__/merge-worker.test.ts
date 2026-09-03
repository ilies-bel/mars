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

vi.mock('../../verify-gates.js', () => ({
  loadVerifyGates: () => Promise.resolve(_mockIntegrationGates),
}))
vi.mock('../../store/state-client.js', () => ({
  resolveStateClient: () => ({}),
}))
vi.mock('../../ports/verifier/registry.js', () => ({
  resolveVerifier: () => ({ run: _mockVerifierRun, kind: 'test-mock' }),
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
        supervisorConversation: [],
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
