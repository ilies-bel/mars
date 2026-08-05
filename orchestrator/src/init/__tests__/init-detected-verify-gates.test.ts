import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { makeFakeDaemon, runCommandInProcess } from '../../cli/test-adapter.js'
import { detectVerifyGates } from '../detect-verify-gates.js'
import type { DomainTaskStore } from '../../core/store/task-store.js'
import type { OrchestratorContext } from '../../core/context.js'

let repo: string

beforeEach(() => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-init-detected-gates-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  writeFileSync(
    resolve(repo, 'package.json'),
    JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' } }),
  )
  process.env.MARS_REPO = repo
  process.env.MARS_DB_BACKEND = 'pglite'
})

afterEach(async () => {
  const dbModule = await import('../../core/lib/db.js')
  await dbModule.__resetDbRegistryForTests()
  delete process.env.MARS_REPO
  delete process.env.MARS_DB_BACKEND
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

const initCommandOptions = async (): Promise<{
  store: DomainTaskStore
  ctx: OrchestratorContext
}> => {
  vi.resetModules()
  const queueModule = await import('../../core/queue.js')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../core/store/task-store.js')
  const contextModule = await import('../../core/context.js')
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

describe('mars init --yes', () => {
  it('detects verify gates before sending the non-interactive init request without reading stdin', async () => {
    const expected = detectVerifyGates(repo)
    const daemon = makeFakeDaemon(() => ({ status: 'ok', message: 'init complete', written: [] }))
    const { store, ctx } = await initCommandOptions()

    const result = await runCommandInProcess(['init', '--yes', '--skip-doctor'], {
      store,
      ctx,
      daemon,
    })

    expect(result.code).toBe(0)
    expect(daemon.calls).toHaveLength(1)
    expect(daemon.calls[0]).toMatchObject({
      op: 'init',
      opts: { wizardChoices: { verifyGates: expected } },
    })
  })

  it('persists the detected set through the init workflow as onboarding gates', async () => {
    vi.resetModules()
    const { detectVerifyGates: detect } = await import('../detect-verify-gates.js')
    const { runInit } = await import('../../workflows/init-workflow.js')
    const { listVerifyGates } = await import('../../core/verify-gates.js')
    const detected = detect(repo)

    const result = await runInit({
      force: false,
      dryRun: false,
      wizardChoices: { registerProject: false, verifyGates: detected },
    })

    expect(result.status).toBe('ok')
    expect(await listVerifyGates()).toEqual(
      detected.map(({ evidence: _evidence, source: _source, ...gate }) =>
        expect.objectContaining({ ...gate, source: 'onboarding', state: 'active' }),
      ),
    )
  })
})
