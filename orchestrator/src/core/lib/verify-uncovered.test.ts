/**
 * Tests for verify-uncovered.ts — the `verify-uncovered` action-queue raiser.
 *
 * Covers the original acceptance criteria from PRD c0f8699c slice 2:
 *  - RAISE: the first no-coverage result raises exactly one open row.
 *  - DEDUP: a repeat call with the same (normalised, sorted) paths reuses the
 *    row via fingerprint, incrementing seen_count rather than inserting a new
 *    row (even if the task id differs).
 *  - RESOLVE: the payload carries `scope` and `changedPaths` in the shape that
 *    `resolveCoveredVerifyAlerts` can match — proven by adding a covering gate
 *    and asserting the row flips to `resolved`.
 *  - ERROR ISOLATION: a raise failure re-throws (the function does NOT swallow)
 *    so callers can `.catch()` it; the error never propagates into the verdict.
 *
 * DB setup follows the pattern in `verify-gates.test.ts`: per-test in-memory
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
  repo = mkdtempSync(resolve(tmpdir(), 'mars-vu-test-'))
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

describe('reportUncoveredVerifyCoverage', () => {
  it('raises exactly one open verify-uncovered item on first no-coverage result', async () => {
    const { reportUncoveredVerifyCoverage } = await import('./verify-uncovered.js')
    const { listActionQueueItems } = await import('./action-queue.js')

    await reportUncoveredVerifyCoverage({
      changedPaths: ['orchestrator/src/core/queue.ts'],
      taskId: 'mars-test01',
    })

    const items = await listActionQueueItems('open', { kind: 'verify-uncovered' })
    expect(items).toHaveLength(1)

    const item = items[0]
    expect(item).toBeDefined()
    expect(item!.kind).toBe('verify-uncovered')
    expect(item!.status).toBe('open')
    expect(item!.raisedBy).toBe('verify:no-gate-coverage')
    expect(item!.payload.changedPaths).toEqual(['orchestrator/src/core/queue.ts'])
    expect(item!.payload.scope).toBe('orchestrator/src/core/queue.ts')
    expect(item!.payload.recipe).toBeNull()
  })

  it('deduplicates by fingerprint: repeat call with same paths reuses the row', async () => {
    const { reportUncoveredVerifyCoverage } = await import('./verify-uncovered.js')
    const { listActionQueueItems } = await import('./action-queue.js')

    const paths = ['orchestrator/src/core/arc.ts', 'orchestrator/src/core/queue.ts']

    // First task raises the row
    await reportUncoveredVerifyCoverage({ changedPaths: paths, taskId: 'mars-test01' })
    // Second task, different id but same file set (order reversed — must normalise)
    await reportUncoveredVerifyCoverage({
      changedPaths: [...paths].reverse(),
      taskId: 'mars-test02',
    })

    const items = await listActionQueueItems('open', { kind: 'verify-uncovered' })
    // Still only one row — dedup by fingerprint, not by task id
    expect(items).toHaveLength(1)
    expect(items[0]!.seenCount).toBe(2)
  })

  it('payload scope and changedPaths are shaped for resolveCoveredVerifyAlerts: adding a gate resolves the row', async () => {
    const { reportUncoveredVerifyCoverage } = await import('./verify-uncovered.js')
    const { listActionQueueItems } = await import('./action-queue.js')
    const { addVerifyGate } = await import('../verify-gates.js')

    const changedPaths = [
      'orchestrator/src/core/arc.ts',
      'orchestrator/src/core/queue.ts',
    ]
    await reportUncoveredVerifyCoverage({ changedPaths, taskId: 'mars-test01' })

    // Confirm the row is open before adding the gate
    let open = await listActionQueueItems('open', { kind: 'verify-uncovered' })
    expect(open).toHaveLength(1)

    // Adding a gate at the common directory scope resolves the row:
    // scope for changedPaths above is 'orchestrator/src/core' (common prefix).
    // resolveCoveredVerifyAlerts checks: changedPaths.every(p => p.startsWith('orchestrator/src/core/'))
    await addVerifyGate({
      scope: 'orchestrator/src/core',
      name: 'typecheck',
      cmd: 'npx',
      args: ['tsc', '--noEmit'],
    })

    open = await listActionQueueItems('open', { kind: 'verify-uncovered' })
    expect(open).toHaveLength(0)

    // Row exists in resolved state
    const all = await listActionQueueItems('all', { kind: 'verify-uncovered' })
    expect(all).toHaveLength(1)
    expect(all[0]!.status).toBe('resolved')
  })

  it('a root gate resolves a cross-directory verify-uncovered row', async () => {
    const { reportUncoveredVerifyCoverage } = await import('./verify-uncovered.js')
    const { listActionQueueItems } = await import('./action-queue.js')
    const { addVerifyGate } = await import('../verify-gates.js')

    // Files span unrelated directories → scope derives to '.'
    const changedPaths = ['cli/src/commands.ts', 'orchestrator/src/core/queue.ts']
    await reportUncoveredVerifyCoverage({ changedPaths })

    const open = await listActionQueueItems('open', { kind: 'verify-uncovered' })
    expect(open).toHaveLength(1)
    expect(open[0]!.payload.scope).toBe('.')

    // Adding a root gate (scope '.') covers everything
    await addVerifyGate({ name: 'lint', cmd: 'npx', args: ['eslint', '.'] })

    const stillOpen = await listActionQueueItems('open', { kind: 'verify-uncovered' })
    expect(stillOpen).toHaveLength(0)
  })

  it('is a no-op for an empty changedPaths list', async () => {
    const { reportUncoveredVerifyCoverage } = await import('./verify-uncovered.js')
    const { listActionQueueItems } = await import('./action-queue.js')

    await reportUncoveredVerifyCoverage({ changedPaths: [] })

    const items = await listActionQueueItems('open', { kind: 'verify-uncovered' })
    expect(items).toHaveLength(0)
  })

  it('re-throws on DB failure so callers must .catch() it', async () => {
    // Import action-queue first so the spy lives on the same module instance
    // that verify-uncovered.ts uses (ES module live bindings propagate the mock).
    const aq = await import('./action-queue.js')

    const { reportUncoveredVerifyCoverage } = await import('./verify-uncovered.js')

    // The function re-throws — it does NOT swallow the error.
    vi.spyOn(aq, 'raiseActionQueueItem').mockRejectedValueOnce(new Error('DB failure'))
    await expect(
      reportUncoveredVerifyCoverage({ changedPaths: ['foo.ts'] }),
    ).rejects.toThrow('DB failure')

    // The caller-side .catch() pattern (as used in review.ts) swallows it cleanly.
    // Set up a second rejection for this second call.
    let caught = false
    vi.spyOn(aq, 'raiseActionQueueItem').mockRejectedValueOnce(new Error('DB failure 2'))
    await reportUncoveredVerifyCoverage({ changedPaths: ['foo.ts'] }).catch(() => {
      caught = true
    })
    expect(caught).toBe(true)
  })
})
