/**
 * HTTP route test — GET /view/wywa-delta, ADR-0099 matcher breadth.
 *
 * Slice 9 of PRD 1e904a61 (weakest-valid-hypothesis induction): auto-recipe
 * activity items in the "while you were away" delta carry a `breadth` field
 * so a narrow rule acting autonomously is visible at a glance. Mirrors the
 * setup in http-wywa-delta.test.ts (real PGlite, real HTTP server) and seeds
 * a `failed` task with a matching `failure_signature` so
 * `wouldHaveFiredOnMany` has a real row to count.
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

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-wywa-breadth-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = (await import('../../queue')) as typeof import('../../queue')
  const httpServer = (await import('../http-server')) as typeof import('../http-server')
  const lr = (await import('../../lib/learned-recipes.js')) as typeof import('../../lib/learned-recipes.js')
  const chatStore = (await import('../../lib/chat-store.js')) as typeof import('../../lib/chat-store.js')
  const { resolveStateClient } = (await import('../../store/state-client.js')) as typeof import('../../store/state-client.js')

  await queue.migrateQueueSchema()
  await lr.listLearnedRecipes()
  await chatStore.initChatStore()

  return { httpServer, lr, chatStore, client: resolveStateClient() }
}

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
const getBuiltInRecipeCatalog = async () => {
  if (!cachedRecipeCatalog) {
    cachedRecipeCatalog = await loadRecipeCatalog(
      mkdtempSync(resolve(tmpdir(), 'mars-http-wywa-breadth-cat-')),
    )
  }
  return cachedRecipeCatalog
}

const makeDeps = (
  overrides: Partial<HttpServerDeps> = {},
): HttpServerDeps => ({
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

describe('GET /view/wywa-delta — ADR-0099 matcher breadth', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('carries a breadth field on auto-recipe items, counting past failures with the same signature', async () => {
    const { httpServer, lr, client } = await loadModules(repo)
    const signature = 'verify:typecheck/typecheck-type-mismatch'

    // Seed two past failures sharing the auto-recipe run's exact signature so
    // wouldHaveFiredOnMany has real breadth to report.
    const now = new Date().toISOString()
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, failure_signature, created_at, updated_at)
            VALUES (?, ?, 'failed', ?, ?, ?)`,
      args: ['task-breadth-1', 'task-breadth-1', signature, now, now],
    })
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, failure_signature, created_at, updated_at)
            VALUES (?, ?, 'failed', ?, ?, ?)`,
      args: ['task-breadth-2', 'task-breadth-2', signature, now, now],
    })

    await lr.logAutoRecipeRun({
      signature,
      actionOp: 'restart',
      taskId: 'task-xyz',
    })

    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/wywa-delta`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        events: Array<{
          kind: string
          summary: string
          breadth?: { exact: number; family: number; windowDays: number } | null
        }>
      }
      expect(body.ok).toBe(true)
      const recipe = body.events.find((e) => e.kind === 'auto-recipe')
      expect(recipe).toBeDefined()
      expect(recipe?.breadth).toBeDefined()
      expect(recipe?.breadth).not.toBeNull()
      expect(recipe?.breadth?.exact).toBeGreaterThanOrEqual(2)
      expect(recipe?.breadth?.family).toBeGreaterThanOrEqual(2)
    } finally {
      await close()
    }
  })

  it('leaves other event kinds without a breadth field', async () => {
    const { httpServer } = await loadModules(repo)
    const mergeEntry = {
      originId: 'arc-001',
      title: 'Add login flow',
      landedAt: '2026-07-20T10:00:00.000Z',
      detail: { prompt: 'Implement login', spec: null, recoveryCount: 0 },
    }
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        appServices: stubAppServices({
          viewReleaseNotes: async () => ({ entries: [mergeEntry] }),
        }),
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/wywa-delta`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        events: Array<{ kind: string; breadth?: unknown }>
      }
      const merge = body.events.find((e) => e.kind === 'merge')
      expect(merge).toBeDefined()
      expect(merge?.breadth).toBeUndefined()
    } finally {
      await close()
    }
  })
})
