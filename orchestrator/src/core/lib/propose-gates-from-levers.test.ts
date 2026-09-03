/**
 * Tests for propose-gates-from-levers.ts — the lever-to-verify-uncovered wirer.
 *
 * Covers the acceptance criteria from PRD 6bbf9f4c slice 8:
 *  - PROPOSE: unregistered lever gates raise verify-uncovered items.
 *  - SKIP-REGISTERED: levers whose gate is already registered are skipped.
 *  - SKIP-OPEN: levers that already have an open verify-uncovered proposal are
 *    skipped on subsequent calls (no duplicate rows).
 *
 * Also covers the lever-gate-sweep body (sweeps.ts):
 *  - logs and emits view.action-queue-invalidated when proposed > 0.
 *  - is silent (no log, no emit) when proposed === 0.
 *  - is idempotent: second consecutive run proposes nothing.
 *
 * DB setup follows the pattern in verify-uncovered.test.ts: per-test in-memory
 * PGlite clients keyed by a fresh mkdtemp MARS_REPO, torn down in afterEach.
 */

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { SweepDeps } from '../daemon/sweeps.js'

let repo: string
let dbModule: typeof import('./db.js')

beforeEach(async () => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-pgl-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })

  // Write minimal evidence so every lever predicate passes in tests.
  // Without these files all predicates filter out all levers and
  // proposeGatesFromLevers returns proposed=0 regardless of registration.
  writeFileSync(resolve(repo, 'tsconfig.json'), '{}')           // hasTypeScriptEvidence
  writeFileSync(resolve(repo, '.eslintrc.json'), '{}')           // hasLinterEvidence
  mkdirSync(resolve(repo, 'tests'), { recursive: true })          // hasTestEvidence
  mkdirSync(resolve(repo, 'e2e'), { recursive: true })            // hasPlaywrightEvidence

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
    await addVerifyGate({ name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], evidence: 'test: unit test fixture' })
    await addVerifyGate({ name: 'lint', cmd: 'npx', args: ['eslint', '.'], evidence: 'test: unit test fixture' })
    await addVerifyGate({ name: 'e2e', cmd: 'npx', args: ['playwright', 'test'], evidence: 'test: unit test fixture' })

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
    await addVerifyGate({ name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], evidence: 'test: unit test fixture' })
    await addVerifyGate({ name: 'test', cmd: 'npm', args: ['test'], evidence: 'test: unit test fixture' })
    await addVerifyGate({ name: 'lint', cmd: 'npx', args: ['eslint', '.'], evidence: 'test: unit test fixture' })
    await addVerifyGate({ name: 'e2e', cmd: 'npx', args: ['playwright', 'test'], evidence: 'test: unit test fixture' })

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
    await addVerifyGate({ name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], evidence: 'test: unit test fixture' })
    await addVerifyGate({ name: 'lint', cmd: 'npx', args: ['eslint', '.'], evidence: 'test: unit test fixture' })
    await addVerifyGate({ name: 'e2e', cmd: 'npx', args: ['playwright', 'test'], evidence: 'test: unit test fixture' })

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
    // tsconfig.json is already present from beforeEach — typecheck predicate passes.
    // Register everything except typecheck so we can inspect its proposal.
    const { addVerifyGate } = await import('../verify-gates.js')
    await addVerifyGate({ name: 'test', cmd: 'npm', args: ['test'], evidence: 'test: unit test fixture' })
    await addVerifyGate({ name: 'lint', cmd: 'npx', args: ['eslint', '.'], evidence: 'test: unit test fixture' })
    await addVerifyGate({ name: 'e2e', cmd: 'npx', args: ['playwright', 'test'], evidence: 'test: unit test fixture' })

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

// ---------------------------------------------------------------------------
// lever-gate-sweep body tests
//
// These test the sweep body in isolation (no daemon started). They exercise
// the three observable behaviours the verify criteria require:
//  - logs and emits view.action-queue-invalidated when proposed > 0
//  - is silent (no log, no emit) when proposed === 0
//  - is idempotent: second consecutive run proposes nothing (quiet)
// ---------------------------------------------------------------------------

