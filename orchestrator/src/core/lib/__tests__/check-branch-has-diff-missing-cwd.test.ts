/**
 * Regression test: "worktree removed during verify" scenario.
 *
 * Before the fix, a missing worktree directory caused checkBranchHasDiff to
 * return `output: "git rev-list failed: runTool: spawn git ENOENT"` — an opaque
 * message that looked identical to "git binary not on PATH". Post-mortem required
 * manual re-derivation to tell the two apart.
 *
 * After the fix, the output reads `has-diff: worktree path <cwd> no longer
 * exists` so the failure cause is immediately clear in the task error field.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { checkBranchHasDiff } from '../git'

describe('checkBranchHasDiff — worktree removed during verify', () => {
  let repo: string

  beforeAll(() => {
    // Set up a minimal git repo with a branch so git rev-list would normally
    // succeed. We then delete the repo directory to simulate the worktree
    // being removed while verify is running.
    repo = mkdtempSync(resolve(tmpdir(), 'mars-has-diff-cwd-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@mars'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Mars Test'], { cwd: repo })
    // Create an initial commit so HEAD is valid.
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo })
    execFileSync('git', ['checkout', '-b', 'task/test-branch'], { cwd: repo })
    // Remove the repo to simulate a deleted worktree.
    rmSync(repo, { recursive: true, force: true })
  })

  afterEach(() => {
    // repo already gone — nothing to clean up
  })

  it('returns a named has-diff failure when cwd no longer exists', async () => {
    const result = await checkBranchHasDiff(repo, 'task/test-branch', 'main')

    expect(result.name).toBe('has-diff')
    expect(result.passed).toBe(false)
    expect(result.output).toContain('worktree path')
    expect(result.output).toContain('no longer exists')
    expect(result.output).toContain(repo)
    // Must NOT contain the old opaque error that looks like a PATH problem.
    expect(result.output).not.toContain('spawn git ENOENT')
    expect(result.output).not.toContain('git rev-list failed')
  })
})
