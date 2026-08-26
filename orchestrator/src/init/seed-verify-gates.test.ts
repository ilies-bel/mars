/**
 * Tests for proposeOnboardingVerifyGates.
 *
 * Verifies the DEC-11 acceptance criteria: onboarding no longer bulk-inserts
 * gates. Instead, each detected gate is raised as a verify-uncovered action
 * queue item so the operator accepts each gate individually.
 *
 * Covered:
 *  - 3 detected gates → 3 action queue items, each carrying the correct
 *    proposedGate payload (name, cmd, args, scope, evidence).
 *  - Non-empty registry → no-op (returns { proposed: 0, skipped: true }).
 *  - Empty detected set → no items raised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { OnboardingGateInput } from './seed-verify-gates.js'

let repo: string
let dbModule: typeof import('../core/lib/db.js')

beforeEach(async () => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-propose-gates-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  vi.resetModules()
  process.env.MARS_REPO = repo
  process.env.MARS_DB_BACKEND = 'pglite'

  dbModule = await import('../core/lib/db.js')
})

afterEach(async () => {
  await dbModule.__resetDbRegistryForTests()
  delete process.env.MARS_REPO
  delete process.env.MARS_DB_BACKEND
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

describe('proposeOnboardingVerifyGates', () => {
  it('raises one verify-uncovered item per detected gate with the full gate spec in proposedGate', async () => {
    const { proposeOnboardingVerifyGates } = await import('./seed-verify-gates.js')
    const { listActionQueueItems } = await import('../core/lib/action-queue.js')

    const threeGates: OnboardingGateInput[] = [
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
      {
        scope: '.',
        name: 'lint',
        cmd: 'npm',
        args: ['run', 'lint'],
        required: true,
        tier: 'task',
        source: 'detected',
        evidence: 'package.json script "lint"',
      },
    ]

    const result = await proposeOnboardingVerifyGates(threeGates)

    expect(result).toEqual({ proposed: 3, skipped: false })

    const items = await listActionQueueItems('open', { kind: 'verify-uncovered' })
    expect(items).toHaveLength(3)

    const proposedGates = items.map((i) => i.payload.proposedGate)
    expect(proposedGates).toEqual(
      expect.arrayContaining([
        {
          name: 'typecheck',
          cmd: 'npx',
          args: ['tsc', '--noEmit'],
          scope: 'orchestrator',
          evidence: 'package.json script "typecheck"',
        },
        {
          name: 'test',
          cmd: 'npm',
          args: ['test'],
          scope: 'ui',
          evidence: 'package.json script "test"',
        },
        {
          name: 'lint',
          cmd: 'npm',
          args: ['run', 'lint'],
          scope: '.',
          evidence: 'package.json script "lint"',
        },
      ]),
    )
  })

  it('is a no-op (skipped: true) when the gate registry already has entries', async () => {
    const { addVerifyGate } = await import('../core/verify-gates.js')
    const { proposeOnboardingVerifyGates } = await import('./seed-verify-gates.js')
    const { listActionQueueItems } = await import('../core/lib/action-queue.js')

    await addVerifyGate({ scope: '.', name: 'test', cmd: 'npm', args: ['test'] })

    const result = await proposeOnboardingVerifyGates([
      { scope: 'orchestrator', name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], evidence: 'detected' },
    ])

    expect(result).toEqual({ proposed: 0, skipped: true })
    // No items raised when guard fires.
    const items = await listActionQueueItems('open', { kind: 'verify-uncovered' })
    expect(items).toHaveLength(0)
  })

  it('raises no items for an empty gate list', async () => {
    const { proposeOnboardingVerifyGates } = await import('./seed-verify-gates.js')
    const { listActionQueueItems } = await import('../core/lib/action-queue.js')

    const result = await proposeOnboardingVerifyGates([])

    expect(result).toEqual({ proposed: 0, skipped: false })
    const items = await listActionQueueItems('open', { kind: 'verify-uncovered' })
    expect(items).toHaveLength(0)
  })

  it('uses evidence from detection; falls back to "detected at onboarding" when absent', async () => {
    const { proposeOnboardingVerifyGates } = await import('./seed-verify-gates.js')
    const { listActionQueueItems } = await import('../core/lib/action-queue.js')

    await proposeOnboardingVerifyGates([
      // no evidence field
      { scope: 'cli', name: 'build', cmd: 'npm', args: ['run', 'build'] },
    ])

    const items = await listActionQueueItems('open', { kind: 'verify-uncovered' })
    expect(items).toHaveLength(1)
    const pg = items[0]!.payload.proposedGate as { evidence: string } | undefined
    expect(pg?.evidence).toBe('detected at onboarding')
  })
})
