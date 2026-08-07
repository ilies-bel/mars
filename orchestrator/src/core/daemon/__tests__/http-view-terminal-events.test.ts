import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { HttpServerDeps } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import type { TerminalEvent, TaskStoreForEvents } from '../view/terminal-events'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-term-events-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const httpServer = (await import(
    '../http-server'
  )) as typeof import('../http-server')
  const view = (await import(
    '../view/terminal-events'
  )) as typeof import('../view/terminal-events')
  return { httpServer, listTerminalEvents: view.listTerminalEvents }
}

let cachedRecipeCatalog: Awaited<
  ReturnType<typeof loadRecipeCatalog>
> | null = null

const ensureCatalogs = async (): Promise<void> => {
  if (!cachedRecipeCatalog) {
    cachedRecipeCatalog = await loadRecipeCatalog(
      mkdtempSync(resolve(tmpdir(), 'mars-http-te-rec-')),
    )
  }
}

const makeDeps = (
  viewTerminalEvents: HttpServerDeps['appServices']['viewTerminalEvents'],
  overrides: Partial<HttpServerDeps> = {},
): HttpServerDeps => ({
  restartTask: async () => {},
  remergeTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  dismissProposal: async () => {},
  promoteProposal: async () => {},
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
  enableAutoReflect: async () => {},
  stepDone: async () => ({ next: null as string | null }),
  snoozeItem: async () => {},
  recipeCatalog: cachedRecipeCatalog!,
  traceStore: nullTraceStore,
  appServices: stubAppServices({ viewTerminalEvents }),
  chatRunner: stubChatRunner(),
  ...overrides,
})

type TaskRow = Awaited<ReturnType<TaskStoreForEvents['listTasks']>>[number]

/** Build a dep closure that drives listTerminalEvents with the given tasks. */
const makeStoreDep =
  (
    listTerminalEvents: typeof import('../view/terminal-events')['listTerminalEvents'],
    tasks: TaskRow[],
  ): HttpServerDeps['appServices']['viewTerminalEvents'] =>
  () =>
    listTerminalEvents({ listTasks: async () => tasks }).then((events) => ({
      events,
    }))

beforeAll(async () => {
  await ensureCatalogs()
})

