/**
 * HTTP route tests for GET /view/workflow-configs and GET /view/promotion-ledger
 * (PRD 5b73d277 — chip-style scoring auto-learning, slice 6).
 *
 * These tests drive a real `startHttpServer` with a stub AppServices so they
 * exercise route wiring (param parsing, status codes, content-type, response
 * shape) without a live daemon or DB.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { HttpServerDeps } from '../http-server'
import type { AppServices } from '../../app-services'
import { stubAppServices } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'
import type { WorkflowConfig } from '../../workflow-configs'
import type { PromotionLedgerEntry } from '../../promotion-ledger'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-promo-routes-'))
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
      mkdtempSync(resolve(tmpdir(), 'mars-http-promo-rec-')),
    )
  }
}

const makeDeps = (
  appServicesOverrides: Partial<AppServices> = {},
): HttpServerDeps => ({
  restartTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  dismissProposal: async () => {},
  validateTask: async () => {},
  rejectTask: async () => {},
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
  recipeCatalog: cachedRecipeCatalog!,
  traceStore: nullTraceStore,
  appServices: stubAppServices(appServicesOverrides),
})

const fixtureConfig: WorkflowConfig = {
  id: 'wc-test1',
  workflow: 'task',
  version: 2,
  configHash: 'abc123def456',
  status: 'baseline',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
}

const fixtureEntry: PromotionLedgerEntry = {
  id: 'pl-test1',
  workflow: 'task',
  candidateVersionId: 'wc-test1',
  incumbentVersionId: 'wc-test0',
  candidateScore: 0.82,
  incumbentScore: 0.71,
  candidateN: 15,
  incumbentN: 25,
  decision: 'promoted',
  decidedAt: 1_700_000_001_000,
  createdAt: 1_700_000_000_000,
}

beforeAll(async () => {
  await ensureCatalogs()
})

// ── GET /view/workflow-configs ───────────────────────────────────────────────

describe('GET /view/workflow-configs', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns configs from the injected viewWorkflowConfigs dep', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewWorkflowConfigs: async () => ({ configs: [fixtureConfig] }),
      }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/workflow-configs?workflow=task`,
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = (await res.json()) as { configs: WorkflowConfig[] }
      expect(body.configs).toHaveLength(1)
      expect(body.configs[0]).toMatchObject({
        id: 'wc-test1',
        workflow: 'task',
        version: 2,
        status: 'baseline',
      })
    } finally {
      await close()
    }
  })

  it('returns 400 when workflow query param is missing', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/workflow-configs`,
      )
      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/workflow/)
    } finally {
      await close()
    }
  })

  it('returns empty configs array when no configs exist for workflow', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/workflow-configs?workflow=nonexistent`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { configs: WorkflowConfig[] }
      expect(body.configs).toEqual([])
    } finally {
      await close()
    }
  })

  it('passes workflow param to the service dep', async () => {
    const { httpServer } = await loadModules(repo)
    let capturedWorkflow: string | undefined
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewWorkflowConfigs: async (workflow) => {
          capturedWorkflow = workflow
          return { configs: [] }
        },
      }),
    )
    try {
      await fetch(
        `http://127.0.0.1:${port}/view/workflow-configs?workflow=fix`,
      )
      expect(capturedWorkflow).toBe('fix')
    } finally {
      await close()
    }
  })

  it('returns 404 for wrong HTTP method (POST)', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/workflow-configs?workflow=task`,
        { method: 'POST', body: '{}' },
      )
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })
})

// ── GET /view/promotion-ledger ───────────────────────────────────────────────

describe('GET /view/promotion-ledger', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns entries from the injected viewPromotionLedger dep', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewPromotionLedger: async () => ({ entries: [fixtureEntry] }),
      }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/promotion-ledger?workflow=task`,
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = (await res.json()) as { entries: PromotionLedgerEntry[] }
      expect(body.entries).toHaveLength(1)
      expect(body.entries[0]).toMatchObject({
        id: 'pl-test1',
        workflow: 'task',
        decision: 'promoted',
        candidateScore: 0.82,
      })
    } finally {
      await close()
    }
  })

  it('returns all entries when workflow param is omitted', async () => {
    const { httpServer } = await loadModules(repo)
    let capturedWorkflow: string | undefined = 'should-be-cleared'
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewPromotionLedger: async (workflow) => {
          capturedWorkflow = workflow
          return { entries: [fixtureEntry] }
        },
      }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/promotion-ledger`,
      )
      expect(res.status).toBe(200)
      expect(capturedWorkflow).toBeUndefined()
      const body = (await res.json()) as { entries: PromotionLedgerEntry[] }
      expect(body.entries).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('passes workflow param to the service dep', async () => {
    const { httpServer } = await loadModules(repo)
    let capturedWorkflow: string | undefined
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewPromotionLedger: async (workflow) => {
          capturedWorkflow = workflow
          return { entries: [] }
        },
      }),
    )
    try {
      await fetch(
        `http://127.0.0.1:${port}/view/promotion-ledger?workflow=fix`,
      )
      expect(capturedWorkflow).toBe('fix')
    } finally {
      await close()
    }
  })

  it('returns 404 for wrong HTTP method (POST)', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/promotion-ledger`,
        { method: 'POST', body: '{}' },
      )
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })

  it('returns empty entries array when no entries exist', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/promotion-ledger?workflow=task`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { entries: PromotionLedgerEntry[] }
      expect(body.entries).toEqual([])
    } finally {
      await close()
    }
  })
})

// ── GET /view/scorer-workflows ───────────────────────────────────────────────

describe('GET /view/scorer-workflows', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns workflows from the injected viewScorerWorkflows dep', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewScorerWorkflows: async () => ({ workflows: ['task', 'fix'] }),
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/scorer-workflows`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = (await res.json()) as { workflows: string[] }
      expect(body).toEqual({ workflows: ['task', 'fix'] })
    } finally {
      await close()
    }
  })

  it('returns empty workflows array when no scored workflows exist', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/scorer-workflows`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { workflows: string[] }
      expect(body).toEqual({ workflows: [] })
    } finally {
      await close()
    }
  })

  it('returns 404 for wrong HTTP method (POST)', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/scorer-workflows`, {
        method: 'POST',
        body: '{}',
      })
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })
})
