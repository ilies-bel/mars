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
import type { Notice } from '../../lib/notice-store'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-notices-'))
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
      mkdtempSync(resolve(tmpdir(), 'mars-http-notices-rec-')),
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
  restartAllDaemonKilled: async () => [],
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

beforeAll(async () => {
  await ensureCatalogs()
})

describe('GET /notices', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns { notices: [] } when there are no open notices', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/notices`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { notices: Notice[] }
      expect(body.notices).toEqual([])
    } finally {
      await close()
    }
  })

  it('returns the notices from injected listNotices', async () => {
    const { httpServer } = await loadModules(repo)
    const fixture: Notice[] = [
      {
        id: 'notice01',
        kind: 'spend-control-notice',
        payload: { direction: 'paused' },
        body: 'the Steward raised the concurrency limit',
        source: 'steward',
        createdAt: '2026-07-24T00:00:00.000Z',
        acknowledgedAt: null,
        preloadedResponses: [],
      },
    ]
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ listNotices: async () => fixture }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/notices`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { notices: Notice[] }
      expect(body.notices).toHaveLength(1)
      expect(body.notices[0]?.id).toBe('notice01')
      expect(body.notices[0]?.body).toBe('the Steward raised the concurrency limit')
    } finally {
      await close()
    }
  })
})

describe('POST /notices/:id/ack', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns { acknowledged: true } and forwards the id to ackNotice', async () => {
    const { httpServer } = await loadModules(repo)
    let ackedId: string | null = null
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        ackNotice: async (id) => {
          ackedId = id
          return true
        },
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/notices/notice01/ack`, {
        method: 'POST',
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { acknowledged: boolean }
      expect(body.acknowledged).toBe(true)
      expect(ackedId).toBe('notice01')
    } finally {
      await close()
    }
  })

  it('returns { acknowledged: false } when the notice is missing or already acked', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ ackNotice: async () => false }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/notices/nope/ack`, {
        method: 'POST',
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { acknowledged: boolean }
      expect(body.acknowledged).toBe(false)
    } finally {
      await close()
    }
  })
})
