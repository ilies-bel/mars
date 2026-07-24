/**
 * Verifies that `mergeBranch` fires `onPhase` for the expected sub-phases in order.
 *
 * Uses a real temp git repo (no git operations mocked). Does NOT touch the DB
 * or task store — `mergeBranch` is a pure git function, and `onPhase` is an
 * optional best-effort callback.
 *
 * Phases tested for a clean fast-forward:
 *   acquire-lock → rebase → fast-forward
 *
 * Phases tested when onAfterFastForward is also provided:
 *   acquire-lock → rebase → fast-forward → integration-gate
 *
 * Best-effort guarantee tested: an onPhase that throws must never abort a merge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { mergeBranch } from '../git/merge'

const GIT = 'git'

const git = (args: string[], cwd: string): string =>
  execFileSync(GIT, args, { cwd, encoding: 'utf8' }).trim()

interface TestRepo {
  repo: string
  taskSha: string
  mainSha: string
}

const setupRepo = (dir: string): TestRepo => {
  const repo = mkdtempSync(resolve(dir, 'mars-on-phase-'))
  execFileSync(GIT, ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync(GIT, ['config', 'user.email', 'test@mars.test'], { cwd: repo })
  execFileSync(GIT, ['config', 'user.name', 'Mars Test'], { cwd: repo })

  writeFileSync(resolve(repo, 'README'), 'hello\n')
  execFileSync(GIT, ['add', 'README'], { cwd: repo })
  execFileSync(GIT, ['commit', '-q', '-m', 'init'], { cwd: repo })
  const mainSha = git(['rev-parse', 'main'], repo)

  execFileSync(GIT, ['checkout', '-q', '-b', 'task/feat', 'main'], { cwd: repo })
  writeFileSync(resolve(repo, 'feature.txt'), 'feature\n')
  execFileSync(GIT, ['add', 'feature.txt'], { cwd: repo })
  execFileSync(GIT, ['commit', '-q', '-m', 'add feature'], { cwd: repo })
  const taskSha = git(['rev-parse', 'task/feat'], repo)

  execFileSync(GIT, ['checkout', '-q', 'main'], { cwd: repo })

  return { repo, taskSha, mainSha }
}

// ── Shared setup / teardown ───────────────────────────────────────────────────

let tmpDir: string
let testRepo: TestRepo
const originalMarsRepo = process.env.MARS_REPO
const originalMarsState = process.env.MARS_STATE_DIR

beforeAll(() => {
  tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-on-phase-suite-'))
  testRepo = setupRepo(tmpDir)
  process.env.MARS_REPO = testRepo.repo
  process.env.MARS_STATE_DIR = testRepo.repo
})

afterAll(() => {
  if (originalMarsRepo !== undefined) process.env.MARS_REPO = originalMarsRepo
  else delete process.env.MARS_REPO
  if (originalMarsState !== undefined) process.env.MARS_STATE_DIR = originalMarsState
  else delete process.env.MARS_STATE_DIR
  try { rmSync(tmpDir, { recursive: true }) } catch { /* ignore */ }
})

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Reset main to mainSha and re-create task/feat on top of it so tests are idempotent. */
const resetRepo = (repo: string, mainSha: string): void => {
  // Hard-reset main back to the initial commit
  git(['checkout', '-q', 'main'], repo)
  git(['reset', '--hard', mainSha], repo)
  // Re-create task/feat if it already exists at the right spot
  try {
    git(['branch', '-D', 'task/feat'], repo)
  } catch { /* branch may not exist */ }
  git(['checkout', '-q', '-b', 'task/feat', mainSha], repo)
  writeFileSync(resolve(repo, 'feature.txt'), 'feature\n')
  git(['add', 'feature.txt'], repo)
  git(['commit', '-q', '-m', 'add feature'], repo)
  git(['checkout', '-q', 'main'], repo)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('mergeBranch – onPhase callback', () => {
  it('fires acquire-lock, rebase, fast-forward in order for a clean fast-forward', async () => {
    const { repo, mainSha } = testRepo
    resetRepo(repo, mainSha)

    const phases: string[] = []

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: repo,
      integrationBranch: 'main',
      lockTimeoutMs: 10_000,
      watchdogMs: 30_000,
      onPhase: (phase) => { phases.push(phase) },
    })

    expect(result.merged).toBe(true)
    expect(phases).toContain('acquire-lock')
    expect(phases).toContain('rebase')
    expect(phases).toContain('fast-forward')
    // Verify ordering: acquire-lock must come before rebase, rebase before fast-forward
    const lockIdx = phases.indexOf('acquire-lock')
    const rebaseIdx = phases.indexOf('rebase')
    const ffIdx = phases.indexOf('fast-forward')
    expect(lockIdx).toBeLessThan(rebaseIdx)
    expect(rebaseIdx).toBeLessThan(ffIdx)
  })

  it('fires integration-gate after fast-forward when onAfterFastForward is provided', async () => {
    const { repo, mainSha } = testRepo
    resetRepo(repo, mainSha)

    const phases: string[] = []

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: repo,
      integrationBranch: 'main',
      lockTimeoutMs: 10_000,
      watchdogMs: 30_000,
      onPhase: (phase) => { phases.push(phase) },
      onAfterFastForward: async () => {
        // no-op gate — passes immediately
      },
    })

    expect(result.merged).toBe(true)
    expect(phases).toContain('integration-gate')
    const ffIdx = phases.indexOf('fast-forward')
    const gateIdx = phases.indexOf('integration-gate')
    expect(ffIdx).toBeLessThan(gateIdx)
  })

  it('completes merge successfully even when onPhase throws', async () => {
    const { repo, mainSha } = testRepo
    resetRepo(repo, mainSha)

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: repo,
      integrationBranch: 'main',
      lockTimeoutMs: 10_000,
      watchdogMs: 30_000,
      onPhase: (_phase) => {
        throw new Error('onPhase reporting failure — must not abort merge')
      },
    })

    expect(result.merged).toBe(true)
  })

  it('completes merge successfully even when onPhase returns a rejected promise', async () => {
    const { repo, mainSha } = testRepo
    resetRepo(repo, mainSha)

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: repo,
      integrationBranch: 'main',
      lockTimeoutMs: 10_000,
      watchdogMs: 30_000,
      onPhase: async (_phase) => {
        throw new Error('async onPhase failure — must not abort merge')
      },
    })

    expect(result.merged).toBe(true)
  })
})
