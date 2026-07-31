/**
 * HTTP route tests — GET /view/wywa-delta.
 *
 * Verifies the unified "while you were away" delta route assembles from:
 *   1. Merged arcs (via stubbed appServices.viewReleaseNotes)
 *   2. Failed-and-recovered tasks (via real TraceEventStore, recovery_spawned)
 *   3. Auto-recipe runs (via real learned-recipes PGlite store)
 *   4. Throttled chat threads (via real chat-store PGlite)
 *   5. Evaporated chat threads (via real chat-store PGlite)
 *
 * Pattern mirrors http-learned-recipes.test.ts: vi.resetModules() resets PGlite
 * singletons between tests; each test loads fresh module instances, seeds data,
 * then drives a real HTTP server with a real fetch().
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { HttpServerDeps } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import {
  openTraceEventStore,
  type TraceEventStore,
} from '../../lib/trace-events-store'
import { nullTraceStore } from '../../lib/run-tool'

// ── Helpers ───────────────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-wywa-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * Reset module singletons, apply the full DB schema, and pre-warm PGlite so
 * route handlers never race against DB initialisation on the first request.
 */
const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = (await import('../../queue')) as typeof import('../../queue')
  const httpServer = (await import('../http-server')) as typeof import('../http-server')
  const lr = (await import('../../lib/learned-recipes.js')) as typeof import('../../lib/learned-recipes.js')
  const chatStore = (await import('../../lib/chat-store.js')) as typeof import('../../lib/chat-store.js')

  await queue.migrateQueueSchema()
  // Pre-warm PGlite tables that route handlers reach via dynamic import.
  await lr.listLearnedRecipes()
  await chatStore.initChatStore()

  return { httpServer, lr, chatStore }
}

// ── Recipe catalog (needed by makeDeps) ──────────────────────────────────────

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
const getBuiltInRecipeCatalog = async () => {
  if (!cachedRecipeCatalog) {
    cachedRecipeCatalog = await loadRecipeCatalog(
      mkdtempSync(resolve(tmpdir(), 'mars-http-wywa-cat-')),
    )
  }
  return cachedRecipeCatalog
}

const makeDeps = (
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
  restartAllDaemonKilled: async () => [],
  isAcceptingWork: () => true,
  inFlightCount: () => 0,
  selfUpdate: async () => {},
  runReflect: async () => ({ proposalsRaised: 0 }),
  enableAutoReflect: async () => {},
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

// ── Basic shape ───────────────────────────────────────────────────────────────

describe('GET /view/wywa-delta — basic shape', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns ok:true with an empty events array when there is no activity', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/wywa-delta`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; events: unknown[]; andMore: number }
      expect(body.ok).toBe(true)
      expect(Array.isArray(body.events)).toBe(true)
      expect(body.andMore).toBe(0)
    } finally {
      await close()
    }
  })

  it('surfaces merged arcs from viewReleaseNotes', async () => {
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
      const body = (await res.json()) as { ok: boolean; events: Array<{ kind: string; summary: string; at: string }> }
      expect(body.ok).toBe(true)
      const merge = body.events.find((e) => e.kind === 'merge')
      expect(merge).toBeDefined()
      expect(merge?.summary).toBe('Merged: Add login flow')
      expect(merge?.at).toBe('2026-07-20T10:00:00.000Z')
    } finally {
      await close()
    }
  })
})

// ── recovery_spawned events ───────────────────────────────────────────────────

describe('GET /view/wywa-delta — recovery events', () => {
  let repo: string
  let dbDir: string
  let traceStore: TraceEventStore

  beforeEach(async () => {
    repo = setupRepo()
    dbDir = mkdtempSync(resolve(tmpdir(), 'mars-http-wywa-db-'))
    mkdirSync(dbDir, { recursive: true })
    traceStore = await openTraceEventStore(join(dbDir, 'mars.db'))
  })

  afterEach(async () => {
    await traceStore.close()
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('surfaces recovery_spawned trace events as failure-recovered items', async () => {
    await traceStore.record({
      kind: 'recovery_spawned',
      taskId: 'fix-task-1',
      originId: 'arc-abc',
    })
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ traceStore }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/wywa-delta`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; events: Array<{ kind: string; summary: string }> }
      const recovery = body.events.find((e) => e.kind === 'failure-recovered')
      expect(recovery).toBeDefined()
      expect(recovery?.summary).toContain('arc-abc')
      expect(recovery?.summary).toContain('recovered')
    } finally {
      await close()
    }
  })

  it('filters recovery events by since — only newer events are returned', async () => {
    // Record two events with distinct timestamps via the store (no direct SQL needed —
    // the store auto-stamps; we rely on them both being recent and then use a far-future
    // since to filter them both out).
    await traceStore.record({ kind: 'recovery_spawned', taskId: 'fix-old', originId: 'old-arc' })
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ traceStore }),
    )
    try {
      // since=far future → no recovery events survive
      const res = await fetch(
        `http://127.0.0.1:${port}/view/wywa-delta?since=2099-01-01T00:00:00.000Z`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { events: Array<{ kind: string }> }
      const recoveries = body.events.filter((e) => e.kind === 'failure-recovered')
      expect(recoveries).toHaveLength(0)
    } finally {
      await close()
    }
  })
})

