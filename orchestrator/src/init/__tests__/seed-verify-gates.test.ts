import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { OnboardingGateInput } from '../seed-verify-gates.js'

let repo: string
let dbModule: typeof import('../../core/lib/db.js')

const detectedGates: OnboardingGateInput[] = [
  {
    scope: 'orchestrator',
    name: 'typecheck',
    cmd: 'npx',
    args: ['tsc', '--noEmit'],
    required: true,
    tier: 'task',
    source: 'detected',
    evidence: 'package.json script "typecheck"',
  },
  {
    scope: 'ui',
    name: 'test',
    cmd: 'npm',
    args: ['test'],
    required: false,
    tier: 'integration',
    source: 'detected',
    evidence: 'package.json script "test"',
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
})

afterEach(async () => {
  await dbModule.__resetDbRegistryForTests()
  delete process.env.MARS_REPO
  delete process.env.MARS_DB_BACKEND
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

describe('proposeOnboardingVerifyGates', () => {
  it('raises one verify-uncovered item per detected gate scope instead of inserting gates', async () => {
    const { proposeOnboardingVerifyGates } = await import('../seed-verify-gates.js')
    const { listActionQueueItems } = await import('../../core/lib/action-queue.js')
    const { listVerifyGates } = await import('../../core/verify-gates.js')

    const result = await proposeOnboardingVerifyGates(detectedGates)

    expect(result).toEqual({ proposed: 2, skipped: false })

    // No gates are inserted into the registry — the operator must confirm each one.
    expect(await listVerifyGates()).toEqual([])

    // One verify-uncovered item per gate (each gate has a distinct scope).
    const items = await listActionQueueItems('open', { kind: 'verify-uncovered' })
    expect(items).toHaveLength(2)
    const payloads = items.map((i) => i.payload.proposedGate)
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'typecheck', scope: 'orchestrator', evidence: 'package.json script "typecheck"' }),
        expect.objectContaining({ name: 'test', scope: 'ui', evidence: 'package.json script "test"' }),
      ]),
    )
  })

  it('accepts an empty detected set without raising any items', async () => {
    const { proposeOnboardingVerifyGates } = await import('../seed-verify-gates.js')
    const { listActionQueueItems } = await import('../../core/lib/action-queue.js')

    expect(await proposeOnboardingVerifyGates([])).toEqual({ proposed: 0, skipped: false })
    const items = await listActionQueueItems('open', { kind: 'verify-uncovered' })
    expect(items).toHaveLength(0)
  })

  it('is a no-op when the registry already has gates (operator-owned)', async () => {
    const { addVerifyGate, listVerifyGates } = await import('../../core/verify-gates.js')
    const { proposeOnboardingVerifyGates } = await import('../seed-verify-gates.js')
    const { listActionQueueItems } = await import('../../core/lib/action-queue.js')

    await addVerifyGate({
      scope: '.',
      name: 'operator-test',
      cmd: 'npm',
      args: ['test'],
      source: 'operator',
      evidence: 'test: unit test fixture',
    })
    const before = await listVerifyGates()

    expect(await proposeOnboardingVerifyGates(detectedGates)).toEqual({ proposed: 0, skipped: true })
    expect(await listVerifyGates()).toEqual(before)

    // No new items raised when skipped.
    const items = await listActionQueueItems('open', { kind: 'verify-uncovered' })
    expect(items).toHaveLength(0)
  })
})
