/**
 * Tests for propose-gates-from-levers.ts — the lever-to-verify-uncovered wirer.
 *
 * Covers the acceptance criteria from PRD 6bbf9f4c slice 8:
 *  - PROPOSE: unregistered lever gates raise verify-uncovered items.
 *  - SKIP-REGISTERED: levers whose gate is already registered are skipped.
 *  - SKIP-OPEN: levers that already have an open verify-uncovered proposal are
 *    skipped on subsequent calls (no duplicate rows).
 *
 * DB setup follows the pattern in verify-uncovered.test.ts: per-test in-memory
 * PGlite clients keyed by a fresh mkdtemp MARS_REPO, torn down in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

let repo: string
let dbModule: typeof import('./db.js')

beforeEach(async () => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-pgl-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  vi.resetModules()
  process.env.MARS_REPO = repo

  dbModule = await import('./db.js')
})

afterEach(async () => {
  await dbModule.__resetDbRegistryForTests()
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

describe('proposeGatesFromLevers', () => {
  it('raises a verify-uncovered item for each lever whose gate is not yet registered', async () => {
    // Register typecheck, lint, and e2e — leave test unregistered.
    const { addVerifyGate } = await import('../verify-gates.js')
    await addVerifyGate({ name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'] })
    await addVerifyGate({ name: 'lint', cmd: 'npx', args: ['eslint', '.'] })
    await addVerifyGate({ name: 'e2e', cmd: 'npx', args: ['playwright', 'test'] })

    const { proposeGatesFromLevers } = await import('./propose-gates-from-levers.js')
    const result = await proposeGatesFromLevers()

    // Only the 'test' lever is unregistered, so exactly 1 proposal should be raised.
    expect(result.proposed).toBe(1)
    // typecheck, lint, e2e are registered — all three are skipped.
    expect(result.skipped).toBe(3)

    // The raised item should carry a proposedGate for the test lever.
    const { listActionQueueItems } = await import('./action-queue.js')
    const items = await listActionQueueItems('open', { kind: 'verify-uncovered' })
    expect(items).toHaveLength(1)
    const item = items[0]!
    expect(item.payload.proposedGate).toMatchObject({
      name: 'test',
      scope: '.',
    })
  })

  it('skips all levers when all gates are already registered', async () => {
    const { addVerifyGate } = await import('../verify-gates.js')
    await addVerifyGate({ name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'] })
    await addVerifyGate({ name: 'test', cmd: 'npm', args: ['test'] })
    await addVerifyGate({ name: 'lint', cmd: 'npx', args: ['eslint', '.'] })
    await addVerifyGate({ name: 'e2e', cmd: 'npx', args: ['playwright', 'test'] })

    const { proposeGatesFromLevers } = await import('./propose-gates-from-levers.js')
    const result = await proposeGatesFromLevers()

    expect(result.proposed).toBe(0)
    expect(result.skipped).toBe(4)

    // No verify-uncovered items should be open.
    const { listActionQueueItems } = await import('./action-queue.js')
    const items = await listActionQueueItems('open', { kind: 'verify-uncovered' })
    expect(items).toHaveLength(0)
  })

  it('skips already-open verify-uncovered items for the same scope and name on repeated calls', async () => {
    // Register typecheck, lint, e2e — leave test unregistered so it becomes
    // the one unambiguous item we can track across two calls.
    const { addVerifyGate } = await import('../verify-gates.js')
    await addVerifyGate({ name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'] })
    await addVerifyGate({ name: 'lint', cmd: 'npx', args: ['eslint', '.'] })
    await addVerifyGate({ name: 'e2e', cmd: 'npx', args: ['playwright', 'test'] })

    const { proposeGatesFromLevers } = await import('./propose-gates-from-levers.js')

    // First call: test is unregistered and no open item exists yet → raised.
    const first = await proposeGatesFromLevers()
    expect(first.proposed).toBe(1)
    expect(first.skipped).toBe(3)

    // Second call: test is still unregistered but the open item already exists
    // with proposedGate.name === 'test' → should be skipped.
    const second = await proposeGatesFromLevers()
    expect(second.proposed).toBe(0)
    expect(second.skipped).toBe(4) // typecheck/lint/e2e (registered) + test (open item)

    // Still exactly one open verify-uncovered item — no duplicates were created.
    const { listActionQueueItems } = await import('./action-queue.js')
    const items = await listActionQueueItems('open', { kind: 'verify-uncovered' })
    expect(items).toHaveLength(1)
  })

  it('each raised item carries proposedGate with lever spec and triggerPattern evidence', async () => {
    // Register everything except typecheck so we can inspect its proposal.
    const { addVerifyGate } = await import('../verify-gates.js')
    await addVerifyGate({ name: 'test', cmd: 'npm', args: ['test'] })
    await addVerifyGate({ name: 'lint', cmd: 'npx', args: ['eslint', '.'] })
    await addVerifyGate({ name: 'e2e', cmd: 'npx', args: ['playwright', 'test'] })

    const { proposeGatesFromLevers } = await import('./propose-gates-from-levers.js')
    await proposeGatesFromLevers()

    const { listActionQueueItems } = await import('./action-queue.js')
    const items = await listActionQueueItems('open', { kind: 'verify-uncovered' })
    expect(items).toHaveLength(1)

    const { proposedGate } = items[0]!.payload as {
      proposedGate?: { name: string; cmd: string; args: string[]; scope: string; evidence: string }
    }
    expect(proposedGate).toBeDefined()
    expect(proposedGate!.name).toBe('typecheck')
    expect(proposedGate!.cmd).toBe('npx')
    expect(proposedGate!.args).toEqual(['tsc', '--noEmit'])
    expect(proposedGate!.scope).toBe('.')
    // Evidence is the lever's triggerPattern.
    expect(typeof proposedGate!.evidence).toBe('string')
    expect(proposedGate!.evidence.length).toBeGreaterThan(0)
  })
})
