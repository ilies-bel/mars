/**
 * HTTP endpoint tests for the new task action verbs: `drop` and `set-blockers`.
 *
 * Pattern mirrors http-restart.test.ts: each test spins up a real HTTP
 * server backed by a temp git repo and an in-memory SQLite queue, then
 * exercises the route via `fetch`. Tests stub only the dep they are exercising
 * so each case stays focused on one route.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { HttpServerDeps } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-task-actions-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
const getBuiltInRecipeCatalog = async () => {
  if (!cachedRecipeCatalog) {
    cachedRecipeCatalog = await loadRecipeCatalog(
      mkdtempSync(resolve(tmpdir(), 'mars-task-actions-rec-')),
    )
  }
  return cachedRecipeCatalog
}

const makeDeps = (overrides: Partial<HttpServerDeps> = {}): HttpServerDeps => ({
  restartTask: async () => {},
  continueTask: async () => {},
  remergeTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  dismissProposal: async () => {},
  promoteProposal: async () => ({ taskIds: [] }),
  validateTask: async () => {},
  rejectTask: async () => {},
  landWork: async () => {},
  investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }),
  restartDaemon: async () => {},
  continueAllDaemonKilled: async () => ({ continued: [], degraded: [], skipped: [] }),
  isAcceptingWork: () => true,
  inFlightCount: () => 0,
  selfUpdate: async () => {},
  runReflect: async () => ({ proposalsRaised: 0 }),
  stepDone: async () => ({ next: null as string | null }),
  snoozeItem: async () => {},
  recipeCatalog: cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: nullTraceStore,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  ...overrides,
})

beforeAll(async () => {
  await getBuiltInRecipeCatalog()
})

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('task action verbs — drop and set-blockers', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  const loadModules = async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const queue = (await import('../../queue')) as typeof import('../../queue')
    const httpServer = (await import('../http-server')) as typeof import('../http-server')
    await queue.migrateQueueSchema()
    return { queue, httpServer }
  }

  // ── POST /actions/drop/:id ────────────────────────────────────────────────

  describe('POST /actions/drop/:id', () => {
    it('calls dropTask and returns 200 when the dep is wired', async () => {
      const { queue, httpServer } = await loadModules()
      const task = await queue.enqueueTask('drop me', undefined, { skipTriage: true })

      let droppedId: string | undefined
      const { port, close } = await httpServer.startHttpServer(
        makeDeps({
          dropTask: async (id) => {
            droppedId = id
          },
        }),
      )
      try {
        const r = await fetch(`http://127.0.0.1:${port}/actions/drop/${task.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        expect(r.status).toBe(200)
        const body = await r.json() as { ok: boolean }
        expect(body.ok).toBe(true)
        expect(droppedId).toBe(task.id)
      } finally {
        close()
      }
    })

    it('returns 501 when dropTask dep is absent', async () => {
      const { queue, httpServer } = await loadModules()
      const task = await queue.enqueueTask('no-drop-dep', undefined, { skipTriage: true })

      const { port, close } = await httpServer.startHttpServer(makeDeps())
      try {
        const r = await fetch(`http://127.0.0.1:${port}/actions/drop/${task.id}`, {
          method: 'POST',
          body: '{}',
        })
        expect(r.status).toBe(501)
      } finally {
        close()
      }
    })

    it('passes force=true from request body to dropTask', async () => {
      const { queue, httpServer } = await loadModules()
      const task = await queue.enqueueTask('force-drop', undefined, { skipTriage: true })

      let capturedForce: boolean | undefined
      const { port, close } = await httpServer.startHttpServer(
        makeDeps({
          dropTask: async (_id, force) => {
            capturedForce = force
          },
        }),
      )
      try {
        const r = await fetch(`http://127.0.0.1:${port}/actions/drop/${task.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true }),
        })
        expect(r.status).toBe(200)
        expect(capturedForce).toBe(true)
      } finally {
        close()
      }
    })

    it('defaults force to false when body omits it', async () => {
      const { queue, httpServer } = await loadModules()
      const task = await queue.enqueueTask('default-force', undefined, { skipTriage: true })

      let capturedForce: boolean | undefined
      const { port, close } = await httpServer.startHttpServer(
        makeDeps({
          dropTask: async (_id, force) => {
            capturedForce = force
          },
        }),
      )
      try {
        await fetch(`http://127.0.0.1:${port}/actions/drop/${task.id}`, {
          method: 'POST',
          body: '{}',
        })
        expect(capturedForce).toBe(false)
      } finally {
        close()
      }
    })

    it('returns 409 when dropTask rejects with "is in flight"', async () => {
      const { queue, httpServer } = await loadModules()
      const task = await queue.enqueueTask('in-flight', undefined, { skipTriage: true })

      const { port, close } = await httpServer.startHttpServer(
        makeDeps({
          dropTask: async () => {
            throw new Error(
              `task ${task.id} is in flight (status=running); pass force=true to drop anyway`,
            )
          },
        }),
      )
      try {
        const r = await fetch(`http://127.0.0.1:${port}/actions/drop/${task.id}`, {
          method: 'POST',
          body: '{}',
        })
        expect(r.status).toBe(409)
        const body = await r.json() as { ok: boolean; error: string }
        expect(body.ok).toBe(false)
        expect(body.error).toContain('is in flight')
      } finally {
        close()
      }
    })

    it('returns 409 when dropTask rejects with "refusing to drop"', async () => {
      const { queue, httpServer } = await loadModules()
      const task = await queue.enqueueTask('commits-ahead', undefined, { skipTriage: true })

      const { port, close } = await httpServer.startHttpServer(
        makeDeps({
          dropTask: async () => {
            throw new Error(
              `refusing to drop task ${task.id}: branch task/${task.id} has 3 commit(s) ahead of main`,
            )
          },
        }),
      )
      try {
        const r = await fetch(`http://127.0.0.1:${port}/actions/drop/${task.id}`, {
          method: 'POST',
          body: '{}',
        })
        expect(r.status).toBe(409)
        const body = await r.json() as { ok: boolean; error: string }
        expect(body.error).toContain('refusing to drop')
      } finally {
        close()
      }
    })
  })

  // ── POST /actions/set-blockers/:id ────────────────────────────────────────

  describe('POST /actions/set-blockers/:id', () => {
    it('calls setBlockers with parsed add/remove arrays and returns 200', async () => {
      const { queue, httpServer } = await loadModules()
      const task = await queue.enqueueTask('set-blocker-target', undefined, { skipTriage: true })

      let capturedArgs:
        | { id: string; add: readonly string[]; remove: readonly string[] }
        | undefined
      const { port, close } = await httpServer.startHttpServer(
        makeDeps({
          setBlockers: async (id, add, remove) => {
            capturedArgs = { id, add, remove }
            return { added: add, removed: remove }
          },
        }),
      )
      try {
        const r = await fetch(
          `http://127.0.0.1:${port}/actions/set-blockers/${task.id}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ add: ['blocker-1'], remove: ['blocker-2'] }),
          },
        )
        expect(r.status).toBe(200)
        const body = await r.json() as { ok: boolean; added: string[]; removed: string[] }
        expect(body.ok).toBe(true)
        expect(body.added).toEqual(['blocker-1'])
        expect(body.removed).toEqual(['blocker-2'])
        expect(capturedArgs?.id).toBe(task.id)
        expect(capturedArgs?.add).toEqual(['blocker-1'])
        expect(capturedArgs?.remove).toEqual(['blocker-2'])
      } finally {
        close()
      }
    })

    it('returns 501 when setBlockers dep is absent', async () => {
      const { queue, httpServer } = await loadModules()
      const task = await queue.enqueueTask('no-sb-dep', undefined, { skipTriage: true })

      const { port, close } = await httpServer.startHttpServer(makeDeps())
      try {
        const r = await fetch(
          `http://127.0.0.1:${port}/actions/set-blockers/${task.id}`,
          {
            method: 'POST',
            body: JSON.stringify({ add: ['x'] }),
          },
        )
        expect(r.status).toBe(501)
      } finally {
        close()
      }
    })

    it('returns 409 when setBlockers rejects with "cannot block itself"', async () => {
      const { queue, httpServer } = await loadModules()
      const task = await queue.enqueueTask('self-block', undefined, { skipTriage: true })

      const { port, close } = await httpServer.startHttpServer(
        makeDeps({
          setBlockers: async () => {
            throw new Error(`task ${task.id} cannot block itself`)
          },
        }),
      )
      try {
        const r = await fetch(
          `http://127.0.0.1:${port}/actions/set-blockers/${task.id}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ add: [task.id] }),
          },
        )
        expect(r.status).toBe(409)
        const body = await r.json() as { ok: boolean; error: string }
        expect(body.error).toContain('cannot block itself')
      } finally {
        close()
      }
    })

    it('returns 400 for invalid JSON body', async () => {
      const { queue, httpServer } = await loadModules()
      const task = await queue.enqueueTask('bad-json', undefined, { skipTriage: true })

      const { port, close } = await httpServer.startHttpServer(
        makeDeps({
          setBlockers: async (_id, add, remove) => ({ added: add, removed: remove }),
        }),
      )
      try {
        const r = await fetch(
          `http://127.0.0.1:${port}/actions/set-blockers/${task.id}`,
          { method: 'POST', body: 'not-json' },
        )
        expect(r.status).toBe(400)
      } finally {
        close()
      }
    })

    it('handles empty add/remove arrays gracefully', async () => {
      const { queue, httpServer } = await loadModules()
      const task = await queue.enqueueTask('empty-arrays', undefined, { skipTriage: true })

      let capturedArgs:
        | { add: readonly string[]; remove: readonly string[] }
        | undefined
      const { port, close } = await httpServer.startHttpServer(
        makeDeps({
          setBlockers: async (_id, add, remove) => {
            capturedArgs = { add, remove }
            return { added: [], removed: [] }
          },
        }),
      )
      try {
        const r = await fetch(
          `http://127.0.0.1:${port}/actions/set-blockers/${task.id}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          },
        )
        expect(r.status).toBe(200)
        expect(capturedArgs?.add).toEqual([])
        expect(capturedArgs?.remove).toEqual([])
      } finally {
        close()
      }
    })
  })
})
