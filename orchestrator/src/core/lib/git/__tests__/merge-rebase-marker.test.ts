/**
 * Verifies that `mergeBranch` writes the rebase-in-progress marker
 * (`<worktreePath>.rebase-in-progress.json`) before starting a `git rebase`
 * and removes it when the merge completes (successfully or on abort).
 *
 * WHY: an orphaned `git rebase` left in a live task worktree is invisible to
 * the agent running inside it — `git rev-parse --show-toplevel` still returns
 * the correct path, masking the fact that the tree has been mutated underneath
 * the agent. The marker turns this from an undetectable hazard into a
 * discoverable condition: an agent that finds a stopped rebase can check for
 * the sibling file and know the orchestrator started it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { mergeBranch, rebaseMarkerPath } from '../merge'
import { __resetContextCacheForTests } from '../../../context'

let repoDir: string
let worktreeDir: string
let prevMarsRepo: string | undefined

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim()

const gitW = (...args: string[]): string =>
  execFileSync('git', args, { cwd: worktreeDir, encoding: 'utf8' }).trim()

const commitFile = (
  name: string,
  contents: string,
  message: string,
  dir = repoDir,
): void => {
  writeFileSync(resolve(dir, name), contents)
  execFileSync('git', ['add', name], { cwd: dir })
  execFileSync('git', ['commit', '-m', message], { cwd: dir })
}

const markerExists = async (): Promise<boolean> => {
  try {
    await stat(rebaseMarkerPath(worktreeDir))
    return true
  } catch {
    return false
  }
}

const readMarker = async (): Promise<Record<string, unknown>> => {
  const raw = await readFile(rebaseMarkerPath(worktreeDir), 'utf8')
  return JSON.parse(raw) as Record<string, unknown>
}

beforeAll(() => {
  // Bare parent repo + linked worktree for the task branch.
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-rebase-marker-'))
  worktreeDir = resolve(repoDir, '.mars', 'worktrees', 'task-marker-test')

  prevMarsRepo = process.env.MARS_REPO
  process.env.MARS_REPO = repoDir
  __resetContextCacheForTests()

  git('init', '-b', 'main')
  git('config', 'user.email', 'test@mars.local')
  git('config', 'user.name', 'Mars Test')
  git('config', 'commit.gpgsign', 'false')

  // Initial commit on main.
  commitFile('base.txt', 'base', 'initial commit on main')

  // Create the task branch off main.
  git('checkout', '-b', 'task/marker-test')
  commitFile('task.txt', 'task work', 'task commit')

  // Back to main — the worktree will be the task branch.
  git('checkout', 'main')

  // Add the linked worktree for the task branch.
  execFileSync('git', ['worktree', 'add', worktreeDir, 'task/marker-test'], { cwd: repoDir })
})

afterAll(() => {
  if (prevMarsRepo !== undefined) {
    process.env.MARS_REPO = prevMarsRepo
  } else {
    delete process.env.MARS_REPO
  }
  __resetContextCacheForTests()
  rmSync(repoDir, { recursive: true, force: true })
})

describe('mergeBranch — rebase-in-progress marker', () => {
  it('writes the marker before git rebase and removes it on successful merge', async () => {
    // Sanity: marker must not exist before the test.
    expect(await markerExists()).toBe(false)

    let markerFoundDuringMerge = false
    let markerContent: Record<string, unknown> | null = null

    const result = await mergeBranch({
      branch: 'task/marker-test',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 10_000,
      // onBeforeFastForward fires AFTER the rebase and BEFORE the lock is
      // released, while the merge body async fn is still in flight. At this
      // point the marker should be present with correct JSON content.
      onBeforeFastForward: async () => {
        markerFoundDuringMerge = await markerExists()
        if (markerFoundDuringMerge) {
          markerContent = await readMarker()
        }
      },
    })

    expect(result.merged).toBe(true)
    expect(markerFoundDuringMerge).toBe(true)

    // Marker content must identify the branch, target, and worktree path so
    // an agent that finds a stopped rebase can determine who started it.
    expect(markerContent).not.toBeNull()
    // Narrow away null so the remaining assertions work without casts.
    const mc = markerContent!
    expect(mc).toMatchObject({
      branch: 'task/marker-test',
      integrationBranch: 'main',
      worktreePath: worktreeDir,
    })
    // startedAt must be a valid ISO timestamp string.
    expect(typeof mc['startedAt']).toBe('string')
    expect(new Date(mc['startedAt'] as string).toISOString()).toBe(mc['startedAt'])

    // After mergeBranch returns the inner finally must have removed the marker.
    expect(await markerExists()).toBe(false)
  })

  it('removes the marker even when the merge aborts (no-op: branch already merged)', async () => {
    // After the previous test, task/marker-test is fully merged into main.
    // The already-merged short-circuit returns before the rebase — no marker
    // should be written in this case.
    expect(await markerExists()).toBe(false)

    const result = await mergeBranch({
      branch: 'task/marker-test',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 10_000,
    })

    // Should be the already-merged no-op (merged:true, no new work).
    expect(result.merged).toBe(true)
    // Marker must still be absent — the early return path is safe too.
    expect(await markerExists()).toBe(false)
  })
})
