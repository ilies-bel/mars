import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { HttpServerDeps } from '../http-server'
import type { AppServices } from '../../app-services'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'
import type { ReflectCorpus } from '../../lib/reflect-query'
import type { ArcCandidate } from '../../lib/deep-reflect-query'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-view-reflect-'))
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

let cachedRecipeCatalog: Awaited<
  ReturnType<typeof loadRecipeCatalog>
> | null = null

const ensureCatalogs = async (): Promise<void> => {
  if (!cachedRecipeCatalog) {
    cachedRecipeCatalog = await loadRecipeCatalog(
      mkdtempSync(resolve(tmpdir(), 'mars-http-ref-rec-')),
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

const emptyCorpus: ReflectCorpus = {
  entries: [],
  costSummary: {
    totalWeightedTokens: 0,
    taskCount: 0,
    successCount: 0,
    failureCount: 0,
    blockedCount: 0,
    droppedCount: 0,
    cacheHitRatio: 0,
    rateLimitRejections: 0,
    topTokenHeavyTasks: [],
    topExpensiveSteps: [],
    tokensByStep: [],
  },
}

beforeAll(async () => {
  await ensureCatalogs()
})

describe('GET /view/reflect', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns corpus data from the injected viewReflect dep', async () => {
    const { httpServer } = await loadModules(repo)

    const corpus: ReflectCorpus = {
      entries: [
        {
          taskId: 'abc123',
          status: 'done',
          promptPrefix: 'Fix the bug',
          errorTail: null,
          createdAt: '2026-06-01T00:00:00Z',
          failureSignature: null,
          failureReasonCode: null,
          failedPhase: null,
          kind: null,
          fixForTaskId: null,
          originId: null,
          toolErrorCount: 0,
          topErrorTool: null,
          signals: [],
          scorerResults: [],
          totals: {
            inputTokens: 100,
            outputTokens: 200,
            cacheCreateTokens: 50,
            cacheReadTokens: 10,
            cacheHitRatio: 0.17,
          },
        },
      ],
      costSummary: {
        totalWeightedTokens: 351,
        taskCount: 1,
        successCount: 1,
        failureCount: 0,
        blockedCount: 0,
        droppedCount: 0,
        cacheHitRatio: 0.17,
        rateLimitRejections: 0,
        topTokenHeavyTasks: [],
        topExpensiveSteps: [],
        tokensByStep: [],
      },
    }

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ viewReflect: async () => corpus }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/reflect`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as ReflectCorpus
      expect(body.entries).toHaveLength(1)
      expect(body.entries[0]?.taskId).toBe('abc123')
      expect(body.costSummary.taskCount).toBe(1)
    } finally {
      await close()
    }
  })

  it('passes limit query param to viewReflect', async () => {
    const { httpServer } = await loadModules(repo)

    let capturedOpts: Parameters<AppServices['viewReflect']>[0]
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewReflect: async (opts) => {
          capturedOpts = opts
          return emptyCorpus
        },
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/reflect?limit=7`)
      expect(res.status).toBe(200)
      expect(capturedOpts!).toMatchObject({ limit: 7 })
    } finally {
      await close()
    }
  })

  it('passes since query param to viewReflect as sinceIso', async () => {
    const { httpServer } = await loadModules(repo)

    let capturedOpts: Parameters<AppServices['viewReflect']>[0]
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewReflect: async (opts) => {
          capturedOpts = opts
          return emptyCorpus
        },
      }),
    )

    try {
      const since = '2026-05-01T00:00:00Z'
      const res = await fetch(
        `http://127.0.0.1:${port}/view/reflect?since=${encodeURIComponent(since)}`,
      )
      expect(res.status).toBe(200)
      expect(capturedOpts!).toMatchObject({ sinceIso: since })
    } finally {
      await close()
    }
  })

  it('returns 500 when viewReflect throws', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewReflect: async () => {
          throw new Error('corpus unavailable')
        },
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/reflect`)
      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('corpus unavailable')
    } finally {
      await close()
    }
  })
})

describe('GET /view/arcs', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns arc candidates from the injected viewArcs dep', async () => {
    const { httpServer } = await loadModules(repo)

    const candidates: ArcCandidate[] = [
      {
        originId: 'origin-aaa',
        taskCount: 2,
        statusMix: { done: 1, failed: 1 },
        failureCount: 1,
        doneCount: 1,
        totalTokens: 5000,
        lastActivity: '2026-06-01T12:00:00Z',
        rankScore: 1_000_000_000 + 5000,
      },
    ]

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ viewArcs: async () => candidates }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/arcs`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as ArcCandidate[]
      expect(Array.isArray(body)).toBe(true)
      expect(body).toHaveLength(1)
      expect(body[0]?.originId).toBe('origin-aaa')
      expect(body[0]?.failureCount).toBe(1)
    } finally {
      await close()
    }
  })

  it('returns empty array when no arc candidates exist', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ viewArcs: async () => [] }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/arcs`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as ArcCandidate[]
      expect(body).toHaveLength(0)
    } finally {
      await close()
    }
  })

  it('passes limit query param to viewArcs', async () => {
    const { httpServer } = await loadModules(repo)

    let capturedOpts: Parameters<AppServices['viewArcs']>[0]
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewArcs: async (opts) => {
          capturedOpts = opts
          return []
        },
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/arcs?limit=3`)
      expect(res.status).toBe(200)
      expect(capturedOpts!).toMatchObject({ limit: 3 })
    } finally {
      await close()
    }
  })

  it('passes withTranscriptOnly=false when query param is false', async () => {
    const { httpServer } = await loadModules(repo)

    let capturedOpts: Parameters<AppServices['viewArcs']>[0]
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewArcs: async (opts) => {
          capturedOpts = opts
          return []
        },
      }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/arcs?withTranscriptOnly=false`,
      )
      expect(res.status).toBe(200)
      expect(capturedOpts!).toMatchObject({ withTranscriptOnly: false })
    } finally {
      await close()
    }
  })

  it('passes withTranscriptOnly=true when query param is true', async () => {
    const { httpServer } = await loadModules(repo)

    let capturedOpts: Parameters<AppServices['viewArcs']>[0]
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewArcs: async (opts) => {
          capturedOpts = opts
          return []
        },
      }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/arcs?withTranscriptOnly=true`,
      )
      expect(res.status).toBe(200)
      expect(capturedOpts!).toMatchObject({ withTranscriptOnly: true })
    } finally {
      await close()
    }
  })

  it('returns 500 when viewArcs throws', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewArcs: async () => {
          throw new Error('arcs unavailable')
        },
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/arcs`)
      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('arcs unavailable')
    } finally {
      await close()
    }
  })
})
