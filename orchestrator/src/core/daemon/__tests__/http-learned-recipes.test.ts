/**
 * HTTP route tests — learned-recipe store.
 *
 * Covers:
 *   GET  /failure-kinds/learned-recipes
 *   POST /failure-kinds/:sig/recipe
 *   DELETE /failure-kinds/:sig/recipe
 *   GET  /view/auto-recipe-runs
 *
 * Pattern mirrors http-restart.test.ts: each test resets module singletons via
 * `vi.resetModules()`, seeds the DB through the `learned-recipes.js` module,
 * starts a fresh HTTP server, fires a real `fetch()`, and asserts on the JSON
 * body. PGlite is pre-warmed inside `loadModules` so the first read inside a
 * route handler never races against DB initialisation.
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-lr-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * Reset module singletons, apply the full DB schema, and pre-warm the
 * learned-recipes DB tables so the HTTP route handlers never race against
 * PGlite initialisation on the very first request.
 */
const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = (await import('../../queue')) as typeof import('../../queue')
  const httpServer = (await import('../http-server')) as typeof import('../http-server')
  await queue.migrateQueueSchema()
  // Pre-warm: HTTP handlers do a dynamic `import('../lib/learned-recipes.js')`.
  // Importing and calling a read here ensures the DB tables exist and the
  // PGlite connection is ready before the first HTTP request arrives.
  const lr = (await import('../../lib/learned-recipes.js')) as typeof import('../../lib/learned-recipes.js')
  await lr.listLearnedRecipes()
  return { httpServer, lr }
}

// ── Recipe catalog (needed by makeDeps) ──────────────────────────────────────

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
const getBuiltInRecipeCatalog = async () => {
  if (!cachedRecipeCatalog) {
    cachedRecipeCatalog = await loadRecipeCatalog(
      mkdtempSync(resolve(tmpdir(), 'mars-http-lr-cat-')),
    )
  }
  return cachedRecipeCatalog
}

const makeDeps = (overrides: Partial<HttpServerDeps> = {}): HttpServerDeps => ({
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
  recipeCatalog: cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: nullTraceStore,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  ...overrides,
})

beforeAll(async () => {
  await getBuiltInRecipeCatalog()
})

// ── GET /failure-kinds/learned-recipes ────────────────────────────────────────

