/**
 * End-to-end test: merge primitive routes through the durable single-consumer
 * worker and executes jobs strictly sequentially.
 *
 * This test verifies the observable contract:
 *   - Two concurrent calls to the `merge` primitive both complete successfully.
 *   - The underlying `mergeFn` (injected into the worker) is never called
 *     concurrently: the second call's `mergeFn` does not start until the first
 *     call's `mergeFn` has returned.
 *
 * Strategy: mock all system boundaries (git operations, DB) with minimal fakes
 * so the test runs in-memory with no real worktrees, no real Postgres, and no
 * real git. The timing of the fake `mergeFn` (a promise that resolves after a
 * short delay) provides the causal evidence for sequential execution.
 *
 * All the interesting serialisation logic lives in `startMergeWorker` (slice 2)
 * and the `enqueueMergeJobAndAwait` / `resolveMergeJob` pattern (slice 4).
 * This test confirms both ends of the pipe are connected.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { MergeJob, MergeJobStore, EnqueueMergeJobInput } from '../../core/store/merge-job-store.js'

// ── Module mocks (system boundaries) ─────────────────────────────────────────
//
// All paths below are relative to THIS test file
// (`src/workflows/__tests__/`). Vitest resolves them to the same modules
// that `primitives/index.ts` (`src/workflows/primitives/`) imports, so the
// mocks intercept the primitives' calls.

vi.mock('../../core/lib/git/merge', () => ({
  checkMergeTargetStatus: async () => ({ kind: 'clean' }),
  isZeroCommitBranch: async () => false,
  // mergeBranch is not called in the queue path, but must be exported so the
  // module shape is valid.
  mergeBranch: async () => { throw new Error('mergeBranch should not be called in queue path') },
  MergeAbortedError: class MergeAbortedError extends Error {},
}))

vi.mock('../../core/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/queue')>()
  return {
    ...actual,
    getTask: async (taskId: string) => ({
      id: taskId,
      status: 'merging',
      spec: null,
      previewValidated: false,
    }),
    updateTask: async () => {},
    hasIncompleteBlockers: async () => false,
    enqueueTask: async () => { throw new Error('enqueueTask not expected in this test') },
  }
})

vi.mock('../../core/lib/git/worktree', () => ({
  removeWorktree: async () => {},
  createWorktree: async () => { throw new Error('not used') },
  attachToOriginWorktree: async () => { throw new Error('not used') },
  provisionCommitterWorktree: async () => { throw new Error('not used') },
  OriginWorktreeMissingError: class OriginWorktreeMissingError extends Error {},
}))

vi.mock('../../core/lib/origin', () => ({
  resolveOriginIdForTask: async (taskId: string) => taskId,
}))

vi.mock('../../core/context', () => ({
  resolveContext: () => ({
    repoRoot: '/fake-repo',
    stateDir: '/fake-repo/.mars',
    queueDbPath: '/fake-repo/.mars/mars.db',
    stateDbPath: '/fake-repo/.mars/mars.db',
    observabilityDbPath: '/fake-repo/.mars/observability.duckdb',
  }),
  getStateDir: () => '/fake-repo/.mars',
}))

vi.mock('../../core/queue-fix-tasks', () => ({
  handleTaskFailureWithFixTask: async () => {},
}))

vi.mock('../../core/lib/action-queue', () => ({
  raiseActionQueueItem: async () => {},
}))

vi.mock('../../core/lib/reflect-signals', () => ({
  recordSignals: async () => {},
  isReflectDisabled: () => true,
}))

vi.mock('../../core/store/memory-packet-store', () => ({
  resolveTaskDomains: async () => [],
  fetchLessonsForTask: async () => null,
}))

// ── In-memory merge-job store ─────────────────────────────────────────────────

function makeFakeJobStore() {
  const jobs = new Map<string, MergeJob>()
  const queue: MergeJob[] = []
  let idCounter = 0

  const store: MergeJobStore = {
    async enqueue(input: EnqueueMergeJobInput): Promise<MergeJob> {
      const id = `job-${++idCounter}`
      const job: MergeJob = {
        id,
        taskId: input.taskId,
        status: 'queued',
        attempts: 0,
        mergedSha: null,
        claimedAt: null,
        startedAt: null,
        finishedAt: null,
        error: null,
        errorCode: null,
        integrationBranch: input.integrationBranch,
        worktreePath: input.worktreePath,
        branch: input.branch,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      jobs.set(id, job)
      queue.push(job)
      return job
    },
    async claimNext() {
      const job = queue.shift()
      if (!job) return null
      const claimed = { ...job, status: 'claimed' as const }
      jobs.set(claimed.id, claimed)
      return claimed
    },
    async markRunning(id) {
      const job = jobs.get(id)
      if (!job) return null
      const running = { ...job, status: 'running' as const }
      jobs.set(id, running)
      return running
    },
    async markDone(id) {
      const job = jobs.get(id)
      if (!job) return null
      const done = { ...job, status: 'done' as const }
      jobs.set(id, done)
      return done
    },
    async markFailed(id, err) {
      const job = jobs.get(id)
      if (!job) return null
      const failed = { ...job, status: 'failed' as const, error: err.message }
      jobs.set(id, failed)
      return failed
    },
    async markCanceled(id, reason) {
      const job = jobs.get(id)
      if (!job) return null
      const canceled = { ...job, status: 'canceled' as const, error: reason }
      jobs.set(id, canceled)
      return canceled
    },
    async getByTaskId(taskId) {
      const found = [...jobs.values()].filter((j: MergeJob) => j.taskId === taskId)
      return found.length > 0 ? found[found.length - 1]! : null
    },
    async listActive() {
      return [...jobs.values()].filter((j) =>
        (['queued', 'claimed', 'running'] as const).includes(
          j.status as 'queued' | 'claimed' | 'running',
        ),
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

  return store
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal MarsServices-compatible ctx for calling merge() directly. */
function makeCtx(
  taskId: string,
  worktreePath: string,
  branch: string,
  enqueueFn: (args: { taskId: string; branch: string; worktreePath: string; integrationBranch: string }) => Promise<unknown>,
) {
  return {
    runId: taskId,
    currentStep: null,
    emit: () => {},
    services: {
      store: null as never,
      traceStore: {
        record: async () => {},
        query: async () => [],
        close: async () => {},
      },
      enqueueMergeJobAndAwait: enqueueFn,
    },
    input: {
      taskId,
      kind: 'task' as const,
      integrationBranch: 'main',
    },
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('merge primitive — strict sequential execution via durable queue', () => {

  it('two concurrent merge calls execute strictly sequentially in the worker', async () => {
    /**
     * Both merge calls start at the same time. The queue ensures only one
     * mergeFn runs at a time. We record the wall-clock timestamps of each
     * mergeFn's start and end; the sequential invariant requires:
     *   start2 >= end1
     */
    const { merge } = await import('../primitives/index.js')
    const { startMergeWorker, enqueueMergeJobAndAwait: enqueueAndAwait } =
      await import('../../core/daemon/merge-worker.js')

    const store = makeFakeJobStore()
    const bus = new EventEmitter()

    // Timing records for asserting sequential execution.
    const mergeStarts: number[] = []
    const mergeEnds: number[] = []
    const MERGE_DELAY_MS = 30

    const timingMergeFn = async () => {
      mergeStarts.push(Date.now())
      await new Promise<void>((r) => setTimeout(r, MERGE_DELAY_MS))
      mergeEnds.push(Date.now())
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

    // Start the single-consumer worker with the timing mergeFn.
    const ac = new AbortController()
    const worker = startMergeWorker({
      store,
      log: () => {},
      bus,
      signal: ac.signal,
      pollIntervalMs: 5,
      mergeFn: timingMergeFn,
    })

    // The enqueueMergeJobAndAwait function wired into ctx.services.
    const enqueueFn = (args: {
      taskId: string
      branch: string
      worktreePath: string
      integrationBranch: string
    }) => enqueueAndAwait({ store, bus, ...args })

    const taskId1 = 'e2e-task-1'
    const taskId2 = 'e2e-task-2'

    const ctx1 = makeCtx(taskId1, '/fake/wt1', `task/${taskId1}`, enqueueFn)
    const ctx2 = makeCtx(taskId2, '/fake/wt2', `task/${taskId2}`, enqueueFn)

    // Both merge calls start concurrently — the queue serialises their worker
    // execution even though they arrive simultaneously.
    const [result1, result2] = await Promise.all([
      merge(ctx1 as never, { worktree: { path: '/fake/wt1', branch: `task/${taskId1}` } }),
      merge(ctx2 as never, { worktree: { path: '/fake/wt2', branch: `task/${taskId2}` } }),
    ])

    // Stop the worker.
    ac.abort()
    await worker.stop()

    // Both calls must succeed.
    expect(result1.success).toBe(true)
    expect(result2.success).toBe(true)
    expect(result1.taskId).toBe(taskId1)
    expect(result2.taskId).toBe(taskId2)

    // Sequential invariant: exactly two invocations, one after the other.
    expect(mergeStarts).toHaveLength(2)
    expect(mergeEnds).toHaveLength(2)

    // start2 must be >= end1 (the second merge didn't start before the first ended).
    // We allow a 5ms grace for scheduling jitter.
    const JITTER_MS = 5
    expect(mergeStarts[1]!).toBeGreaterThanOrEqual(mergeEnds[0]! - JITTER_MS)
  }, 10_000)
})
