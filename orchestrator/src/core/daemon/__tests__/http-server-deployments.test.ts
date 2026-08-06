/**
 * Tests for GET /deployments/:taskId/logs — deployment log streaming.
 *
 * Covers:
 *   200 — noop provider logs returned as text/plain
 *   404 — no deployment found for task
 *   500 — provider logs() call fails
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { HttpServerDeps } from '../http-server'
import type { TaskDeployment } from '../../store/task-store'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

// ── Helpers ────────────────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-deployments-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
beforeAll(async () => {
  cachedRecipeCatalog = await loadRecipeCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-http-dep-rec-')),
  )
})

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const [httpServer, registry] = await Promise.all([
    import('../http-server') as Promise<typeof import('../http-server')>,
    import('../../lib/deployment/registry') as Promise<typeof import('../../lib/deployment/registry')>,
  ])
  return { httpServer, registry }
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

const fakeDeployment = (overrides: Partial<TaskDeployment> = {}): TaskDeployment => ({
  deploymentId: 'noop-task-1',
  taskId: 'task-1',
  provider: 'noop',
  url: 'https://noop.local/task-1',
  status: 'ready',
  error: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
})

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GET /deployments/:taskId/logs', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns 200 text/plain with noop provider logs', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        getLatestDeployment: async () => fakeDeployment(),
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/deployments/task-1/logs`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/plain')
      const text = await res.text()
      expect(text).toContain('noop')
    } finally {
      await close()
    }
  })

  it('returns 404 when no deployment exists for the task', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        getLatestDeployment: async () => null,
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/deployments/task-1/logs`)
      expect(res.status).toBe(404)
      const json = await res.json() as { ok: boolean; error: string }
      expect(json.ok).toBe(false)
      expect(json.error).toContain('task-1')
    } finally {
      await close()
    }
  })

  it('returns 500 when the provider logs() call throws', async () => {
    const { httpServer, registry } = await loadModules(repo)

    // Register a provider that always throws on logs().
    registry.registerProvider('failing-test', {
      deploy: async () => { throw new Error('not implemented') },
      status: async () => { throw new Error('not implemented') },
      logs: async () => { throw new Error('provider logs failed') },
      teardown: async () => {},
    })

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        getLatestDeployment: async () =>
          fakeDeployment({ provider: 'failing-test', deploymentId: 'failing-dep-1' }),
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/deployments/task-1/logs`)
      expect(res.status).toBe(500)
      const json = await res.json() as { ok: boolean; error: string }
      expect(json.ok).toBe(false)
      expect(json.error).toContain('provider logs failed')
    } finally {
      await close()
    }
  })
})
