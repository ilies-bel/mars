/**
 * Real-git regression test for `isBranchPatchLandedInIntegration`.
 *
 * Root incident (mars-a98bec46): a recovery task attached to an origin's
 * branch, committed, and fast-forward-merged those commits into `main`, then
 * died before the origin settled. A later `mars remerge <origin>` found the
 * origin's branch still carrying commits not reachable from `main` by SHA
 * (the recovery's commits landed under different SHAs via a sibling path),
 * passed the existing SHA-reachability guard, and only discovered the
 * problem after setup's rebase onto `main` silently dropped every commit as
 * "already applied" — at which point the merge gate could no longer tell
 * "already landed" apart from "coder never committed" and failed the task.
 *
 * `isBranchPatchLandedInIntegration` exists to catch this BEFORE that
 * rebase runs, using `git cherry` (patch-id) instead of SHA reachability.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { isBranchPatchLandedInIntegration } from '../merge'

let repoDir: string

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim()

const commitFile = (name: string, contents: string, message: string): void => {
  writeFileSync(resolve(repoDir, name), contents)
  git('add', name)
  git('commit', '-m', message)
}

beforeAll(() => {
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-merge-patch-landed-'))
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@mars.local')
  git('config', 'user.name', 'Mars Test')
  git('config', 'commit.gpgsign', 'false')
  commitFile('base.txt', 'base', 'initial commit')
})

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true })
})

describe('isBranchPatchLandedInIntegration', () => {
  it('returns true when every commit ahead is patch-equivalent to one already on main', async () => {
    git('branch', 'task/landed')
    git('checkout', 'task/landed')
    commitFile('feature.txt', 'feature content', 'implement feature')
    git('checkout', 'main')

    // Simulate a sibling recovery task landing the identical diff on main
    // under a DIFFERENT commit SHA. Re-committing the same content with a
    // different message is the deterministic way to do this: patch-id is
    // computed from the diff alone, so it matches, while the differing
    // message guarantees a distinct commit object.
    //
    // NOT `git cherry-pick task/landed` — cherry-picking a commit whose
    // parent is already HEAD reproduces a byte-identical commit object (same
    // tree, parent, author, message; committer date usually lands in the same
    // second), so the "copy" silently comes out with the SAME SHA. That makes
    // `main..task/landed` empty and this whole scenario untestable — a race
    // that passes or fails on which second the two commits land in.
    commitFile('feature.txt', 'feature content', 'sibling recovery: land the same diff')

    const result = await isBranchPatchLandedInIntegration('task/landed', 'main', repoDir)
    expect(result).toBe(true)
  })

  it('returns false when the branch has commits with no upstream equivalent', async () => {
    git('branch', 'task/genuine')
    git('checkout', 'task/genuine')
    commitFile('genuine.txt', 'genuinely new work', 'implement genuinely new work')
    git('checkout', 'main')

    const result = await isBranchPatchLandedInIntegration('task/genuine', 'main', repoDir)
    expect(result).toBe(false)
  })

  it('returns false when the branch has no commits ahead at all (nothing to compare)', async () => {
    git('branch', 'task/empty')

    const result = await isBranchPatchLandedInIntegration('task/empty', 'main', repoDir)
    expect(result).toBe(false)
  })

  it('returns false when only SOME commits ahead are patch-equivalent', async () => {
    git('branch', 'task/mixed')
    git('checkout', 'task/mixed')
    commitFile('mixed-a.txt', 'a', 'mixed commit a')
    commitFile('mixed-b.txt', 'b', 'mixed commit b')
    git('checkout', 'main')

    // Land only the FIRST commit's patch on main under a new SHA (same
    // same-diff/different-message trick as above).
    commitFile('mixed-a.txt', 'a', 'sibling recovery: land only mixed commit a')

    const result = await isBranchPatchLandedInIntegration('task/mixed', 'main', repoDir)
    expect(result).toBe(false)
  })
})
