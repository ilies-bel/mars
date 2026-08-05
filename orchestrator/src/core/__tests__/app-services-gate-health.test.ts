import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

let repo: string
let dbModule: typeof import('../lib/db.js')

const createRepo = (): string => {
  const directory = mkdtempSync(resolve(tmpdir(), 'mars-app-services-gate-health-'))
  execFileSync('git', ['init', '-q'], { cwd: directory })
  mkdirSync(resolve(directory, '.mars'), { recursive: true })
  return directory
}

const createServices = async () => {
  const { createAppServices } = await import('../app-services.js')
  const { nullTraceStore } = await import('../lib/run-tool.js')
  return createAppServices({
    traceStore: nullTraceStore,
    buildAlertSources: async () => ({
      listFailedArcs: async () => [],
      listStaleWorktrees: async () => [],
      listVerifyUncovered: async () => [],
    }),
  })
}

beforeEach(async () => {
  repo = createRepo()
  vi.resetModules()
  process.env.MARS_REPO = repo
  dbModule = await import('../lib/db.js')
  const { runCompositionRootMigrations } = await import('../store/task-store.js')
  await runCompositionRootMigrations()
})

afterEach(async () => {
  await dbModule.__resetDbRegistryForTests()
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

describe('AppServices.viewSteward gate health', () => {
  it('groups active and quarantined gates by scope and exposes their latest failure evidence', async () => {
    const { addVerifyGate, listVerifyGates, quarantineVerifyGate } = await import('../verify-gates.js')
    const { getCompositionRootClient } = await import('../store/task-store.js')
    await addVerifyGate({ scope: 'apps/web', name: 'test', cmd: 'npm', args: ['test'] })
    const typecheck = await addVerifyGate({ scope: '.', name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'] })
    await addVerifyGate({ scope: '.', name: 'lint', cmd: 'eslint', required: false, source: 'operator' })
    await quarantineVerifyGate(
      getCompositionRootClient(),
      typecheck,
      'verify:typecheck:exit-1',
      'origin-123',
    )

    const view = await (await createServices()).viewSteward({
      liveCap: 4,
      baselineCap: 2,
      isPaused: false,
    })

    expect(view.gateHealth.scopes).toEqual([
      {
        scope: '.',
        gates: [
          expect.objectContaining({
            scope: '.',
            name: 'lint',
            state: 'active',
            command: { cmd: 'eslint', args: [] },
            quarantineSignature: null,
            lastFailureSignature: null,
            lastFailureOriginId: null,
            quarantinedAt: null,
            lastFailureAt: null,
          }),
          expect.objectContaining({
            id: typecheck,
            scope: '.',
            name: 'typecheck',
            tier: 'task',
            required: true,
            state: 'quarantined',
            source: 'human',
            command: { cmd: 'npx', args: ['tsc', '--noEmit'] },
            quarantineSignature: 'verify:typecheck:exit-1',
            lastFailureSignature: 'verify:typecheck:exit-1',
            lastFailureOriginId: 'origin-123',
            quarantinedAt: expect.any(Number),
            lastFailureAt: expect.any(Number),
          }),
        ],
      },
      {
        scope: 'apps/web',
        gates: [
          expect.objectContaining({
            scope: 'apps/web',
            name: 'test',
            state: 'active',
          }),
        ],
      },
    ])
    await expect(listVerifyGates()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: typecheck,
        state: 'quarantined',
        lastFailureSignature: 'verify:typecheck:exit-1',
        lastFailureOriginId: 'origin-123',
      }),
    ]))
  })

  it('returns no gate-health scopes in a fresh repository', async () => {
    const view = await (await createServices()).viewSteward({
      liveCap: 4,
      baselineCap: 2,
      isPaused: false,
    })

    expect(view.gateHealth.scopes).toEqual([])
  })
})
