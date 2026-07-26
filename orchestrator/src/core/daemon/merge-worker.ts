/**
 * Durable single-consumer merge worker (PRD 92af89ce, slice 2).
 *
 * `startMergeWorker` starts a loop that:
 *   1. Calls `store.claimNext()` to atomically claim the oldest queued job.
 *   2. If no job is available, waits for a `merge-job.enqueued` bus event or
 *      500 ms, then retries.
 *   3. If a job is claimed: calls `markRunning`, invokes `runMergeJob` (a
 *      placeholder in this slice), then repeats.
 *
 * Concurrency is strictly one: a single `inFlight: Promise<void> | null`
 * variable tracks the active job. The loop `await`s it before picking the
 * next job, so even if many `merge-job.enqueued` events fire simultaneously
 * only one job is ever in flight. The in-process guard exists alongside the
 * DB `FOR UPDATE SKIP LOCKED` claim so correctness does not rely solely on
 * the DB index.
 *
 * Gated behind `MARS_MERGE_QUEUE=1` in `server.ts` — off by default.
 */

import type { EventEmitter } from 'node:events'
import { getTask } from '../queue.js'
import type { MergeJob, MergeJobStore } from '../store/merge-job-store.js'

// ── Public types ──────────────────────────────────────────────────────────────

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
}

export interface MergeWorkerHandle {
  stop(): Promise<void>
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Placeholder merge execution. In a future slice this will perform the real
 * git merge. For now it fetches the task row (to confirm the job is
 * grounded in a real task) then marks the job done.
 */
async function runMergeJob(job: MergeJob, store: MergeJobStore, log: (msg: string) => void): Promise<void> {
  const task = await getTask(job.taskId)
  log(`[merge-worker] executing job ${job.id} for task ${job.taskId} (task status=${task?.status ?? 'not found'})`)
  await store.markDone(job.id)
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
 * @param deps.store  - The merge-job store (injected; testable via a fake).
 * @param deps.log    - Logger function.
 * @param deps.bus    - The daemon event bus (EventEmitter).
 * @param deps.signal - AbortSignal that stops the worker (e.g. daemon shutdown).
 *
 * @returns A handle with a `stop()` method that signals the loop to exit
 *          and waits for any in-flight job to finish.
 */
export function startMergeWorker({ store, log, bus, signal, pollIntervalMs = 500 }: MergeWorkerDeps): MergeWorkerHandle {
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

      // Process the job. Set inFlight BEFORE awaiting so the guard is always
      // accurate from the perspective of any concurrent inspect.
      let resolveInFlight!: () => void
      inFlight = new Promise<void>((res) => { resolveInFlight = res })

      try {
        await store.markRunning(job.id)
        await runMergeJob(job, store, log)
      } catch (err) {
        log(`[merge-worker] job ${job.id} failed: ${(err as Error).message}`)
        await store.markFailed(job.id, { message: (err as Error).message }).catch(() => {
          // best-effort: if markFailed itself fails, the job will be cleaned up
          // by the startup reconcile on next daemon boot.
        })
      } finally {
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
  }
}
