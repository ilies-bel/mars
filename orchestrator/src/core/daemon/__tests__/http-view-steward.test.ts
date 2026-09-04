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

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-view-steward-'))
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
      mkdtempSync(resolve(tmpdir(), 'mars-http-stw-rec-')),
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
  landWork: async () => {},
  dismissProposal: async () => {},
  promoteProposal: async () => ({ taskIds: [] }),
  validateTask: async () => {},
  rejectTask: async () => {},
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

describe('GET /view/steward', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns 200 with four-section body from the injected viewSteward dep', async () => {
    const { httpServer } = await loadModules(repo)

    const stewardBody = await stubAppServices().viewSteward({
      liveCap: 16,
      baselineCap: 8,
      isPaused: false,
    })

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewSteward: async () => ({
          ...stewardBody,
          runtimeTuning: {
            ...stewardBody.runtimeTuning,
            acks: [
              {
                text: 'I bumped implement workers from 8 to 11',
                timestamp: '2026-01-01T00:00:00Z',
                pair: { from: 8, to: 11 },
              },
            ],
            liveCap: 16,
            baselineCap: 8,
            ceiling: 16,
          },
          signatureStorm: {
            ...stewardBody.signatureStorm,
            tripped: true,
            streak_count: 5,
            tripThreshold: 3,
            isPaused: false,
          },
        }),
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/steward`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as ReturnType<AppServices['viewSteward']> extends Promise<infer T> ? T : never
      // Four sections must be present
      expect(body).toHaveProperty('runtimeTuning')
      expect(body).toHaveProperty('workflowPatches')
      expect(body).toHaveProperty('signatureStorm')
      expect(body).toHaveProperty('agentSpec')
      // Runtime tuning acks round-trip
      expect(body.runtimeTuning.acks).toHaveLength(1)
      expect(body.runtimeTuning.acks[0]?.pair).toEqual({ from: 8, to: 11 })
      expect(body.runtimeTuning.liveCap).toBe(16)
      expect(body.runtimeTuning.ceiling).toBe(16)
      // Signature storm round-trip
      expect(body.signatureStorm.tripped).toBe(true)
      expect(body.signatureStorm.streak_count).toBe(5)
      expect(body.signatureStorm.tripThreshold).toBe(3)
      // agentSpec static fields
      expect(body.agentSpec.name).toBe('steward')
      expect(body.agentSpec.dispatchSites).toBe(0)
    } finally {
      await close()
    }
  })

  it('normalizes persisted runtime-tuning acknowledgment timestamps for the steward view', async () => {
    process.env.MARS_REPO = repo
    const { __resetContextCacheForTests } = await import('../../context')
    const { __resetDbRegistryForTests } = await import('../../lib/db')
    const { createAppServices } = await import('../../app-services')
    const { nullTraceStore: realNullTraceStore } = await import('../../lib/run-tool')
    const { getCompositionRootClient, runCompositionRootMigrations } = await import('../../store/task-store-default')

    __resetContextCacheForTests()
    await __resetDbRegistryForTests()
    await runCompositionRootMigrations()

    const db = getCompositionRootClient()
    await db.execute({
      sql: `INSERT INTO steward_ledger (id, ts, target_kind, target_id, target_version, recipe_id, rationale, outcome)
            VALUES (?, ?, 'daemon-cap', 'implement', 'v1', 'backlog-clear', 'backlog cleared', ?)`,
      args: [
        'steward-ack',
        '2026-08-01T10:03:34.014Z',
        'implement cap 11 → 12',
      ],
    })

    const services = createAppServices({
      traceStore: realNullTraceStore,
      buildAlertSources: async () => ({
        listFailedArcs: async () => [],
        listStaleWorktrees: async () => [],
        listVerifyUncovered: async () => [],
      }),
    })

    const view = await services.viewSteward({ liveCap: 12, baselineCap: 8, isPaused: false })

    expect(view.runtimeTuning.acks).toEqual([
      {
        text: 'I bumped implement workers from 11 to 12 because the backlog was sustained.',
        timestamp: '2026-08-01T10:03:34.014Z',
        pair: { from: 11, to: 12 },
      },
    ])
    // Verify all five required top-level sections are present (mirrors StewardViewSchema in ui/)
    expect(view).toHaveProperty('runtimeTuning')
    expect(view).toHaveProperty('workflowPatches')
    expect(view).toHaveProperty('signatureStorm')
    expect(view).toHaveProperty('agentSpec')
    expect(view).toHaveProperty('gateHealth')
  })

  it('uses the getStewardRuntimeState dep when provided', async () => {
    const { httpServer } = await loadModules(repo)

    let capturedRuntime: { liveCap: number; baselineCap: number; isPaused: boolean } | undefined

    const { port, close } = await httpServer.startHttpServer({
      ...makeDeps({
        viewSteward: async (runtime) => {
          capturedRuntime = runtime
          return (await stubAppServices().viewSteward(runtime))
        },
      }),
      getStewardRuntimeState: () => ({ liveCap: 15, baselineCap: 8, isPaused: true }),
    })

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/steward`)
      expect(res.status).toBe(200)
      expect(capturedRuntime).toEqual({ liveCap: 15, baselineCap: 8, isPaused: true })
    } finally {
      await close()
    }
  })

  it('uses fallback runtime state when getStewardRuntimeState is absent', async () => {
    const { httpServer } = await loadModules(repo)

    let capturedRuntime: { liveCap: number; baselineCap: number; isPaused: boolean } | undefined

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewSteward: async (runtime) => {
          capturedRuntime = runtime
          return (await stubAppServices().viewSteward(runtime))
        },
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/steward`)
      expect(res.status).toBe(200)
      // Fallback: liveCap = -1, baselineCap = -1, isPaused = false
      expect(capturedRuntime?.liveCap).toBe(-1)
      expect(capturedRuntime?.baselineCap).toBe(-1)
      expect(capturedRuntime?.isPaused).toBe(false)
    } finally {
      await close()
    }
  })

  it('includes evidence on gate health entries in the response', async () => {
    const { httpServer } = await loadModules(repo)

    const gateWithEvidence = {
      id: 'gate-1',
      scope: '.',
      name: 'typecheck',
      tier: 'task' as const,
      required: true,
      state: 'active' as const,
      source: 'onboarding',
      evidence: 'package.json script "typecheck"',
      command: { cmd: 'npm', args: ['run', 'typecheck'] },
      quarantinedAt: null,
      quarantineSignature: null,
      lastFailureSignature: null,
      lastFailureOriginId: null,
      lastFailureAt: null,
      lastPassAt: null,
    }

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewSteward: async () => ({
          ...(await stubAppServices().viewSteward({ liveCap: 8, baselineCap: 4, isPaused: false })),
          gateHealth: { scopes: [{ scope: '.', gates: [gateWithEvidence] }] },
        }),
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/steward`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { gateHealth: { scopes: Array<{ scope: string; gates: Array<{ evidence: string | null }> }> } }
      const gate = body.gateHealth.scopes[0]?.gates[0]
      expect(gate).toBeDefined()
      expect(gate?.evidence).toBe('package.json script "typecheck"')
    } finally {
      await close()
    }
  })

  it('returns null evidence when a gate has no recorded evidence', async () => {
    const { httpServer } = await loadModules(repo)

    const gateWithoutEvidence = {
      id: 'gate-2',
      scope: '.',
      name: 'lint',
      tier: 'task' as const,
      required: false,
      state: 'active' as const,
      source: 'operator',
      evidence: null,
      command: { cmd: 'npm', args: ['run', 'lint'] },
      quarantinedAt: null,
      quarantineSignature: null,
      lastFailureSignature: null,
      lastFailureOriginId: null,
      lastFailureAt: null,
      lastPassAt: null,
    }

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewSteward: async () => ({
          ...(await stubAppServices().viewSteward({ liveCap: 8, baselineCap: 4, isPaused: false })),
          gateHealth: { scopes: [{ scope: '.', gates: [gateWithoutEvidence] }] },
        }),
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/steward`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { gateHealth: { scopes: Array<{ scope: string; gates: Array<{ evidence: string | null }> }> } }
      const gate = body.gateHealth.scopes[0]?.gates[0]
      expect(gate).toBeDefined()
      expect(gate?.evidence).toBeNull()
    } finally {
      await close()
    }
  })

  it('returns 500 when viewSteward throws', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewSteward: async () => {
          throw new Error('steward data unavailable')
        },
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/steward`)
      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('steward data unavailable')
    } finally {
      await close()
    }
  })
})