describe('GET /failure-kinds/learned-recipes', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns an empty list when no recipes have been taught', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/failure-kinds/learned-recipes`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; learnedRecipes: unknown[] }
      expect(body.ok).toBe(true)
      expect(body.learnedRecipes).toEqual([])
    } finally {
      await close()
    }
  })

  it('returns all stored recipes after teaching some', async () => {
    const { httpServer, lr } = await loadModules(repo)
    await lr.teachRecipe('verify:typecheck/type-mismatch', 'restart')
    await lr.teachRecipe('setup:install/install-frozen-lockfile', 'purge')
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/failure-kinds/learned-recipes`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        learnedRecipes: Array<{ failureSignature: string; actionOp: string }>
      }
      expect(body.ok).toBe(true)
      const sigs = body.learnedRecipes.map((r) => r.failureSignature)
      expect(sigs).toContain('verify:typecheck/type-mismatch')
      expect(sigs).toContain('setup:install/install-frozen-lockfile')
    } finally {
      await close()
    }
  })
})

// ── POST /failure-kinds/:sig/recipe ──────────────────────────────────────────

describe('POST /failure-kinds/:sig/recipe', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('persists a recipe and returns ok:true', async () => {
    const { httpServer, lr } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    const sig = 'verify:typecheck/type-mismatch'
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/failure-kinds/${encodeURIComponent(sig)}/recipe`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: 'restart' }),
        },
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)
      // Verify DB persistence via the lib directly.
      const stored = await lr.getLearnedRecipe(sig)
      expect(stored).not.toBeNull()
      expect(stored?.actionOp).toBe('restart')
    } finally {
      await close()
    }
  })

  it('idempotent upsert — re-posting replaces the op and refreshes learnedAt', async () => {
    const { httpServer, lr } = await loadModules(repo)
    await lr.teachRecipe('verify:typecheck/type-mismatch', 'restart')
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    const sig = 'verify:typecheck/type-mismatch'
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/failure-kinds/${encodeURIComponent(sig)}/recipe`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: 'purge' }),
        },
      )
      expect(res.status).toBe(200)
      const stored = await lr.getLearnedRecipe(sig)
      expect(stored?.actionOp).toBe('purge')
    } finally {
      await close()
    }
  })

  it('returns 400 when op is missing from the body', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    const sig = 'verify:typecheck/type-mismatch'
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/failure-kinds/${encodeURIComponent(sig)}/recipe`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      )
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('returns 400 for an invalid JSON body', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    const sig = 'verify:typecheck/type-mismatch'
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/failure-kinds/${encodeURIComponent(sig)}/recipe`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not-json{',
        },
      )
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })
})

// ── DELETE /failure-kinds/:sig/recipe ────────────────────────────────────────

describe('DELETE /failure-kinds/:sig/recipe', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('removes a stored recipe and returns ok:true', async () => {
    const { httpServer, lr } = await loadModules(repo)
    const sig = 'verify:typecheck/type-mismatch'
    await lr.teachRecipe(sig, 'restart')
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/failure-kinds/${encodeURIComponent(sig)}/recipe`,
        { method: 'DELETE' },
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)
      const stored = await lr.getLearnedRecipe(sig)
      expect(stored).toBeNull()
    } finally {
      await close()
    }
  })

  it('is a no-op for an unknown signature and still returns ok:true', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/failure-kinds/${encodeURIComponent('no-such-sig')}/recipe`,
        { method: 'DELETE' },
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)
    } finally {
      await close()
    }
  })
})

// ── GET /view/auto-recipe-runs ────────────────────────────────────────────────

describe('GET /view/auto-recipe-runs', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns an empty list when no runs have been logged', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/auto-recipe-runs`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; autoRecipeRuns: unknown[] }
      expect(body.ok).toBe(true)
      expect(body.autoRecipeRuns).toEqual([])
    } finally {
      await close()
    }
  })

  it('returns logged auto-run entries', async () => {
    const { httpServer, lr } = await loadModules(repo)
    await lr.logAutoRecipeRun({
      signature: 'verify:typecheck/type-mismatch',
      actionOp: 'restart',
      taskId: 'task-abc',
    })
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/auto-recipe-runs`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        autoRecipeRuns: Array<{ signature: string; actionOp: string; taskId: string | null }>
      }
      expect(body.ok).toBe(true)
      expect(body.autoRecipeRuns).toHaveLength(1)
      expect(body.autoRecipeRuns[0]?.signature).toBe('verify:typecheck/type-mismatch')
      expect(body.autoRecipeRuns[0]?.actionOp).toBe('restart')
      expect(body.autoRecipeRuns[0]?.taskId).toBe('task-abc')
    } finally {
      await close()
    }
  })

  it('filters by since — only entries newer than the cursor are returned', async () => {
    const { httpServer, lr } = await loadModules(repo)
    // Log an "old" run with a well-past timestamp by inserting via the DB directly.
    // The lib does not expose a timestamp override, so we use the test seam.
    const client = lr.__resolveStateClientForTests()
    const { randomUUID } = await import('node:crypto')
    await client.execute({
      sql: `INSERT INTO auto_recipe_runs (id, signature, action_op, task_id, ran_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [randomUUID(), 'verify:typecheck/old', 'purge', null, '2020-01-01T00:00:00.000Z'],
    })
    await lr.logAutoRecipeRun({
      signature: 'verify:typecheck/new',
      actionOp: 'restart',
      taskId: 'task-new',
    })
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      // since=2021 — should only return the "new" entry logged above.
      const res = await fetch(
        `http://127.0.0.1:${port}/view/auto-recipe-runs?since=2021-01-01T00:00:00.000Z`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        autoRecipeRuns: Array<{ signature: string }>
      }
      expect(body.ok).toBe(true)
      const sigs = body.autoRecipeRuns.map((r) => r.signature)
      expect(sigs).toContain('verify:typecheck/new')
      expect(sigs).not.toContain('verify:typecheck/old')
    } finally {
      await close()
    }
  })
})