describe('lever-gate-sweep body', () => {
  /** Locate the lever-gate-sweep entry in SWEEPS without running the daemon. */
  async function getSweep() {
    const { SWEEPS } = await import('../daemon/sweeps.js')
    const sweep = SWEEPS.find((s) => s.name === 'lever-gate-sweep')
    expect(sweep, 'lever-gate-sweep must be present in SWEEPS').toBeDefined()
    return sweep!
  }

  /** Minimal SweepDeps for the sweep body — only log and bus are needed. */
  function makeDeps(log: (...args: unknown[]) => void, bus: EventEmitter): SweepDeps {
    return { log, bus } as unknown as SweepDeps
  }

  it('logs and emits view.action-queue-invalidated when at least one gate is proposed', async () => {
    // All gates unregistered → the sweep will propose at least one.
    const sweep = await getSweep()
    const log = vi.fn()
    const bus = new EventEmitter()
    const emitted: string[] = []
    bus.on('view.action-queue-invalidated', () => emitted.push('invalidated'))

    await sweep.run(makeDeps(log, bus))

    expect(log).toHaveBeenCalledOnce()
    expect(emitted).toHaveLength(1)
  })

  it('does not log or emit when proposed === 0 (all gates already registered)', async () => {
    // Register every gate the lever registry knows about.
    const { addVerifyGate } = await import('../verify-gates.js')
    await addVerifyGate({ name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], evidence: 'test: unit test fixture' })
    await addVerifyGate({ name: 'test', cmd: 'npm', args: ['test'], evidence: 'test: unit test fixture' })
    await addVerifyGate({ name: 'lint', cmd: 'npx', args: ['eslint', '.'], evidence: 'test: unit test fixture' })
    await addVerifyGate({ name: 'e2e', cmd: 'npx', args: ['playwright', 'test'], evidence: 'test: unit test fixture' })

    const sweep = await getSweep()
    const log = vi.fn()
    const bus = new EventEmitter()
    const emitted: string[] = []
    bus.on('view.action-queue-invalidated', () => emitted.push('invalidated'))

    await sweep.run(makeDeps(log, bus))

    expect(log).not.toHaveBeenCalled()
    expect(emitted).toHaveLength(0)
  })

  it('is idempotent: second consecutive run proposes nothing and stays silent', async () => {
    // Register typecheck/lint/e2e — leave only the test gate unregistered so
    // a single distinct verify-uncovered row is raised on the first call.
    // (All global-scope levers share the same changedPaths=['.'] fingerprint and
    // are therefore deduplicated to one DB row. Leaving exactly one unregistered
    // ensures the open row's proposedGate matches that one lever, making the
    // second call's alreadyProposedKeys set complete — i.e. the idempotence
    // guard can recognise it and skip it.)
    const { addVerifyGate } = await import('../verify-gates.js')
    await addVerifyGate({ name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], evidence: 'test: unit test fixture' })
    await addVerifyGate({ name: 'lint', cmd: 'npx', args: ['eslint', '.'], evidence: 'test: unit test fixture' })
    await addVerifyGate({ name: 'e2e', cmd: 'npx', args: ['playwright', 'test'], evidence: 'test: unit test fixture' })

    // First call: proposes test (only unregistered lever).
    const { proposeGatesFromLevers } = await import('./propose-gates-from-levers.js')
    const first = await proposeGatesFromLevers()
    expect(first.proposed).toBe(1)

    // Second call: test's open item is found → proposed=0 (idempotence holds).
    const second = await proposeGatesFromLevers()
    expect(second.proposed).toBe(0)

    // With proposed=0 guaranteed by the function, the sweep body must be silent.
    const sweep = await getSweep()
    const log = vi.fn()
    const bus = new EventEmitter()
    const emitted: string[] = []
    bus.on('view.action-queue-invalidated', () => emitted.push('invalidated'))
    await sweep.run(makeDeps(log, bus))

    expect(log).not.toHaveBeenCalled()
    expect(emitted).toHaveLength(0)
  })
})
