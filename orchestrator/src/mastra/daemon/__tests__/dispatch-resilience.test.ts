/**
 * Crash-resilience for the dispatch loop.
 *
 * Regression guard: when a single queued task was dispatched and its workflow
 * run threw an unhandled error, the WHOLE daemon process used to crash and
 * exit. The CLI then auto-respawned it, it re-dispatched the same task,
 * re-crashed — a crash-respawn loop. A single bad task must NEVER take down
 * the daemon; it must fail only that task and the loop must survive.
 *
 * These tests drive the REAL `startDaemon` dispatch path (the dispatchImplement
 * closure is private, so we exercise it end-to-end through the daemon) with the
 * implement workflow mocked to throw. We assert:
 *
 *   (a) the offending task is marked `failed` (the catch ran + persisted),
 *   (b) NO unhandledRejection / uncaughtException escapes the dispatch — i.e.
 *       dispatchImplement RESOLVES rather than propagating the throw,
 *   (c) the daemon stays alive: inFlight returns to 0 (semaphore + tracking
 *       released) and a SECOND queued task is still dispatched and failed,
 *       proving drain() re-armed the loop.
 *
 * DuckDB is disabled (MARS_DISABLE_DUCKDB=1) so the test does not contend on
 * the observability store. process.exit is stubbed so the daemon's shutdown
 * (which calls process.exit(0)) cannot tear down the vitest runner.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

// Mock the composition root so the implement workflow's run.start() rejects.
// createRun() must succeed (the daemon calls getDefaultTaskStore() between
// createRun and start); only start() throws — mirroring "the workflow run
// throws an unhandled error". Triage is also pushed through getWorkflow for
// other workflows, but this test only enqueues implement work.
const RUN_START_ERROR = 'simulated workflow explosion'
vi.mock('../../index', () => ({
  mastra: {
    getWorkflow: (_name: string) => ({
      createRun: async () => ({
        start: async () => {
          throw new Error(RUN_START_ERROR)
        },
      }),
    }),
  },
}))

// Force the implement-workflow module's dynamic import to reject. The dispatch
// catch loads this module to consult isBlockersAbortError; in the unhardened
// code that `await import(...)` sat un-guarded inside the catch, so a rejecting
// import escaped the catch entirely and crashed the daemon. Mocking the module
// to throw on load reproduces that exact escape route and proves the guard.
const IMPORT_ERROR = 'simulated detector-module load failure'
vi.mock('../../workflows/implement-workflow', () => {
  throw new Error(IMPORT_ERROR)
})

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  initQueue: typeof import('../../queue').initQueue
}

interface ServerModule {
  startDaemon: typeof import('../server').startDaemon
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-dispatch-resilience-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/** Poll a predicate until it holds or the deadline passes. */
const waitFor = async (
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return predicate()
}

describe('dispatch crash-resilience: a throwing workflow run fails only its task', () => {
  let repo: string
  let exitSpy: MockInstance<(code?: string | number | null) => never>
  let rejections: unknown[]
  let exceptions: unknown[]
  const onRejection = (reason: unknown): void => {
    rejections.push(reason)
  }
  const onException = (err: unknown): void => {
    exceptions.push(err)
  }

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    process.env.MARS_DISABLE_DUCKDB = '1'
    // Speed up the poll-fallback so a missed bus emit re-arms quickly if ever
    // needed; the test relies on the dispatcher finally-block's drain() but a
    // tight fallback keeps the suite snappy.
    process.env.MARS_DRAIN_POLL_MS = '200'
    rejections = []
    exceptions = []
    process.on('unhandledRejection', onRejection)
    process.on('uncaughtException', onException)
    // The daemon calls process.exit(0) in shutdown; stub it so cleanup can
    // drive shutdown without killing the vitest process. The implementation
    // never actually returns at runtime in production, but the test stub
    // simply no-ops; the `as never` return matches process.exit's signature.
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((_code?: string | number | null): never => {
        return undefined as never
      })
  })

  afterEach(() => {
    process.off('unhandledRejection', onRejection)
    process.off('uncaughtException', onException)
    exitSpy.mockRestore()
    delete process.env.MARS_REPO
    delete process.env.MARS_DISABLE_DUCKDB
    delete process.env.MARS_DRAIN_POLL_MS
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('fails the task, does not crash the daemon, and keeps draining', async () => {
    vi.resetModules()
    const q = (await import('../../queue')) as unknown as QueueModule
    await q.initQueue()

    // Two queued tasks: the first proves the failure path; the second proves
    // the loop survived and still dispatches (drain re-armed after the throw).
    const t1 = await q.enqueueTask('explode 1', undefined, { skipTriage: true })
    const t2 = await q.enqueueTask('explode 2', undefined, { skipTriage: true })
    expect(t1.status).toBe('queued')
    expect(t2.status).toBe('queued')

    const server = (await import('../server')) as unknown as ServerModule
    const handle = await server.startDaemon({ log: () => {} })

    try {
      // (a) Both tasks must end up failed with the simulated error. reconcile()
      // re-queues them at boot and drain() dispatches each; every run rejects.
      const bothFailed = await waitFor(async () => {
        const r1 = await q.getTask(t1.id)
        const r2 = await q.getTask(t2.id)
        return r1?.status === 'failed' && r2?.status === 'failed'
      })
      expect(bothFailed).toBe(true)

      const r1 = await q.getTask(t1.id)
      const r2 = await q.getTask(t2.id)
      expect(r1?.status).toBe('failed')
      expect(r2?.status).toBe('failed')
      // The stored error is the message thrown by run.start() — proof the
      // dispatch catch handled the real workflow throw, not some unrelated
      // failure.
      expect(r1?.error).toContain(RUN_START_ERROR)
      expect(r2?.error).toContain(RUN_START_ERROR)

      // (c) The semaphore + inFlight tracking must be released after each
      // dispatch resolves — otherwise the loop would wedge with a leaked slot.
      const drained = await waitFor(async () => handle.inFlightCount() === 0)
      expect(drained).toBe(true)
      expect(handle.inFlightCount()).toBe(0)

      // (b) The crux: no unhandledRejection / uncaughtException escaped the
      // dispatch. If dispatchImplement re-threw instead of resolving, the
      // fire-and-forget `void dispatchImplement(t)` would surface here and
      // (in production) crash the process.
      expect(rejections).toEqual([])
      expect(exceptions).toEqual([])
    } finally {
      await handle.stop(true)
    }
  })
})
