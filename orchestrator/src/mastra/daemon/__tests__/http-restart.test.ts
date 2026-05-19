import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

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

describe('HTTP restart endpoint', () => {
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

  it('transitions a failed task to queued on POST /tasks/:id/restart', async () => {
    const { queue, httpServer, restartTask } = await loadModules(repo)

    const task = await queue.enqueueTask('test work', undefined, {
      skipTriage: true,
    })
    await queue.updateTask(task.id, { status: 'failed', error: 'boom' })

    const { port, close } = await httpServer.startHttpServer({
      restartTask: (id) => restartTask.coreRestartTask(id, new Set(['failed'])),
      isAcceptingWork: () => true,
    })

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/tasks/${task.id}/restart`,
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

  // ── Error cases ───────────────────────────────────────────────────────────

  it('returns 404 with NOT_FOUND for an unknown task id', async () => {
    const { httpServer, restartTask } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer({
      restartTask: (id) => restartTask.coreRestartTask(id, new Set(['failed'])),
      isAcceptingWork: () => true,
    })

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/tasks/mars-unknown/restart`,
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

    const { port, close } = await httpServer.startHttpServer({
      restartTask: (id) => restartTask.coreRestartTask(id, new Set(['failed'])),
      isAcceptingWork: () => true,
    })

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/tasks/${task.id}/restart`,
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

    const { port, close } = await httpServer.startHttpServer({
      restartTask: async () => {
        throw new Error('should not be called during drain')
      },
      isAcceptingWork: () => false,
    })

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/tasks/any-id/restart`,
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

    const { address, close } = await httpServer.startHttpServer({
      restartTask: async () => {},
      isAcceptingWork: () => true,
    })

    try {
      expect(address).toBe('127.0.0.1')
    } finally {
      await close()
    }
  })
})
