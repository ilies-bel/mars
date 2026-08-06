/**
 * Tests for GET /preferences/notifications and PUT /preferences/notifications.
 *
 * The route returns and updates the notifications_enabled preference in mars.db.
 * Both verbs bypass the draining gate (lightweight preference write, not task work).
 *
 * Isolation pattern: vi.resetModules() + fresh temp-dir git repo for each test
 * so state-client's singleton is torn down between tests (same pattern as
 * http-view-tasks.test.ts and the preferences state-store tests).
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
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-prefs-route-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/** Reset module registry, point to `repo`, run migrations, return fresh modules. */
const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const stateStore = (await import(
    '../../store/state-store'
  )) as typeof import('../../store/state-store')
  const httpServer = (await import(
    '../http-server'
  )) as typeof import('../http-server')
  await stateStore.migrateStateSchema()
  return { stateStore, httpServer }
}

// ── Recipe catalog (loaded once, before any vi.resetModules calls) ────────────

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null

beforeAll(async () => {
  if (!cachedRecipeCatalog) {
    cachedRecipeCatalog = await loadRecipeCatalog(
      mkdtempSync(resolve(tmpdir(), 'mars-prefs-route-rec-')),
    )
  }
})

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
  recipeCatalog: cachedRecipeCatalog!,
  traceStore: nullTraceStore,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  ...overrides,
})

// ── Test suites ───────────────────────────────────────────────────────────────

describe('GET /preferences/notifications', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns { enabled: true } by default when no value has been stored', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/preferences/notifications`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ enabled: true })
    } finally {
      await close()
    }
  })
})

describe('PUT /preferences/notifications', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('PUT { enabled: false } returns new state and subsequent GET reflects the change', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const put = await fetch(`http://127.0.0.1:${port}/preferences/notifications`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
      expect(put.status).toBe(200)
      expect(await put.json()).toEqual({ enabled: false })

      const get = await fetch(`http://127.0.0.1:${port}/preferences/notifications`)
      expect(get.status).toBe(200)
      expect(await get.json()).toEqual({ enabled: false })
    } finally {
      await close()
    }
  })

  it('PUT { enabled: true } returns new state and subsequent GET reflects the change', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      // First disable it, then re-enable to verify the roundtrip for true.
      await fetch(`http://127.0.0.1:${port}/preferences/notifications`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })

      const put = await fetch(`http://127.0.0.1:${port}/preferences/notifications`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
      expect(put.status).toBe(200)
      expect(await put.json()).toEqual({ enabled: true })

      const get = await fetch(`http://127.0.0.1:${port}/preferences/notifications`)
      expect(get.status).toBe(200)
      expect(await get.json()).toEqual({ enabled: true })
    } finally {
      await close()
    }
  })

  it('PUT with enabled typed as string returns 400 and does not mutate', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const bad = await fetch(`http://127.0.0.1:${port}/preferences/notifications`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: 'yes' }),
      })
      expect(bad.status).toBe(400)

      // Confirm the stored value was not mutated (still the default: true).
      const get = await fetch(`http://127.0.0.1:${port}/preferences/notifications`)
      expect(get.status).toBe(200)
      expect(await get.json()).toEqual({ enabled: true })
    } finally {
      await close()
    }
  })

  it('PUT with missing enabled field returns 400', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const bad = await fetch(`http://127.0.0.1:${port}/preferences/notifications`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ foo: true }),
      })
      expect(bad.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('PUT with invalid JSON body returns 400', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const bad = await fetch(`http://127.0.0.1:${port}/preferences/notifications`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json',
      })
      expect(bad.status).toBe(400)
    } finally {
      await close()
    }
  })
})
