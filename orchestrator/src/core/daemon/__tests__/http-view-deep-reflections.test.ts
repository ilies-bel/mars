/**
 * Tests for GET /view/deep-reflections (list) and
 * GET /view/deep-reflections/:originId (detail) routes.
 *
 * Follows the pattern established in http-view-reflect.test.ts:
 * - start a real HTTP server with a stubbed AppServices
 * - drive the route with fetch
 * - assert on status code and response shape
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { HttpServerDeps } from '../http-server'
import type { AppServices } from '../../app-services'
import type { DeepReflectionsListResult, DeepReflectionDetail } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-deep-ref-'))
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
      mkdtempSync(resolve(tmpdir(), 'mars-http-dr-rec-')),
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

const sampleReport: DeepReflectionSummary = {
  originId: 'origin-abc',
  recordedAt: '2026-08-06T18:42:55.791Z',
  status: 'complete',
  totalToolCalls: 1302,
  dissonantCallCount: 1,
  verifyMismatchCount: 1,
  thrashingPatternCount: 3,
  verdictResult: { saved: 4, absorbed: 0, dropped: 0 },
}

// Import DeepReflectionSummary type for use in the test.
type DeepReflectionSummary = DeepReflectionsListResult['reports'][0]

beforeAll(async () => {
  await ensureCatalogs()
})

describe('GET /view/deep-reflections', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns list result from the injected viewDeepReflections dep', async () => {
    const { httpServer } = await loadModules(repo)

    const listResult: DeepReflectionsListResult = {
      reports: [sampleReport],
      autoRunReflect: 'on',
      autoEnqueue: false,
      lastReflectedAt: '2026-08-06T18:42:55.791Z',
    }

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ viewDeepReflections: async () => listResult }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/deep-reflections`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as DeepReflectionsListResult
      expect(body.reports).toHaveLength(1)
      expect(body.reports[0]?.originId).toBe('origin-abc')
      expect(body.reports[0]?.dissonantCallCount).toBe(1)
      expect(body.autoRunReflect).toBe('on')
      expect(body.autoEnqueue).toBe(false)
      expect(body.lastReflectedAt).toBe('2026-08-06T18:42:55.791Z')
    } finally {
      await close()
    }
  })

  it('returns empty list when no reports exist', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewDeepReflections: async () => ({
          reports: [],
          autoRunReflect: 'off',
          autoEnqueue: false,
          lastReflectedAt: null,
        }),
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/deep-reflections`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as DeepReflectionsListResult
      expect(body.reports).toHaveLength(0)
      expect(body.lastReflectedAt).toBeNull()
    } finally {
      await close()
    }
  })

  it('passes limit query param to viewDeepReflections', async () => {
    const { httpServer } = await loadModules(repo)

    let capturedOpts: Parameters<AppServices['viewDeepReflections']>[0]
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewDeepReflections: async (opts) => {
          capturedOpts = opts
          return { reports: [], autoRunReflect: 'on', autoEnqueue: false, lastReflectedAt: null }
        },
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/deep-reflections?limit=5`)
      expect(res.status).toBe(200)
      expect(capturedOpts!).toMatchObject({ limit: 5 })
    } finally {
      await close()
    }
  })

  it('returns 500 when viewDeepReflections throws', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewDeepReflections: async () => {
          throw new Error('deep reflections unavailable')
        },
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/deep-reflections`)
      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('deep reflections unavailable')
    } finally {
      await close()
    }
  })
})

describe('GET /view/deep-reflections/:originId', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns the detail report from the injected viewDeepReflection dep', async () => {
    const { httpServer } = await loadModules(repo)

    const detail: DeepReflectionDetail = {
      ...sampleReport,
      sourceTaskId: 'reflect-abc123',
      autoRunReflect: 'on',
      autoEnqueue: false,
      report: {
        summary: 'Arc completed with some issues.',
        rootCause: 'Isolated test loops produced local confidence.',
        toolCallStats: { total: 1302, byName: { Bash: 750, Read: 552 } },
        dissonantCalls: [
          {
            taskId: 'mars-5c83',
            eventIndex: 816,
            tool: 'Bash',
            statedIntent: 'Run verify',
            actualOutcome: 'Only ran a focused test, not full suite',
            severity: 'high',
            evidence: 'evidence text',
          },
        ],
        verifyMismatch: {
          taskId: 'mars-5c83',
          claimed: 'All tests pass',
          actual: 'verify failed typecheck',
          severity: 'high',
        },
        verifyMismatches: [
          {
            taskId: 'mars-5c83',
            claimed: 'All tests pass',
            actual: 'verify failed typecheck',
            severity: 'high',
          },
        ],
        thrashingPatterns: [
          { pattern: 'Repeated reads of pg-schema.ts', occurrences: 7, evidence: 'repeated reads' },
        ],
        suggestions: [
          { title: 'Fix the wiring', prompt: 'Wire it up', rationale: 'It was not wired', verdict: 'save', targetId: null, outcome: null },
        ],
      },
    }

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ viewDeepReflection: async () => detail }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/deep-reflections/${encodeURIComponent('origin-abc')}`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as DeepReflectionDetail
      expect(body.originId).toBe('origin-abc')
      expect(body.status).toBe('complete')
      expect(body.report?.dissonantCalls).toHaveLength(1)
      expect(body.report?.dissonantCalls[0]?.severity).toBe('high')
      expect(body.report?.verifyMismatch?.claimed).toBe('All tests pass')
      expect(body.report?.thrashingPatterns).toHaveLength(1)
      expect(body.autoRunReflect).toBe('on')
    } finally {
      await close()
    }
  })

  it('returns 404 when viewDeepReflection returns null', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ viewDeepReflection: async () => null }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/deep-reflections/${encodeURIComponent('unknown-origin')}`,
      )
      expect(res.status).toBe(404)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('report not found')
    } finally {
      await close()
    }
  })

  it('handles a report with null report body (non-complete status)', async () => {
    const { httpServer } = await loadModules(repo)

    const incompleteDetail: DeepReflectionDetail = {
      originId: 'pending-origin',
      recordedAt: '2026-08-07T00:00:00.000Z',
      status: 'pending',
      totalToolCalls: 0,
      dissonantCallCount: 0,
      verifyMismatchCount: 0,
      thrashingPatternCount: 0,
      verdictResult: { saved: 0, absorbed: 0, dropped: 0 },
      sourceTaskId: null,
      autoRunReflect: 'on',
      autoEnqueue: false,
      report: null,
    }

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ viewDeepReflection: async () => incompleteDetail }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/deep-reflections/${encodeURIComponent('pending-origin')}`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as DeepReflectionDetail
      expect(body.status).toBe('pending')
      expect(body.report).toBeNull()
    } finally {
      await close()
    }
  })

  it('returns 500 when viewDeepReflection throws', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewDeepReflection: async () => {
          throw new Error('detail unavailable')
        },
      }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/deep-reflections/${encodeURIComponent('origin-err')}`,
      )
      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('detail unavailable')
    } finally {
      await close()
    }
  })
})
