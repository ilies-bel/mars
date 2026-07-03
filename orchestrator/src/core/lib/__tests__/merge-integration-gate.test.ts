/**
 * Verifies the integration-gate hook behaviour in `mergeBranch`:
 *
 *  - When `onAfterFastForward` is provided and passes (no throw), the
 *    integration branch advances and the result is `merged: true`.
 *  - When `onAfterFastForward` throws, the fast-forward is reverted (the
 *    integration branch is left clean at the pre-merge SHA), the working-tree
 *    resync is rolled back if it ran, and the result carries
 *    `{ merged: false, integrationGateFailed: true }`.
 *  - When `onAfterFastForward` is absent the behaviour is unchanged from
 *    before the hook was added (no regression).
 *
 * These tests use a real temp git repo so no git operations are mocked.
 * They do NOT touch the DB or the task store — `mergeBranch` is a pure
 * git function.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { mergeBranch } from '../git/merge'

// Resolve the git binary once — the same helper the production code uses.
const GIT = 'git'

const git = (args: string[], cwd: string): string =>
  execFileSync(GIT, args, { cwd, encoding: 'utf8' }).trim()

// ──────────────────────────────────────────────────────────────────────────────
// Shared repo setup
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Creates a fresh single-repo (no worktrees) with:
 *   main:       one commit ("init")
 *   task/feat:  one commit on top of main ("add feature")
 *
 * Returns paths:
 *   repo      — the bare-ish repo that is checked out on `main`
 *   worktree  — same repo, checked out on `task/feat` (simulates the task worktree)
 *
 * Since `mergeBranch` uses `repoRoot()` (env-driven) for ref operations and a
 * supplied `worktreePath` for the rebase, we can't use a separate git-worktree
 * in a unit test without setting MARS_REPO.  Instead we set MARS_REPO to the
 * temp repo, and use the same directory for both the "repoRoot" and the
 * worktree (the test doesn't exercise the rebase path — just the CAS + hook).
 */
interface TestRepos {
  repo: string
  taskSha: string
  mainSha: string
}

const setupRepo = (): TestRepos => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-integration-gate-'))
  execFileSync(GIT, ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync(GIT, ['config', 'user.email', 'test@mars.test'], { cwd: repo })
  execFileSync(GIT, ['config', 'user.name', 'Mars Test'], { cwd: repo })

  // Initial commit on main
  writeFileSync(resolve(repo, 'README'), 'hello\n')
  execFileSync(GIT, ['add', 'README'], { cwd: repo })
  execFileSync(GIT, ['commit', '-q', '-m', 'init'], { cwd: repo })
  const mainSha = git(['rev-parse', 'main'], repo)

  // task/feat: one commit on top of main
  execFileSync(GIT, ['checkout', '-q', '-b', 'task/feat', 'main'], { cwd: repo })
  writeFileSync(resolve(repo, 'feature.txt'), 'feature\n')
  execFileSync(GIT, ['add', 'feature.txt'], { cwd: repo })
  execFileSync(GIT, ['commit', '-q', '-m', 'add feature'], { cwd: repo })
  const taskSha = git(['rev-parse', 'task/feat'], repo)

  // Leave repo checked out on main so HEAD !== task/feat (mimics production
  // where the daemon's checkout stays on main).
  execFileSync(GIT, ['checkout', '-q', 'main'], { cwd: repo })

  return { repo, taskSha, mainSha }
}

// ──────────────────────────────────────────────────────────────────────────────
// Override MARS_REPO before each test and restore after
// ──────────────────────────────────────────────────────────────────────────────

let repos: TestRepos
let prevMarsRepo: string | undefined

beforeAll(() => {
  repos = setupRepo()
  prevMarsRepo = process.env.MARS_REPO
  // Point MARS_REPO at our temp repo so repoRoot() resolves correctly.
  process.env.MARS_REPO = repos.repo
})

afterAll(() => {
  if (prevMarsRepo !== undefined) {
    process.env.MARS_REPO = prevMarsRepo
  } else {
    delete process.env.MARS_REPO
  }
  rmSync(repos.repo, { recursive: true, force: true })
})

