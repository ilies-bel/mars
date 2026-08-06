import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { HttpServerDeps } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-view-tasks-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = (await import('../../queue')) as typeof import('../../queue')
  const httpServer = (await import(
    '../http-server'
  )) as typeof import('../http-server')
  await queue.migrateQueueSchema()
  return { queue, httpServer }
}

let cachedRecipeCatalog: Awaited<
  ReturnType<typeof loadRecipeCatalog>
> | null = null

const ensureCatalogs = async (): Promise<void> => {
  if (!cachedRecipeCatalog) {
    cachedRecipeCatalog = await loadRecipeCatalog(
      mkdtempSync(resolve(tmpdir(), 'mars-http-vt-rec-')),
    )
  }
}

const makeDeps = (
  viewTasks: HttpServerDeps['appServices']['viewTasks'],
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
  appServices: stubAppServices({ viewTasks }),
  chatRunner: stubChatRunner(),
  ...overrides,
})

beforeAll(async () => {
  await ensureCatalogs()
})

describe('GET /view/tasks', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns seeded tasks wrapped in {tasks: [...]}', async () => {
    const { queue, httpServer } = await loadModules(repo)

    const t1 = await queue.enqueueTask('task alpha', undefined, {
      skipTriage: true,
    })
    const t2 = await queue.enqueueTask('task beta', undefined, {
      skipTriage: true,
    })

    const { port, close } = await httpServer.startHttpServer(
      makeDeps(() => queue.listTasks().then((tasks) => ({ tasks }))),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/tasks`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { tasks: Array<{ id: string }> }
      const ids = body.tasks.map((t) => t.id)
      expect(ids).toContain(t1.id)
      expect(ids).toContain(t2.id)
    } finally {
      await close()
    }
  })

  it('returns {tasks: []} when the queue is empty', async () => {
    const { queue, httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(
      makeDeps(() => queue.listTasks().then((tasks) => ({ tasks }))),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/tasks`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { tasks: unknown[] }
      expect(Array.isArray(body.tasks)).toBe(true)
      expect(body.tasks).toHaveLength(0)
    } finally {
      await close()
    }
  })

  it('surfaces a 500 when viewTasks throws', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(
      makeDeps(() => Promise.reject(new Error('store unavailable'))),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/tasks`)
      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('store unavailable')
    } finally {
      await close()
    }
  })
})
