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
import { describe, expect, it } from 'vitest'
import type { MergeJob, MergeJobStore } from '../../store/merge-job-store.js'

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
      worktreePath: '/tmp/wt',
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
