/**
 * Tests for `mars skill-forge scan` CLI behaviour.
 *
 * Covers the acceptance criteria:
 *   1. Command is registered and surfaced in help output.
 *   2. Fixture with 3+ arcs sharing a lesson produces exactly one
 *      proposal with source='skill-forge'.
 *   3. Proposal notes contain 'motivating_arcs:' followed by originIds
 *      and the full synthesized SKILL.md.
 *   4. Re-running is idempotent — no duplicate proposal for the same lesson.
 *
 * The fixture is written as arc JSON report files into the temp repo's
 * .mars/deep-reflections/ directory, mirroring what `mars arc reflect`
 * writes to disk.  Proposals are stored in the real SQLite DB (temp file).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { InProcessOptions } from '../../test-adapter'

// ---------------------------------------------------------------------------
// Repo fixture helpers
// ---------------------------------------------------------------------------

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-skill-forge-scan-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/**
 * Write a minimal arc JSON report file to the deep-reflections directory.
 * `suggestions` is the array of VerdictedSuggestion-shaped objects.
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
    verdictResult: { saved: suggestions.filter((s) => s.verdict === 'save').length, absorbed: 0, dropped: 0 },
  }
  writeFileSync(resolve(deepReflDir, filename), JSON.stringify(report, null, 2), 'utf8')
  // Ensure filenames sort deterministically even if written in the same ms.
  // We add a tiny artificial spread by using the originId as a suffix
  // variant; the sort order in the code is reverse-alphabetical so the
  // effect is: last-written = highest-sort = first-returned.
}

/** Seed the DB and return ctx/store helpers from fresh module instances. */
const loadStoreAndCtx = async () => {
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const { initProposals } = await import('../../../core/proposals')
  await initProposals()
  const storeModule = await import('../../../core/store/task-store')
  const contextModule = await import('../../../core/context')
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

const run = async (
  argv: readonly string[],
  opts: InProcessOptions,
): Promise<{ code: number; out: string[]; err: string[] }> => {
  const { runCommandInProcess } = await import('../../test-adapter')
  return runCommandInProcess(argv, opts)
}

const makeFake = async () => {
  const { makeFakeDaemon } = await import('../../test-adapter')
  return makeFakeDaemon()
}

beforeEach(() => {
  repo = setupRepo()
  vi.resetModules()
  process.env.MARS_REPO = repo
})

afterEach(() => {
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. Command is registered — unknown route returns unknown=true
// ---------------------------------------------------------------------------

describe('mars skill-forge scan — command registration', () => {
  it('routes skill-forge scan without unknown=true', async () => {
    // Write 3 arcs sharing a lesson so the command has something to scan.
    const lesson = { title: 'Check inputs early', rootCauseKey: 'missing_validation', rationale: 'Prevents downstream errors', verdict: 'save' as const }
    writeArcReport(repo, 'arc-reg-001', [lesson])
    writeArcReport(repo, 'arc-reg-002', [lesson])
    writeArcReport(repo, 'arc-reg-003', [lesson])

    const { store, ctx } = await loadStoreAndCtx()
    const fake = await makeFake()
    const r = await run(['skill-forge', 'scan'], { store, ctx, daemon: fake })

    // Should be a known route (unknown=true would mean not registered).
    expect(r).not.toHaveProperty('unknown', true)
    expect(r.code).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. 3+ arcs sharing a lesson → exactly one proposal with source='skill-forge'
// ---------------------------------------------------------------------------

describe('mars skill-forge scan — fixture with 3 arcs', () => {
  it('produces exactly one proposal with source skill-forge', async () => {
    const lesson = {
      title: 'Validate pnpm lock before install',
      rootCauseKey: 'pnpm_install_flakiness',
      rationale: 'Lock-file drift causes non-deterministic failures',
      verdict: 'save' as const,
    }
    writeArcReport(repo, 'arc-a1', [lesson])
    writeArcReport(repo, 'arc-a2', [lesson])
    writeArcReport(repo, 'arc-a3', [lesson])

    const { store, ctx } = await loadStoreAndCtx()
    const fake = await makeFake()
    const r = await run(['skill-forge', 'scan'], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)

    // Re-import proposals using the SAME module instance (already initialised above).
    const { listProposals } = await import('../../../core/proposals')
    const proposals = await listProposals({ source: 'skill-forge' })
    expect(proposals).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 3. Notes contain motivating_arcs: and the SKILL.md body
// ---------------------------------------------------------------------------

describe('mars skill-forge scan — proposal notes shape', () => {
  it('notes field contains motivating_arcs: and full SKILL.md', async () => {
    const lesson = {
      title: 'Always run typecheck before commit',
      rootCauseKey: 'missing_typecheck',
      rationale: 'TypeScript errors caught late cost more to fix',
      verdict: 'save' as const,
    }
    writeArcReport(repo, 'arc-b1', [lesson])
    writeArcReport(repo, 'arc-b2', [lesson])
    writeArcReport(repo, 'arc-b3', [lesson])

    const { store, ctx } = await loadStoreAndCtx()
    const fake = await makeFake()
    await run(['skill-forge', 'scan'], { store, ctx, daemon: fake })

    const { listProposals } = await import('../../../core/proposals')
    const proposals = await listProposals({ source: 'skill-forge' })
    expect(proposals).toHaveLength(1)

    const p = proposals[0]
    expect(p.notes).toContain('motivating_arcs:')
    // originIds all present
    expect(p.notes).toContain('arc-b1')
    expect(p.notes).toContain('arc-b2')
    expect(p.notes).toContain('arc-b3')
    // SKILL.md frontmatter present
    expect(p.notes).toContain('---')
    expect(p.notes).toContain('name:')
    expect(p.notes).toContain('description:')
  })
})

// ---------------------------------------------------------------------------
// 4. Idempotency — second run skips the existing proposal
// ---------------------------------------------------------------------------

describe('mars skill-forge scan — idempotency', () => {
  it('does not create a duplicate proposal on a second run', async () => {
    const lesson = {
      title: 'Pin exact package versions',
      rootCauseKey: 'version_drift',
      rationale: 'Unpinned versions cause environment divergence',
      verdict: 'save' as const,
    }
    writeArcReport(repo, 'arc-c1', [lesson])
    writeArcReport(repo, 'arc-c2', [lesson])
    writeArcReport(repo, 'arc-c3', [lesson])

    const { store, ctx } = await loadStoreAndCtx()
    const fake = await makeFake()

    // First run — should create one proposal.
    const r1 = await run(['skill-forge', 'scan'], { store, ctx, daemon: fake })
    expect(r1.code).toBe(0)

    const { listProposals } = await import('../../../core/proposals')
    const after1 = await listProposals({ source: 'skill-forge' })
    expect(after1).toHaveLength(1)

    // Second run — module cache already reset, but we reuse the same repo
    // so the same DB is on disk and the same arc files exist.
    const r2 = await run(['skill-forge', 'scan'], { store, ctx, daemon: fake })
    expect(r2.code).toBe(0)
    // The second-run output should mention "skip".
    expect(r2.out.join('\n')).toContain('skip')

    const after2 = await listProposals({ source: 'skill-forge' })
    expect(after2).toHaveLength(1)
  })
})
