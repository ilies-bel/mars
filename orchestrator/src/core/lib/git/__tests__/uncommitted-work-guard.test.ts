/**
 * The uncommitted-work probe behind the `mars restart` / `mars drop` guards.
 *
 * Both verbs already refused a branch with commits ahead, but commits-ahead is
 * only half the exposure: a worktree can sit at ahead=0 and still hold the
 * entire substance of the task uncommitted. That is the normal shape of a
 * `context-exhausted` failure, where the coder was killed mid-task rather than
 * bailing. On 2026-08-20 mars-70dc2672 held 145 uncommitted lines across three
 * files and two sibling tasks held 8 and 4 files, all at ahead=0 — one command
 * away from either verb, with nothing in the failure record to warn anyone.
 *
 * These run against a REAL git worktree, not a stubbed `git status`: the whole
 * value of the guard is that it agrees with what git actually reports, and a
 * stub would happily pass while the real porcelain parse was wrong.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describeUncommittedWork, listUncommittedPaths } from '../worktree'

let repo: string
let wtPath: string

beforeEach(() => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-dirty-guard-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'initial commit'], { cwd: repo })

  const wtDir = resolve(repo, 'worktrees')
  mkdirSync(wtDir, { recursive: true })
  wtPath = resolve(wtDir, 'task-1')
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'task/task-1', wtPath, 'main'], {
    cwd: repo,
  })
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('listUncommittedPaths', () => {
  it('returns [] for a clean worktree', async () => {
    expect(await listUncommittedPaths(wtPath)).toEqual([])
  })

  it('lists untracked and modified paths alike', async () => {
    writeFileSync(resolve(wtPath, 'new.ts'), 'export const a = 1\n')
    writeFileSync(resolve(wtPath, 'README.md'), 'edited\n')

    const paths = await listUncommittedPaths(wtPath)
    expect(paths).not.toBeNull()
    expect([...(paths ?? [])].sort()).toEqual(['README.md', 'new.ts'])
  })

  it('does not count work the coder already committed', async () => {
    writeFileSync(resolve(wtPath, 'committed.ts'), 'export const done = true\n')
    execFileSync('git', ['add', '-A'], { cwd: wtPath })
    execFileSync('git', ['commit', '-q', '-m', 'coder commit'], { cwd: wtPath })

    expect(await listUncommittedPaths(wtPath)).toEqual([])
  })

  it('returns null — not [] — when the path cannot be inspected', async () => {
    // `null` means "I could not look". The guards must never read that as
    // "there is nothing there", which is exactly how a probe failure would
    // turn into silent data loss.
    expect(await listUncommittedPaths(resolve(repo, 'no-such-worktree'))).toBeNull()
    expect(await listUncommittedPaths(null)).toBeNull()
    expect(await listUncommittedPaths(undefined)).toBeNull()
  })
})

describe('describeUncommittedWork', () => {
  it('returns null for a clean worktree so the verb proceeds', async () => {
    expect(
      await describeUncommittedWork({ verb: 'drop', taskId: 'mars-1', worktreePath: wtPath }),
    ).toBeNull()
  })

  it('returns null when the worktree is gone so the verb can still clean up', async () => {
    expect(
      await describeUncommittedWork({ verb: 'drop', taskId: 'mars-1', worktreePath: null }),
    ).toBeNull()
  })

  it('names the count, every path, and both ways out', async () => {
    writeFileSync(resolve(wtPath, 'checkpoint.ts'), 'a\n')
    writeFileSync(resolve(wtPath, 'coder-exit.ts'), 'b\n')
    writeFileSync(resolve(wtPath, 'merge.ts'), 'c\n')

    const refusal = await describeUncommittedWork({
      verb: 'drop',
      taskId: 'mars-70dc2672',
      worktreePath: wtPath,
    })

    expect(refusal).toContain('refusing to drop task mars-70dc2672')
    expect(refusal).toContain('3 uncommitted path(s)')
    expect(refusal).toContain('checkpoint.ts')
    expect(refusal).toContain('coder-exit.ts')
    expect(refusal).toContain('merge.ts')
    expect(refusal).toContain('mars continue mars-70dc2672')
    expect(refusal).toContain('--force')
  })

  it('names the verb it was asked about', async () => {
    writeFileSync(resolve(wtPath, 'work.ts'), 'a\n')

    const restartRefusal = await describeUncommittedWork({
      verb: 'restart',
      taskId: 'mars-1',
      worktreePath: wtPath,
    })
    expect(restartRefusal).toContain('refusing to restart task mars-1')
    expect(restartRefusal).toContain('restart would destroy')
  })
})