// ── auto-recipe runs ──────────────────────────────────────────────────────────

describe('GET /view/wywa-delta — auto-recipe runs', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('surfaces auto-recipe run log entries as auto-recipe items', async () => {
    const { httpServer, lr } = await loadModules(repo)
    await lr.logAutoRecipeRun({
      signature: 'verify:typecheck/type-mismatch',
      actionOp: 'restart',
      taskId: 'task-xyz',
    })
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/wywa-delta`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { events: Array<{ kind: string; summary: string }> }
      const recipe = body.events.find((e) => e.kind === 'auto-recipe')
      expect(recipe).toBeDefined()
      expect(recipe?.summary).toContain('Auto-restart')
      expect(recipe?.summary).toContain('task-xyz')
    } finally {
      await close()
    }
  })
})

// ── throttled and evaporated threads ─────────────────────────────────────────

describe('GET /view/wywa-delta — chat thread events', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('surfaces throttled threads as throttle items', async () => {
    const { httpServer, chatStore } = await loadModules(repo)
    const thread = await chatStore.createThread('throttled-thread')
    await chatStore.setThreadStatus(thread.id, 'throttled')
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/wywa-delta`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { events: Array<{ kind: string; summary: string }> }
      const throttle = body.events.find((e) => e.kind === 'throttle')
      expect(throttle).toBeDefined()
      expect(throttle?.summary).toContain(thread.id)
    } finally {
      await close()
    }
  })

  it('surfaces evaporated threads as evaporated-thread items', async () => {
    const { httpServer, chatStore } = await loadModules(repo)
    const thread = await chatStore.createThread('idle-thread')
    await chatStore.markThreadEvaporated(thread.id)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/wywa-delta`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { events: Array<{ kind: string; summary: string }> }
      const evap = body.events.find((e) => e.kind === 'evaporated-thread')
      expect(evap).toBeDefined()
      expect(evap?.summary).toContain(thread.id)
    } finally {
      await close()
    }
  })
})

// Note: limit + andMore cap behaviour is verified at the pure-function level in
// orchestrator/src/core/daemon/view/wywa-delta.test.ts (assembleDelta unit tests)
// without requiring PGlite initialisation or an HTTP round-trip.

// ── Steward ledger ───────────────────────────────────────────────────────────

describe('GET /view/steward-ledger', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns newest-first evidence scoped to one target', async () => {
    const { httpServer } = await loadModules(repo)
    const ledger = await import('../../steward-ledger.js')
    await ledger.recordStewardIntervention({
      targetKind: 'task',
      targetId: 'task-7',
      targetVersion: 'verify:v1',
      recipeId: 'repair-verify',
      rationale: 'The first failure needed repair.',
      outcome: 'recovered',
      ts: '2026-07-01T09:00:00.000Z',
    })
    await ledger.recordStewardIntervention({
      targetKind: 'task',
      targetId: 'task-7',
      targetVersion: 'verify:v2',
      recipeId: 'repair-verify',
      rationale: 'The latest failure needed repair.',
      outcome: 'merged',
      commitSha: 'abc123',
      ts: '2026-07-02T09:00:00.000Z',
    })
    await ledger.recordStewardIntervention({
      targetKind: 'task',
      targetId: 'task-other',
      targetVersion: 'verify:v1',
      recipeId: 'repair-verify',
      rationale: 'Must not appear in this target timeline.',
      outcome: 'recovered',
      ts: '2026-07-03T09:00:00.000Z',
    })

    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/steward-ledger?targetKind=task&targetId=task-7`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        entries: Array<{ targetId: string; targetVersion: string; commitSha: string | null }>
      }
      expect(body.ok).toBe(true)
      expect(body.entries.map((entry) => entry.targetId)).toEqual(['task-7', 'task-7'])
      expect(body.entries.map((entry) => entry.targetVersion)).toEqual(['verify:v2', 'verify:v1'])
      expect(body.entries[0]?.commitSha).toBe('abc123')
    } finally {
      await close()
    }
  })
})
