import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkMergeTargetStatus } from './git/merge'
import { pathExists } from './git/internal'
import { __resetContextCacheForTests } from '../context'

const execAsync = promisify(execFile)

describe('pathExists', () => {
  let scratch: string

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'mars-git-pathexists-'))
  })

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  it('returns true for an existing file', async () => {
    const file = join(scratch, 'file.txt')
    await writeFile(file, 'hi', 'utf8')
    await expect(pathExists(file)).resolves.toBe(true)
  })

  it('returns true for an existing directory', async () => {
    const dir = join(scratch, 'dir')
    await mkdir(dir)
    await expect(pathExists(dir)).resolves.toBe(true)
  })

  it('returns false for a path that does not exist', async () => {
    const ghost = join(scratch, 'does-not-exist')
    await expect(pathExists(ghost)).resolves.toBe(false)
  })

  it('returns false for an empty string', async () => {
    await expect(pathExists('')).resolves.toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Helpers shared by checkMergeTargetStatus tests
// ---------------------------------------------------------------------------

/** Initialise a bare-minimum git repo in `dir` with one initial commit. */
async function initRepo(dir: string): Promise<void> {
  await execAsync('git', ['init', '-b', 'main'], { cwd: dir })
  await execAsync('git', ['config', 'user.email', 'test@mars.local'], { cwd: dir })
  await execAsync('git', ['config', 'user.name', 'Mars Test'], { cwd: dir })
  // An initial commit is required so branch names resolve to commits.
  await writeFile(join(dir, 'README.md'), 'init')
  await execAsync('git', ['add', 'README.md'], { cwd: dir })
  await execAsync('git', ['commit', '-m', 'initial'], { cwd: dir })
}

/** Create a branch and add one commit that writes `fileName` with `content`. */
async function addBranchCommit(
  dir: string,
  branch: string,
  fileName: string,
  content: string,
): Promise<void> {
  await execAsync('git', ['checkout', '-b', branch], { cwd: dir })
  await writeFile(join(dir, fileName), content)
  await execAsync('git', ['add', fileName], { cwd: dir })
  await execAsync('git', ['commit', '-m', `add ${fileName}`], { cwd: dir })
}

// ---------------------------------------------------------------------------
// checkMergeTargetStatus
// ---------------------------------------------------------------------------

describe('checkMergeTargetStatus', () => {
  let repoDir: string
  const origMarsRepo = process.env.MARS_REPO

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'mars-check-merge-'))
    await initRepo(repoDir)

    // Point the orchestrator context at the tmp repo so repoRoot() resolves
    // to repoDir instead of the real project root.
    process.env.MARS_REPO = repoDir
    __resetContextCacheForTests()
  })

  afterEach(async () => {
    if (origMarsRepo === undefined) {
      delete process.env.MARS_REPO
    } else {
      process.env.MARS_REPO = origMarsRepo
    }
    __resetContextCacheForTests()
    await rm(repoDir, { recursive: true, force: true })
  })

  it('returns kind:needs-rebase when integration branch has moved past the task branch base', async () => {
    // task/abc is created from main, adds one commit, then main advances
    // → main is no longer an ancestor of task/abc (diverged)
    await addBranchCommit(repoDir, 'task/abc', 'task-work.txt', 'task')
    // Back on main, advance it
    await execAsync('git', ['checkout', 'main'], { cwd: repoDir })
    await writeFile(join(repoDir, 'main-extra.txt'), 'extra')
    await execAsync('git', ['add', 'main-extra.txt'], { cwd: repoDir })
    await execAsync('git', ['commit', '-m', 'advance main'], { cwd: repoDir })

    const result = await checkMergeTargetStatus({
      integrationBranch: 'main',
      taskBranch: 'task/abc',
    })

    expect(result.kind).toBe('needs-rebase')
    if (result.kind === 'needs-rebase') {
      expect(result.statusOutput).toMatch(/not a fast-forward/)
    }
  })

  it('returns kind:dirty when tracked files on ff paths have uncommitted changes on integration', async () => {
    // shared.txt exists on main; task/abc modifies it; main has an
    // uncommitted modification of the same file → tracked-dirty
    await writeFile(join(repoDir, 'shared.txt'), 'original')
    await execAsync('git', ['add', 'shared.txt'], { cwd: repoDir })
    await execAsync('git', ['commit', '-m', 'add shared'], { cwd: repoDir })

    // task/abc modifies shared.txt (main IS an ancestor of task/abc)
    await addBranchCommit(repoDir, 'task/abc', 'shared.txt', 'modified by task')

    // Back on main: dirty (tracked) modification, NOT committed
    await execAsync('git', ['checkout', 'main'], { cwd: repoDir })
    await writeFile(join(repoDir, 'shared.txt'), 'dirty on main')

    const result = await checkMergeTargetStatus({
      integrationBranch: 'main',
      taskBranch: 'task/abc',
    })

    expect(result.kind).toBe('dirty')
    if (result.kind === 'dirty') {
      expect(result.statusOutput).toContain('tracked changes on paths')
    }
  })

  it('returns kind:clean when integration is an ancestor of task branch and working tree is clean', async () => {
    // task/abc adds a new file that doesn't exist on main → the diff path is
    // untracked on integration → status is empty → clean
    await addBranchCommit(repoDir, 'task/abc', 'new-feature.txt', 'feature work')
    await execAsync('git', ['checkout', 'main'], { cwd: repoDir })

    const result = await checkMergeTargetStatus({
      integrationBranch: 'main',
      taskBranch: 'task/abc',
    })

    expect(result.kind).toBe('clean')
  })
})
