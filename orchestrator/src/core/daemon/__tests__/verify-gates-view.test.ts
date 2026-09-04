/**
 * Tests for GET /view/verify-gates — the daemon route that returns the full
 * list of verify gates for the Control Room's Gates section.
 *
 * `listVerifyGates` is mocked at the module level so the route can be
 * exercised without a live database. The mock function is a closure variable
 * that persists across `vi.resetModules()` calls — the mock factory captures
 * it, so re-imported modules still reference the same vi.fn.
 */
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
import type { VerifyGate } from '../../verify-gates'

// Closure-captured mock so tests can control the return value directly
// without needing `require` or re-importing the mocked module.
const mockListVerifyGates = vi.fn<() => Promise<VerifyGate[]>>().mockResolvedValue([])

vi.mock('../../verify-gates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../verify-gates')>()
  return {
    ...actual,
    listVerifyGates: mockListVerifyGates,
  }
})

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-verify-gates-view-'))
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
      mkdtempSync(resolve(tmpdir(), 'mars-vg-view-rec-')),
    )
  }
}

const makeDeps = (
  appServicesOverrides: Partial<AppServices> = {},
): HttpServerDeps => ({
  restartTask: async () => {},
  continueTask: async () => {},
  remergeTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  dismissProposal: async () => {},
  promoteProposal: async () => ({ taskIds: [] }),
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

describe('GET /view/verify-gates', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    mockListVerifyGates.mockResolvedValue([])
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns 200 with an empty gates array when no gates are registered', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/verify-gates`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { gates: unknown[] }
      expect(body).toHaveProperty('gates')
      expect(body.gates).toEqual([])
    } finally {
      await close()
    }
  })

  it('returns all gates from listVerifyGates in the response', async () => {
    const mockGate: VerifyGate = {
      id: 'gate-abc123',
      scope: '.',
      name: 'typecheck',
      cmd: 'npx',
      args: ['tsc', '--noEmit'],
      required: true,
      tier: 'task',
      source: 'detected',
      createdAt: 1_700_000_000_000,
      state: 'active',
      quarantinedAt: null,
      quarantineSignature: null,
      lastFailureSignature: null,
      lastFailureAt: null,
      lastFailureOriginId: null,
      timeoutMin: null,
      evidence: null,
    }

    const quarantinedGate: VerifyGate = {
      id: 'gate-def456',
      scope: 'orchestrator',
      name: 'knip',
      cmd: 'npm',
      args: ['run', 'knip'],
      required: false,
      tier: 'integration',
      source: 'detected',
      createdAt: 1_700_000_001_000,
      state: 'quarantined',
      quarantinedAt: 1_700_000_002_000,
      quarantineSignature: 'verify:knip/unused-imports',
      lastFailureSignature: 'verify:knip/unused-imports',
      lastFailureAt: 1_700_000_002_000,
      lastFailureOriginId: 'mars-abc123',
      timeoutMin: 5,
      evidence: 'detected by mars verify-gate detect',
    }

    mockListVerifyGates.mockResolvedValue([mockGate, quarantinedGate])

    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/verify-gates`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { gates: VerifyGate[] }
      expect(body.gates).toHaveLength(2)

      const [first, second] = body.gates
      expect(first?.id).toBe('gate-abc123')
      expect(first?.name).toBe('typecheck')
      expect(first?.tier).toBe('task')
      expect(first?.state).toBe('active')
      expect(first?.args).toEqual(['tsc', '--noEmit'])

      expect(second?.id).toBe('gate-def456')
      expect(second?.name).toBe('knip')
      expect(second?.tier).toBe('integration')
      expect(second?.state).toBe('quarantined')
      expect(second?.required).toBe(false)
      expect(second?.timeoutMin).toBe(5)
    } finally {
      await close()
    }
  })

  it('returns 500 when listVerifyGates throws', async () => {
    mockListVerifyGates.mockRejectedValue(new Error('database unreachable'))

    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/verify-gates`)
      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toContain('database unreachable')
    } finally {
      await close()
    }
  })
})
