/**
 * Integration test: `mars reflect` skill-forge tail.
 *
 * Verifies that a successful `mars reflect` run calls the skill-forge scanner
 * and emits "skill-forge: filed N draft(s)" on stdout. The reflector chain is
 * stubbed to avoid network/AI calls; the skill-forge scan runs for real against
 * arc fixture files written to the temp repo.
 *
 * Acceptance criteria covered:
 *   1. After persistSuggestions, reflect emits /^skill-forge: filed \d+ draft\(s\)$/
 *   2. The filed count matches real proposals created in the DB.
 *   3. MARS_REFLECT_DISABLED=1 short-circuit is covered by reflect-session.test.ts
 *      (spawnSync-based); that invariant is not re-tested here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'

// ─── Module stubs (hoisted before any imports) ────────────────────────────────
// Prevent actual AI/reflector calls while keeping skill-forge real.

vi.mock('../../core/lib/reflect-query', () => ({
  loadRecentTaskCorpus: vi.fn(),
}))

vi.mock('../../core/lib/reflector', () => ({
  runReflector: vi.fn(),
  persistSuggestions: vi.fn(),
}))

vi.mock('../../core/lib/kpi-snapshots.js', () => ({
  readLatestKpiSnapshot: vi.fn(),
}))

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-reflect-sf-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/**
 * Write a minimal arc JSON report into the temp repo's deep-reflections dir,
 * mirroring what `mars arc reflect` produces on disk.
 */
const writeArcReport = (
  repoDir: string,
  originId: string,
  suggestions: Array<{
    title: string
    rootCauseKey: string
    rationale: string
    verdict: 'save' | 'absorb' | 'drop'
  }>,
): void => {
  const deepReflDir = resolve(repoDir, '.mars', 'deep-reflections')
  mkdirSync(deepReflDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `arc-${originId}-${ts}.json`
  const report = {
    originId,
    recordedAt: new Date().toISOString(),
    status: 'complete',
    report: { suggestions },
    sourceTaskId: `task-${originId}`,
    verdictResult: {
      saved: suggestions.filter((s) => s.verdict === 'save').length,
      absorbed: 0,
      dropped: 0,
    },
  }
  writeFileSync(resolve(deepReflDir, filename), JSON.stringify(report, null, 2), 'utf8')
}

// ─── Per-test state ───────────────────────────────────────────────────────────

let repo: string

beforeEach(async () => {
  repo = setupRepo()
  vi.resetModules() // clear module caches so context picks up fresh MARS_REPO
  process.env.MARS_REPO = repo

  // Re-configure default mock values after module reset (factory creates fresh
  // vi.fn() instances, so we configure them here rather than in the factory).
  const { loadRecentTaskCorpus } = await import('../../core/lib/reflect-query')
  vi.mocked(loadRecentTaskCorpus).mockResolvedValue({
    entries: [{ taskId: 'task-seed-default' } as never],
    costSummary: { totalWeightedTokens: 100, successCount: 1, failureCount: 0 },
  } as never)

  const { runReflector, persistSuggestions } = await import('../../core/lib/reflector')
  vi.mocked(runReflector).mockResolvedValue({
    suggestions: [{ title: 'Default suggestion', rationale: 'reason' }],
    exitCode: 0,
    tokenAnalysis: null,
  } as never)
  vi.mocked(persistSuggestions).mockResolvedValue(undefined)

  const { readLatestKpiSnapshot } = await import('../../core/lib/kpi-snapshots.js')
  vi.mocked(readLatestKpiSnapshot).mockResolvedValue(null)
})

afterEach(() => {
  delete process.env.MARS_REPO
  vi.clearAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeInProcessDeps = async (repoDir: string) => {
  const { initProposals } = await import('../../core/proposals')
  await initProposals()

  const contextModule = await import('../../core/context')
  const ctx = contextModule.resolveContext(repoDir) as OrchestratorContext

  const fakeStore = {
    insertReflectionTask: vi.fn().mockResolvedValue('src-task-reflect'),
  } as unknown as DomainTaskStore

  const { runCommandInProcess, makeFakeDaemon } = await import('../test-adapter')
  return { runCommandInProcess, makeFakeDaemon, ctx, fakeStore }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('mars reflect — skill-forge tail: 3+ arcs sharing a lesson', () => {
  it('emits "skill-forge: filed N draft(s)" and creates proposals', async () => {
    // Seed 3 arc fixture files sharing a recurring lesson.
    const lesson = {
      title: 'Always validate inputs before processing',
      rootCauseKey: 'missing_input_validation',
      rationale: 'Prevents downstream data corruption and hard-to-trace bugs',
      verdict: 'save' as const,
    }
    writeArcReport(repo, 'arc-sf-001', [lesson])
    writeArcReport(repo, 'arc-sf-002', [lesson])
    writeArcReport(repo, 'arc-sf-003', [lesson])

    const { runCommandInProcess, makeFakeDaemon, ctx, fakeStore } =
      await makeInProcessDeps(repo)

    const r = await runCommandInProcess(['reflect'], {
      store: fakeStore,
      ctx,
      daemon: makeFakeDaemon(),
    })

    expect(r.code).toBe(0)

    // Exactly one stdout line must match the pattern.
    const matchingLines = r.out.filter((line) =>
      /^skill-forge: filed \d+ draft\(s\)$/.test(line),
    )
    expect(matchingLines).toHaveLength(1)

    // Filed count must be ≥ 1 (1 lesson across 3 arcs → 1 proposal).
    const match = matchingLines[0].match(/filed (\d+) draft/)
    expect(Number(match![1])).toBeGreaterThanOrEqual(1)

    // The proposals DB must contain exactly one skill-forge proposal.
    const { listProposals } = await import('../../core/proposals')
    const proposals = await listProposals({ source: 'skill-forge' })
    expect(proposals).toHaveLength(1)
  })
})

describe('mars reflect — skill-forge tail: no arc fixtures', () => {
  it('emits "skill-forge: filed 0 draft(s)" when no arc data exists', async () => {
    // No arc files written — skill-forge scans and finds nothing.
    const { runCommandInProcess, makeFakeDaemon, ctx, fakeStore } =
      await makeInProcessDeps(repo)

    const r = await runCommandInProcess(['reflect'], {
      store: fakeStore,
      ctx,
      daemon: makeFakeDaemon(),
    })

    expect(r.code).toBe(0)

    const matchingLines = r.out.filter((line) =>
      /^skill-forge: filed \d+ draft\(s\)$/.test(line),
    )
    expect(matchingLines).toHaveLength(1)
    expect(matchingLines[0]).toBe('skill-forge: filed 0 draft(s)')
  })
})