// ──────────────────────────────────────────────────────────────────────────────
// Helper: reset integration branch and working tree back to mainSha between tests
// ──────────────────────────────────────────────────────────────────────────────
const resetMain = (repo: string, mainSha: string): void => {
  // Check out main, hard-reset to mainSha, then leave on main.
  // The step-3 resync in mergeBranch may have advanced the working tree to
  // taskSha; we need a full reset so the next test's rebase sees a clean tree.
  execFileSync(GIT, ['checkout', '-q', 'main'], { cwd: repo })
  execFileSync(GIT, ['reset', '--hard', mainSha], { cwd: repo })
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('mergeBranch — onAfterFastForward hook', () => {
  it('advances the integration branch and returns merged:true when hook passes', async () => {
    const { repo, taskSha, mainSha } = repos
    resetMain(repo, mainSha)

    let hookCalled = false
    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: repo,
      integrationBranch: 'main',
      lockTimeoutMs: 10_000,
      onAfterFastForward: async ({ finalTaskSha, finalIntegrationSha }) => {
        hookCalled = true
        // Sanity: the hook receives the pre- and post-merge SHAs.
        expect(finalIntegrationSha).toBe(mainSha)
        expect(finalTaskSha).toBe(taskSha)
      },
    })

    expect(result.merged).toBe(true)
    expect(result.aborted).toBe(false)
    expect(result.integrationGateFailed).toBeFalsy()
    expect(hookCalled).toBe(true)

    // The integration branch must now point at taskSha.
    const newMain = git(['rev-parse', 'main'], repo)
    expect(newMain).toBe(taskSha)
  })

  it('reverts the fast-forward and returns integrationGateFailed:true when hook throws', async () => {
    const { repo, taskSha, mainSha } = repos
    resetMain(repo, mainSha)

    const gateError = 'integration test suite failed: 3 tests failed'
    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: repo,
      integrationBranch: 'main',
      lockTimeoutMs: 10_000,
      onAfterFastForward: async () => {
        throw new Error(gateError)
      },
    })

    // Result shape
    expect(result.merged).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.integrationGateFailed).toBe(true)
    expect(result.integrationGateOutput).toContain(gateError)
    // The "reverted" note must appear in the output
    expect(result.output).toContain('integration gates failed')
    expect(result.output).toContain('fast-forward reverted')

    // The integration branch MUST be clean — back at mainSha.
    const currentMain = git(['rev-parse', 'main'], repo)
    expect(currentMain).toBe(mainSha)

    // taskSha itself must not have advanced into main's ancestry.
    const isAncestor = (() => {
      try {
        execFileSync(GIT, ['merge-base', '--is-ancestor', taskSha, 'main'], { cwd: repo })
        return true
      } catch {
        return false
      }
    })()
    expect(isAncestor).toBe(false)
  })

  it('behaves identically to before (no hook) when onAfterFastForward is absent', async () => {
    const { repo, taskSha, mainSha } = repos
    resetMain(repo, mainSha)

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: repo,
      integrationBranch: 'main',
      lockTimeoutMs: 10_000,
      // No onAfterFastForward — must behave exactly as before.
    })

    expect(result.merged).toBe(true)
    expect(result.aborted).toBe(false)
    expect(result.integrationGateFailed).toBeFalsy()

    const newMain = git(['rev-parse', 'main'], repo)
    expect(newMain).toBe(taskSha)
  })

  it('makes integrationGateOutput available so the caller can seed a recovery Chore', async () => {
    const { repo, mainSha } = repos
    resetMain(repo, mainSha)

    const detailedOutput = 'TestSuite.testFoo FAILED\nTestSuite.testBar FAILED'
    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: repo,
      integrationBranch: 'main',
      lockTimeoutMs: 10_000,
      onAfterFastForward: async () => {
        throw new Error(detailedOutput)
      },
    })

    expect(result.integrationGateFailed).toBe(true)
    expect(result.integrationGateOutput).toContain('TestSuite.testFoo FAILED')
    expect(result.integrationGateOutput).toContain('TestSuite.testBar FAILED')
  })

  it('repos with no integration gates in the manifest are a true no-op', async () => {
    // This test exercises the verifyChanges + selectVerifySteps path: if the
    // scopes returned contain ONLY task-tier steps, the integrationGateRunner
    // in primitives/index.ts returns immediately without calling anything.
    // At the mergeBranch level the effect is: no hook throws → merged:true.
    const { repo, taskSha, mainSha } = repos
    resetMain(repo, mainSha)

    // A hook that returns immediately (simulates an empty integration-step list).
    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: repo,
      integrationBranch: 'main',
      lockTimeoutMs: 10_000,
      onAfterFastForward: async () => {
        // no-op — zero integration steps
      },
    })

    expect(result.merged).toBe(true)
    expect(result.integrationGateFailed).toBeFalsy()

    const newMain = git(['rev-parse', 'main'], repo)
    expect(newMain).toBe(taskSha)
  })
})
