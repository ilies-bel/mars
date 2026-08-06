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
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-qa-report-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null =
  null

const ensureCatalogs = async (): Promise<void> => {
  if (!cachedRecipeCatalog) {
    cachedRecipeCatalog = await loadRecipeCatalog(
      mkdtempSync(resolve(tmpdir(), 'mars-http-qa-rec-')),
    )
  }
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
  recipeCatalog: cachedRecipeCatalog!,
  traceStore: nullTraceStore,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  ...overrides,
})

beforeAll(async () => {
  await ensureCatalogs()
})

describe('GET /view/tasks/:id — qa_report field', () => {
  let repo: string
  let startHttpServer: typeof import('../http-server').startHttpServer

  beforeEach(async () => {
    repo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = repo
    const httpMod = await import('../http-server')
    startHttpServer = httpMod.startHttpServer
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns qa_report when present on a task', async () => {
    const qaReport = {
      criteria: [
        {
          criterion: 'Login form renders',
          verdict: 'pass' as const,
          screenshotPath: 'qa/0.png',
          note: 'Login form visible',
        },
        {
          criterion: 'Error state shows red border',
          verdict: 'unverifiable' as const,
          screenshotPath: 'qa/1.png',
          note: 'Could not trigger error state',
        },
      ],
      bootReason: 'npm run dev',
      completedAt: '2026-07-26T10:00:00.000Z',
      durationMs: 12345,
    }

    const deps = makeDeps({
      appServices: stubAppServices({
        viewTask: async () => ({
          task: {
            id: 'test-123',
            prompt: 'test',
            status: 'done',
            qaReport,
          },
        }),
      }),
    })

    const { port, address, close } = await startHttpServer(deps)
    const url = `http://${address}:${port}`
    try {
      const res = await fetch(`${url}/view/tasks/test-123`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.task.qaReport).toEqual(qaReport)
      expect(body.task.qaReport.criteria).toHaveLength(2)
      expect(body.task.qaReport.criteria[0].screenshotPath).toBe('qa/0.png')
    } finally {
      await close()
    }
  })

  it('returns null qa_report when not present', async () => {
    const deps = makeDeps({
      appServices: stubAppServices({
        viewTask: async () => ({
          task: {
            id: 'test-456',
            prompt: 'test',
            status: 'running',
            qaReport: null,
          },
        }),
      }),
    })

    const { port, address, close } = await startHttpServer(deps)
    const url = `http://${address}:${port}`
    try {
      const res = await fetch(`${url}/view/tasks/test-456`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.task.qaReport).toBeNull()
    } finally {
      await close()
    }
  })
})