describe('GET /view/terminal-events', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns {events: []} when there are no terminal tasks', async () => {
    const { httpServer, listTerminalEvents } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(
      makeDeps(makeStoreDep(listTerminalEvents, [])),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/terminal-events`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { events: TerminalEvent[] }
      expect(Array.isArray(body.events)).toBe(true)
      expect(body.events).toHaveLength(0)
    } finally {
      await close()
    }
  })

  it("emits exactly one 'completed' event for a task that finished as done", async () => {
    const { httpServer, listTerminalEvents } = await loadModules(repo)

    const tasks = [
      {
        id: 'task-done-1',
        prompt: 'ship the thing',
        status: 'done',
        recoverySpawnedCount: 0,
        updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]

    const { port, close } = await httpServer.startHttpServer(
      makeDeps(makeStoreDep(listTerminalEvents, tasks)),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/terminal-events`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { events: TerminalEvent[] }
      expect(body.events).toHaveLength(1)
      const ev = body.events[0]!
      expect(ev.taskId).toBe('task-done-1')
      expect(ev.kind).toBe('completed')
      expect(ev.occurredAt).toBe('2026-05-15T10:00:00.000Z')
      expect(ev.recoverySpawnedCount).toBe(0)
      expect(typeof ev.summary).toBe('string')
      expect(ev.summary.length).toBeGreaterThan(0)
    } finally {
      await close()
    }
  })

  it('only emits the three terminal kinds (completed | failed | dropped)', async () => {
    const { httpServer, listTerminalEvents } = await loadModules(repo)

    const now = '2026-05-15T10:00:00.000Z'
    const tasks = [
      { id: 't-queued', prompt: 'q', status: 'queued', recoverySpawnedCount: 0, updatedAt: now },
      { id: 't-running', prompt: 'r', status: 'running', recoverySpawnedCount: 0, updatedAt: now },
      { id: 't-blocked', prompt: 'b', status: 'blocked', recoverySpawnedCount: 0, updatedAt: now },
      { id: 't-verifying', prompt: 'v', status: 'verifying', recoverySpawnedCount: 0, updatedAt: now },
      { id: 't-done', prompt: 'd', status: 'done', recoverySpawnedCount: 0, updatedAt: now },
      { id: 't-failed', prompt: 'f', status: 'failed', recoverySpawnedCount: 0, updatedAt: now },
      { id: 't-dropped', prompt: 'dr', status: 'dropped', recoverySpawnedCount: 1, updatedAt: now },
    ]

    const { port, close } = await httpServer.startHttpServer(
      makeDeps(makeStoreDep(listTerminalEvents, tasks)),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/terminal-events`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { events: TerminalEvent[] }
      const kinds = new Set(body.events.map((e) => e.kind))
      for (const k of kinds) {
        expect(['completed', 'failed', 'dropped']).toContain(k)
      }
      // Non-terminal statuses contribute zero events.
      const sourceIds = body.events.map((e) => e.taskId)
      expect(sourceIds).not.toContain('t-queued')
      expect(sourceIds).not.toContain('t-running')
      expect(sourceIds).not.toContain('t-blocked')
      expect(sourceIds).not.toContain('t-verifying')
    } finally {
      await close()
    }
  })

  it("emits two 'failed' entries plus one 'dropped' entry for a task that failed twice and was dropped", async () => {
    const { httpServer, listTerminalEvents } = await loadModules(repo)

    const tasks = [
      {
        id: 'task-drop',
        prompt: 'deploy thing',
        status: 'dropped',
        recoverySpawnedCount: 2,
        updatedAt: '2026-05-15T12:00:00.000Z',
      },
    ]

    const { port, close } = await httpServer.startHttpServer(
      makeDeps(makeStoreDep(listTerminalEvents, tasks)),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/terminal-events`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { events: TerminalEvent[] }
      const forTask = body.events.filter((e) => e.taskId === 'task-drop')
      const failed = forTask.filter((e) => e.kind === 'failed')
      const dropped = forTask.filter((e) => e.kind === 'dropped')
      expect(failed).toHaveLength(2)
      expect(dropped).toHaveLength(1)
      expect(forTask).toHaveLength(3)
    } finally {
      await close()
    }
  })

  it("emits one 'failed' entry for a task currently in status='failed' with no retries yet", async () => {
    const { httpServer, listTerminalEvents } = await loadModules(repo)

    const tasks = [
      {
        id: 'task-fail',
        prompt: 'do stuff',
        status: 'failed',
        recoverySpawnedCount: 0,
        updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]

    const { port, close } = await httpServer.startHttpServer(
      makeDeps(makeStoreDep(listTerminalEvents, tasks)),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/terminal-events`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { events: TerminalEvent[] }
      const forTask = body.events.filter((e) => e.taskId === 'task-fail')
      expect(forTask).toHaveLength(1)
      expect(forTask[0]!.kind).toBe('failed')
    } finally {
      await close()
    }
  })

  it('returns events sorted newest-first by occurredAt', async () => {
    const { httpServer, listTerminalEvents } = await loadModules(repo)

    // Tasks supplied in non-chronological order; listTerminalEvents must sort them.
    const tasks = [
      { id: 'older', prompt: 'old task', status: 'done', recoverySpawnedCount: 0, updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'newest', prompt: 'new task', status: 'done', recoverySpawnedCount: 0, updatedAt: '2026-05-15T12:00:00.000Z' },
      { id: 'middle', prompt: 'mid task', status: 'done', recoverySpawnedCount: 0, updatedAt: '2026-03-01T00:00:00.000Z' },
    ]

    const { port, close } = await httpServer.startHttpServer(
      makeDeps(makeStoreDep(listTerminalEvents, tasks)),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/terminal-events`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { events: TerminalEvent[] }
      const ids = body.events.map((e) => e.taskId)
      expect(ids).toEqual(['newest', 'middle', 'older'])
      // Timestamps are monotonically non-increasing.
      for (let i = 1; i < body.events.length; i++) {
        expect(body.events[i - 1]!.occurredAt >= body.events[i]!.occurredAt).toBe(
          true,
        )
      }
    } finally {
      await close()
    }
  })

  it('caps the response at 200 entries', async () => {
    const { httpServer, listTerminalEvents } = await loadModules(repo)

    // 250 done tasks → 250 candidate events; listTerminalEvents must trim to 200.
    const tasks = Array.from({ length: 250 }, (_, i) => ({
      id: `t-${String(i).padStart(3, '0')}`,
      prompt: `task ${i}`,
      status: 'done',
      recoverySpawnedCount: 0,
      updatedAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T${String(
        i % 24,
      ).padStart(2, '0')}:00:00.${String(i).padStart(3, '0')}Z`,
    }))

    const { port, close } = await httpServer.startHttpServer(
      makeDeps(makeStoreDep(listTerminalEvents, tasks)),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/terminal-events`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { events: TerminalEvent[] }
      expect(body.events.length).toBe(200)
    } finally {
      await close()
    }
  })

  it('surfaces a 500 when viewTerminalEvents throws', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(
      makeDeps(() => Promise.reject(new Error('store unavailable'))),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/terminal-events`)
      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('store unavailable')
    } finally {
      await close()
    }
  })
})
