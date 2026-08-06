import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { vi } from 'vitest'
import type { HttpServerDeps } from '../http-server'
import type { AppServices } from '../../app-services'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'
import type { Alert } from '../../lib/alert'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-alerts-thread-'))
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
  return { httpServer }
}

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null

const ensureCatalogs = async (): Promise<void> => {
  if (!cachedRecipeCatalog) {
    cachedRecipeCatalog = await loadRecipeCatalog(
      mkdtempSync(resolve(tmpdir(), 'mars-http-alerts-thread-rec-')),
    )
  }
}

const makeDeps = (
  appServicesOverrides: Partial<AppServices> = {},
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
  appServices: stubAppServices(appServicesOverrides),
  chatRunner: stubChatRunner(),
})

const makeAlert = (arcId: string, goal: string): Alert => ({
  arcId,
  goal,
  reason: 'a verify step failed',
  technical: 'signature: verify/failed',
  kind: 'arc-failed',
  chain: [],
})

beforeAll(async () => {
  await ensureCatalogs()
})

describe('POST /alerts/:arcId/thread', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('creates a thread and returns { threadId }, forwarding the arc id', async () => {
    const { httpServer } = await loadModules(repo)
    let pulledArc: string | null = null
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        startThreadFromAlert: async (arcId) => {
          pulledArc = arcId
          return { threadId: 'thread-42' }
        },
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/alerts/arc-1/thread`, {
        method: 'POST',
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { threadId: string }
      expect(body.threadId).toBe('thread-42')
      expect(pulledArc).toBe('arc-1')
    } finally {
      await close()
    }
  })

  it('returns 404 { threadId: null } when the arc has no Alert', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ startThreadFromAlert: async () => null }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/alerts/nope/thread`, {
        method: 'POST',
      })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { threadId: string | null }
      expect(body.threadId).toBeNull()
    } finally {
      await close()
    }
  })
})

describe('GET /alerts/next', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns the top Alert from nextActionAlert', async () => {
    const { httpServer } = await loadModules(repo)
    const top = makeAlert('arc-top', 'ship the login page')
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ nextActionAlert: async () => top }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/alerts/next`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Alert
      expect(body.arcId).toBe('arc-top')
      expect(body.goal).toBe('ship the login page')
    } finally {
      await close()
    }
  })

  it('returns {} when there is no Alert', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ nextActionAlert: async () => null }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/alerts/next`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body).toEqual({})
    } finally {
      await close()
    }
  })

  it('does not shadow the bare GET /alerts list route', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ viewAlerts: async () => [makeAlert('arc-a', 'goal a')] }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/alerts`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Alert[]
      expect(body).toHaveLength(1)
      expect(body[0]?.arcId).toBe('arc-a')
    } finally {
      await close()
    }
  } )
})
