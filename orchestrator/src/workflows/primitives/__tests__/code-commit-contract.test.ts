/**
 * Coder commit contract — the `code` step's post-condition.
 *
 * Regression cover for task fix-30ac0aaa: a coder that committed some work and
 * left other paths uncommitted was classified `clean-with-commits`, passed the
 * code step, passed verify (has-diff only counts commits), and first surfaced
 * two steps later as `merge/unclassified`. It is still classified
 * `dirty-with-commits` here — but the code step now recovers it (corrective
 * turn, then the auto-commit net) instead of failing the task; see
 * `auto-commit-uncommitted.test.ts` for the end-to-end behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  detectPostCoderState,
  coderUncommittedFailure,
  CODER_UNCOMMITTED_STEP,
  CODER_UNCOMMITTED_SIGNATURE,
} from '../shared'
import { computeFailureSignature } from '../../../core/lib/failure-signature'

describe('coder commit contract', () => {
  let repo: string

  const git = (...argv: string[]): string =>
    execFileSync('git', argv, { cwd: repo, encoding: 'utf8' })

  const commitAll = (message: string): void => {
    git('add', '-A')
    git('commit', '-q', '-m', message)
  }

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-commit-contract-'))
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    writeFileSync(resolve(repo, 'tracked.ts'), 'export const a = 1\n')
    commitAll('init')
    git('checkout', '-q', '-b', 'task/X', 'main')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('passes a clean worktree that is ahead of the integration branch', async () => {
    writeFileSync(resolve(repo, 'feature.ts'), 'export const b = 2\n')
    commitAll('feat: real work')

    const state = await detectPostCoderState({
      worktreePath: repo,
      integrationBranch: 'main',
    })

    // The gate only fires on a `dirty-*` kind, so this is the passing shape.
    expect(state.kind).toBe('clean-with-commits')
    if (state.kind === 'clean-with-commits') {
      expect(state.commitsAhead).toBe(1)
    }
  })

  it('classifies unstaged modifications alongside commits and names the offending files', async () => {
    writeFileSync(resolve(repo, 'feature.ts'), 'export const b = 2\n')
    commitAll('feat: real work')
    // The shape that used to slip through: committed work AND a leftover
    // modification to a tracked file.
    writeFileSync(resolve(repo, 'tracked.ts'), 'export const a = 99\n')

    const state = await detectPostCoderState({
      worktreePath: repo,
      integrationBranch: 'main',
    })

    expect(state.kind).toBe('dirty-with-commits')
    if (state.kind !== 'dirty-with-commits') return
    expect(state.dirtyFiles).toEqual(['tracked.ts'])
    expect(state.commitsAhead).toBe(1)

    const errorOutput = coderUncommittedFailure({
      taskId: 'mars-1234abcd',
      worktreePath: repo,
      branch: 'task/X',
      integrationBranch: 'main',
      dirtyFiles: state.dirtyFiles,
      commitsAhead: state.commitsAhead,
      autoCommitReason: 'git commit failed: pre-commit hook rejected',
    })
    // The offending file list rides along in the failure reason.
    expect(errorOutput).toContain('tracked.ts')
    expect(errorOutput).toContain(repo)
    expect(errorOutput).toContain('pre-commit hook rejected')
    // The stamped signature and the one the durable recovery-spawn path
    // recomputes from (failing step, error output) must agree — and it must be
    // the ONE signature that failure-kinds.ts and fix-recipes.ts register.
    expect(computeFailureSignature(CODER_UNCOMMITTED_STEP, errorOutput)).toBe(
      CODER_UNCOMMITTED_SIGNATURE,
    )
    expect(CODER_UNCOMMITTED_SIGNATURE).toBe('code/uncommitted-changes')
    expect(CODER_UNCOMMITTED_SIGNATURE).not.toMatch(/unclassified/)
  })

  it('classifies staged-but-uncommitted changes as dirty', async () => {
    writeFileSync(resolve(repo, 'feature.ts'), 'export const b = 2\n')
    commitAll('feat: real work')
    writeFileSync(resolve(repo, 'staged.ts'), 'export const c = 3\n')
    git('add', 'staged.ts')

    const state = await detectPostCoderState({
      worktreePath: repo,
      integrationBranch: 'main',
    })

    expect(state.kind).toBe('dirty-with-commits')
    if (state.kind === 'dirty-with-commits') {
      expect(state.dirtyFiles).toEqual(['staged.ts'])
    }
  })

  it('classifies a worktree whose only dirt is untracked files as dirty', async () => {
    writeFileSync(resolve(repo, 'feature.ts'), 'export const b = 2\n')
    commitAll('feat: real work')
    mkdirSync(resolve(repo, 'src'), { recursive: true })
    writeFileSync(resolve(repo, 'src', 'scratch.ts'), 'export const d = 4\n')

    const state = await detectPostCoderState({
      worktreePath: repo,
      integrationBranch: 'main',
    })

    expect(state.kind).toBe('dirty-with-commits')
    if (state.kind === 'dirty-with-commits') {
      expect(state.dirtyFiles).toEqual(['src/scratch.ts'])
    }
  })

  it('still reports untracked-only dirt with zero commits as dirty-no-commits', async () => {
    // Unchanged behaviour: this shape is auto-committed upstream of the gate.
    writeFileSync(resolve(repo, 'scratch.ts'), 'export const e = 5\n')

    const state = await detectPostCoderState({
      worktreePath: repo,
      integrationBranch: 'main',
    })

    expect(state.kind).toBe('dirty-no-commits')
  })

  it('honours a non-main integration branch (INTEGRATION_BRANCH override)', async () => {
    // `INTEGRATION_BRANCH` reaches the code primitive as the workflow input's
    // `integrationBranch` (startDaemon reads the env var once and threads it
    // through), so the branch comparison must never be hardcoded to `main`.
    writeFileSync(resolve(repo, 'feature.ts'), 'export const b = 2\n')
    commitAll('feat: first slice')
    // The release line already carries the first slice; `main` does not.
    git('branch', 'release/next', 'task/X')
    writeFileSync(resolve(repo, 'feature2.ts'), 'export const c = 3\n')
    commitAll('feat: second slice')
    writeFileSync(resolve(repo, 'tracked.ts'), 'export const a = 99\n')

    const againstRelease = await detectPostCoderState({
      worktreePath: repo,
      integrationBranch: 'release/next',
    })
    const againstMain = await detectPostCoderState({
      worktreePath: repo,
      integrationBranch: 'main',
    })

    // Same tree, two integration branches: 1 ahead of `release/next`, 2 ahead
    // of `main`. The count follows the branch that was passed in.
    expect(againstRelease.kind).toBe('dirty-with-commits')
    expect(againstMain.kind).toBe('dirty-with-commits')
    if (
      againstRelease.kind !== 'dirty-with-commits' ||
      againstMain.kind !== 'dirty-with-commits'
    ) {
      return
    }
    expect(againstRelease.commitsAhead).toBe(1)
    expect(againstMain.commitsAhead).toBe(2)
    expect(againstRelease.dirtyFiles).toEqual(['tracked.ts'])

    const errorOutput = coderUncommittedFailure({
      taskId: 'mars-1234abcd',
      worktreePath: repo,
      branch: 'task/X',
      integrationBranch: 'release/next',
      dirtyFiles: againstRelease.dirtyFiles,
      commitsAhead: againstRelease.commitsAhead,
      autoCommitReason: 'git commit failed: nothing to commit',
    })
    // The override is named in the failure reason, and the signature is the
    // same specific one regardless of which branch is the merge target.
    expect(errorOutput).toContain('release/next')
    expect(errorOutput).not.toContain('integration branch: main')
    expect(computeFailureSignature(CODER_UNCOMMITTED_STEP, errorOutput)).toBe(
      CODER_UNCOMMITTED_SIGNATURE,
    )
  })
})
