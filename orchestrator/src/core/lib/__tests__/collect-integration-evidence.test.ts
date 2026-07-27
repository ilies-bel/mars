/**
 * Unit tests for `collectIntegrationEvidence`.
 *
 * Three scenarios in a real temp git repo:
 *   (a) Branch fully merged into main → commits and files are populated.
 *   (b) Branch never merged → empty arrays.
 *   (c) Branch with a mix of merged and unmerged commits → only the merged
 *       commits surface.
 *
 * mars uses fast-forward-only merges, so merged task commits appear in the
 * integration branch with the same SHAs. The helper exploits this via a
 * branch-reflog-based creation-point lookup followed by SHA intersection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { collectIntegrationEvidence } from '../collect-integration-evidence'

/** Initialise a bare git repo with a single "init" commit on main. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-cie-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  return repo
}

/** Add a file and commit it on the current branch. Returns the full SHA. */
const addFileAndCommit = (
  repo: string,
  filename: string,
  message: string,
): string => {
  writeFileSync(resolve(repo, filename), `// ${filename}\n`)
  execFileSync('git', ['add', filename], { cwd: repo })
  execFileSync('git', ['commit', '-m', message], { cwd: repo })
  return execSync('git rev-parse HEAD', { cwd: repo }).toString().trim()
}

describe('collectIntegrationEvidence', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  // ── (a) Branch fully merged into main ──────────────────────────────────────
  it('returns commits and files when the branch was fully merged into integrationBranch', async () => {
    // Create task branch and add two commits.
    execFileSync('git', ['checkout', '-b', 'task/foo'], { cwd: repo })
    const shaA = addFileAndCommit(repo, 'feature-a.ts', 'add feature A')
    const shaB = addFileAndCommit(repo, 'feature-b.ts', 'add feature B')

    // Fast-forward main to the branch tip.
    execFileSync('git', ['checkout', 'main'], { cwd: repo })
    execFileSync('git', ['merge', '--ff-only', 'task/foo'], { cwd: repo })

    // Advance main with a post-merge commit (so branch is behind main).
    addFileAndCommit(repo, 'post-merge.ts', 'post-merge work')

    // Branch still exists locally (as happens during a force-purge).
    const evidence = await collectIntegrationEvidence('task/foo', 'main', repo)

    // Both task commits should be found.
    const shas = evidence.commits.map((c) => c.sha)
    expect(shas).toContain(shaA)
    expect(shas).toContain(shaB)

    // Touched files should include both task files.
    expect(evidence.touchedFiles).toContain('feature-a.ts')
    expect(evidence.touchedFiles).toContain('feature-b.ts')

    // shortSha is the first 7 chars of sha.
    const commitA = evidence.commits.find((c) => c.sha === shaA)
    expect(commitA?.shortSha).toBe(shaA.slice(0, 7))
    expect(commitA?.subject).toBe('add feature A')

    // post-merge.ts is NOT a task file — should not appear.
    expect(evidence.touchedFiles).not.toContain('post-merge.ts')
  })

  // ── (b) Branch never merged ─────────────────────────────────────────────────
  it('returns empty arrays when the branch was never merged into integrationBranch', async () => {
    // Advance main separately (so it has a commit the branch does not share as task work).
    addFileAndCommit(repo, 'main-work.ts', 'main work')

    // Create task branch and add commits — never merged.
    execFileSync('git', ['checkout', '-b', 'task/bar'], { cwd: repo })
    addFileAndCommit(repo, 'unmerged-a.ts', 'unmerged A')
    addFileAndCommit(repo, 'unmerged-b.ts', 'unmerged B')

    execFileSync('git', ['checkout', 'main'], { cwd: repo })

    const evidence = await collectIntegrationEvidence('task/bar', 'main', repo)

    expect(evidence.commits).toHaveLength(0)
    expect(evidence.touchedFiles).toHaveLength(0)
  })

  // ── (c) Mix of merged and unmerged commits ──────────────────────────────────
  it('returns only merged commits when the branch has a mix of merged and unmerged commits', async () => {
    // Create task branch with three commits.
    execFileSync('git', ['checkout', '-b', 'task/baz'], { cwd: repo })
    const shaA = addFileAndCommit(repo, 'part-a.ts', 'part A')
    const shaB = addFileAndCommit(repo, 'part-b.ts', 'part B')
    addFileAndCommit(repo, 'part-c.ts', 'part C') // will NOT be merged

    // Fast-forward main to commit B only (use the branch's grandparent-of-tip).
    // task/baz~1 = parent of tip = shaB commit.
    execFileSync('git', ['checkout', 'main'], { cwd: repo })
    execFileSync('git', ['merge', '--ff-only', 'task/baz~1'], { cwd: repo })

    // Add an unrelated commit on main (so main has moved past the merge point).
    addFileAndCommit(repo, 'main-extra.ts', 'main extra')

    // Branch still exists locally pointing at its tip (including unmerged commit C).
    const evidence = await collectIntegrationEvidence('task/baz', 'main', repo)

    const shas = evidence.commits.map((c) => c.sha)

    // A and B were merged → they should appear.
    expect(shas).toContain(shaA)
    expect(shas).toContain(shaB)
    expect(evidence.touchedFiles).toContain('part-a.ts')
    expect(evidence.touchedFiles).toContain('part-b.ts')

    // C was not merged → must not appear.
    expect(evidence.touchedFiles).not.toContain('part-c.ts')
    // main-extra.ts belongs to a later commit on main, not to the task branch.
    expect(evidence.touchedFiles).not.toContain('main-extra.ts')
  })

  // ── Edge: branch does not exist ─────────────────────────────────────────────
  it('returns empty arrays without throwing when the branch does not exist', async () => {
    const evidence = await collectIntegrationEvidence('task/nonexistent', 'main', repo)
    expect(evidence.commits).toHaveLength(0)
    expect(evidence.touchedFiles).toHaveLength(0)
  })
})
