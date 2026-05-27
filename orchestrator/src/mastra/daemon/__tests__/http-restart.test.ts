import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { HttpServerDeps } from '../http-server'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-restart-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

// Each test resets modules and sets MARS_REPO so module singletons
// (queue client, context cache) start fresh with the temp repo.
const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = (await import('../../queue')) as typeof import('../../queue')
  const httpServer = (await import(
    '../http-server'
  )) as typeof import('../http-server')
  const restartTask = (await import(
    '../restart-task'
  )) as typeof import('../restart-task')
  await queue.initQueue()
  return { queue, httpServer, restartTask }
}

/**
 * Build HttpServerDeps with sane no-op defaults; tests override only the verb
 * they exercise. Keeps each test focused on one route.
 */
const makeDeps = (overrides: Partial<HttpServerDeps> = {}): HttpServerDeps => ({
  restartTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }),
  restartDaemon: async () => {},
  restartAllDaemonKilled: async () => [],
  isAcceptingWork: () => true,
  ...overrides,
})

describe('HTTP action endpoint', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Tracer bullet: the happy path ─────────────────────────────────────────

  it('transitions a failed task to queued on POST /actions/restart/:id', async () => {
    const { queue, httpServer, restartTask } = await loadModules(repo)

    const task = await queue.enqueueTask('test work', undefined, {
      skipTriage: true,
    })
    await queue.updateTask(task.id, { status: 'failed', error: 'boom' })

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        restartTask: (id) => restartTask.coreRestartTask(id, new Set(['failed'])),
      }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/restart/${task.id}`,
        { method: 'POST' },
      )

      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)

      const updated = await queue.getTask(task.id)
      expect(updated?.status).toBe('queued')
    } finally {
      await close()
    }
  })

  // ── Registry endpoint ──────────────────────────────────────────────────────

  it('serves the error-kind registry on GET /error-kinds', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      const res = await fetch(`http://127.0.0.1:${port}/error-kinds`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        errorKinds: Array<{ kind: string; recoveryActions: unknown[] }>
      }
      expect(body.ok).toBe(true)
      const kinds = body.errorKinds.map((k) => k.kind)
      expect(kinds).toContain('daemon-killed')
      expect(kinds).toContain('failed-task')
      const daemonKilled = body.errorKinds.find((k) => k.kind === 'daemon-killed')
      expect(daemonKilled?.recoveryActions.length).toBeGreaterThan(0)
    } finally {
      await close()
    }
  })

  // ── Generic verb routing ────────────────────────────────────────────────────

  it('routes POST /actions/unblock/:id to the unblock handler', async () => {
    const { httpServer } = await loadModules(repo)
    let unblocked: string | null = null
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        unblockTask: async (id) => {
          unblocked = id
        },
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/actions/unblock/mars-x`, {
        method: 'POST',
      })
      expect(res.status).toBe(200)
      expect(unblocked).toBe('mars-x')
    } finally {
      await close()
    }
  })

  // ── Bulk restart ─────────────────────────────────────────────────────────

  it('restart-all-daemon-killed restarts only daemon-killed tasks and leaves ordinary failed tasks untouched', async () => {
    const { queue, httpServer, restartTask } = await loadModules(repo)

    // Seed two daemon-killed tasks and one ordinary failed task.
    const t1 = await queue.enqueueTask('daemon-killed task 1', undefined, {
      skipTriage: true,
    })
    const t2 = await queue.enqueueTask('daemon-killed task 2', undefined, {
      skipTriage: true,
    })
    const t3 = await queue.enqueueTask('ordinary failed task', undefined, {
      skipTriage: true,
    })
    await queue.updateTask(t1.id, {
      status: 'failed',
      failureSignature: 'daemon-killed',
    })
    await queue.updateTask(t2.id, {
      status: 'failed',
      failureSignature: 'daemon-killed',
    })
    await queue.updateTask(t3.id, { status: 'failed', error: 'regular failure' })

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        restartAllDaemonKilled: async () => {
          // Inline implementation matching what server.ts wires up:
          // list all failed tasks with the daemon-killed signature and restart
          // each via coreRestartTask.
          const all = await queue.listTasks('failed')
          const killed = all.filter((t) => t.failureSignature === 'daemon-killed')
          const restarted: string[] = []
          for (const task of killed) {
            await restartTask.coreRestartTask(task.id, new Set(['failed']))
            restarted.push(task.id)
          }
          return restarted
        },
      }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/restart-all-daemon-killed`,
        { method: 'POST' },
      )

      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        restarted: string[]
      }
      expect(body.ok).toBe(true)
      // Both daemon-killed tasks must be in the restarted list.
      expect(body.restarted).toContain(t1.id)
      expect(body.restarted).toContain(t2.id)
      // The ordinary failed task must NOT be in the list.
      expect(body.restarted).not.toContain(t3.id)

      // Verify DB state: daemon-killed tasks flipped to queued.
      const r1 = await queue.getTask(t1.id)
      const r2 = await queue.getTask(t2.id)
      const r3 = await queue.getTask(t3.id)
      expect(r1?.status).toBe('queued')
      expect(r2?.status).toBe('queued')
      // Ordinary failed task must remain failed and untouched.
      expect(r3?.status).toBe('failed')
    } finally {
      await close()
    }
  })

  it('returns 404 for an unknown action op', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      const res = await fetch(`http://127.0.0.1:${port}/actions/bogus/mars-x`, {
        method: 'POST',
      })
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })

  // ── Error cases ───────────────────────────────────────────────────────────

  it('returns 404 with NOT_FOUND for an unknown task id', async () => {
    const { httpServer, restartTask } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        restartTask: (id) => restartTask.coreRestartTask(id, new Set(['failed'])),
      }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/restart/mars-unknown`,
        { method: 'POST' },
      )

      expect(res.status).toBe(404)
      const body = (await res.json()) as { ok: boolean; errorCode: string }
      expect(body.ok).toBe(false)
      expect(body.errorCode).toBe('NOT_FOUND')
    } finally {
      await close()
    }
  })

  it('returns 409 with WRONG_STATUS for a task not currently in failed', async () => {
    const { queue, httpServer, restartTask } = await loadModules(repo)

    const task = await queue.enqueueTask('test work', undefined, {
      skipTriage: true,
    })
    // task is 'queued', not 'failed'

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        restartTask: (id) => restartTask.coreRestartTask(id, new Set(['failed'])),
      }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/restart/${task.id}`,
        { method: 'POST' },
      )

      expect(res.status).toBe(409)
      const body = (await res.json()) as { ok: boolean; errorCode: string }
      expect(body.ok).toBe(false)
      expect(body.errorCode).toBe('WRONG_STATUS')
    } finally {
      await close()
    }
  })

  it('returns 503 with DRAINING when not accepting work', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        restartTask: async () => {
          throw new Error('should not be called during drain')
        },
        isAcceptingWork: () => false,
      }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/restart/any-id`,
        { method: 'POST' },
      )

      expect(res.status).toBe(503)
      const body = (await res.json()) as { ok: boolean; errorCode: string }
      expect(body.ok).toBe(false)
      expect(body.errorCode).toBe('DRAINING')
    } finally {
      await close()
    }
  })

  // ── Binding ───────────────────────────────────────────────────────────────

  it('binds to 127.0.0.1 (loopback only, not 0.0.0.0)', async () => {
    const { httpServer } = await loadModules(repo)

    const { address, close } = await httpServer.startHttpServer(makeDeps())

    try {
      expect(address).toBe('127.0.0.1')
    } finally {
      await close()
    }
  })
})
