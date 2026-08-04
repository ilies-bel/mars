import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { VerifyGateInput } from '../../core/verify-gates.js'

let repo: string
let dbModule: typeof import('../../core/lib/db.js')

const detectedGates: VerifyGateInput[] = [
  {
    scope: 'orchestrator',
    name: 'typecheck',
    cmd: 'npx',
    args: ['tsc', '--noEmit'],
    required: true,
    tier: 'task',
    source: 'detected',
  },
  {
    scope: 'ui',
    name: 'test',
    cmd: 'npm',
    args: ['test'],
    required: false,
    tier: 'integration',
    source: 'detected',
  },
]

beforeEach(async () => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-onboarding-gates-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  vi.resetModules()
  process.env.MARS_REPO = repo
  process.env.MARS_DB_BACKEND = 'pglite'

  dbModule = await import('../../core/lib/db.js')
  const client = dbModule.openDb(resolve(repo, '.mars'))
  const { ensureVerifyGatesSchema } = await import('../../core/verify-gates.js')
  await ensureVerifyGatesSchema(client)
})

afterEach(async () => {
  await dbModule.__resetDbRegistryForTests()
  delete process.env.MARS_REPO
  delete process.env.MARS_DB_BACKEND
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

describe('installOnboardingVerifyGates', () => {
  it('installs every detected gate as an active onboarding gate', async () => {
    const { installOnboardingVerifyGates } = await import('../seed-verify-gates.js')
    const { listVerifyGates } = await import('../../core/verify-gates.js')

    const result = await installOnboardingVerifyGates(detectedGates)

    expect(result).toEqual({ inserted: 2, skipped: false })
    expect(await listVerifyGates()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'orchestrator',
          name: 'typecheck',
          cmd: 'npx',
          args: ['tsc', '--noEmit'],
          required: true,
          tier: 'task',
          source: 'onboarding',
          state: 'active',
        }),
        expect.objectContaining({
          scope: 'ui',
          name: 'test',
          cmd: 'npm',
          args: ['test'],
          required: false,
          tier: 'integration',
          source: 'onboarding',
          state: 'active',
        }),
      ]),
    )
  })

  it('accepts an empty detected set without creating gates', async () => {
    const { installOnboardingVerifyGates } = await import('../seed-verify-gates.js')
    const { listVerifyGates } = await import('../../core/verify-gates.js')

    expect(await installOnboardingVerifyGates([])).toEqual({ inserted: 0, skipped: false })
    expect(await listVerifyGates()).toEqual([])
  })

  it('leaves an operator-managed registry entirely unchanged on a later init', async () => {
    const { addVerifyGate, listVerifyGates } = await import('../../core/verify-gates.js')
    const { installOnboardingVerifyGates } = await import('../seed-verify-gates.js')
    await addVerifyGate({
      scope: '.',
      name: 'operator-test',
      cmd: 'npm',
      args: ['test'],
      source: 'operator',
    })
    const before = await listVerifyGates()

    expect(await installOnboardingVerifyGates(detectedGates)).toEqual({ inserted: 0, skipped: true })
    expect(await listVerifyGates()).toEqual(before)
  })
})
