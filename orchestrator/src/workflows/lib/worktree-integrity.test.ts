/**
 * Unit tests for checkWorktreeIntegrity using real tmp git repos.
 *
 * Each test creates a minimal git repository (or worktree) via shell commands,
 * then verifies that checkWorktreeIntegrity returns the expected discriminated
 * result. No mocks — the function runs against the real `git` binary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { checkWorktreeIntegrity } from './worktree-integrity'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Initialise a bare-minimum git repo with a root commit and return its path. */
async function makeGitRepo(base: string): Promise<string> {
  const repoDir = await mkdtemp(join(base, 'repo-'))
  await execFileAsync('git', ['-C', repoDir, 'init'])
  await execFileAsync('git', ['-C', repoDir, 'config', 'user.email', 'test@test.com'])
  await execFileAsync('git', ['-C', repoDir, 'config', 'user.name', 'Test'])
  // Create a root commit so HEAD exists.
  await writeFile(join(repoDir, 'README.md'), 'hello')
  await execFileAsync('git', ['-C', repoDir, 'add', '.'])
  await execFileAsync('git', ['-C', repoDir, 'commit', '-m', 'root'])
  return repoDir
}

/** Return the current HEAD branch name for a repo. */
async function currentBranch(repoDir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', [
    '-C',
    repoDir,
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ])
  return stdout.trim()
}

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let tmpBase: string

beforeEach(async () => {
  tmpBase = await mkdtemp(join(tmpdir(), 'wt-integrity-'))
})

afterEach(async () => {
  await rm(tmpBase, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkWorktreeIntegrity', () => {
  it('returns ok:true for a valid worktree on the expected branch', async () => {
    const repoDir = await makeGitRepo(tmpBase)
    const branch = await currentBranch(repoDir)

    const result = await checkWorktreeIntegrity(repoDir, branch)
    expect(result).toEqual({ ok: true })
  })

  it('returns missing-dir when the directory does not exist', async () => {
    const nonExistent = join(tmpBase, 'does-not-exist')

    const result = await checkWorktreeIntegrity(nonExistent, 'main')
    expect(result).toEqual({ ok: false, reason: 'missing-dir' })
  })

  it('returns not-a-worktree when the directory exists but is not a git repo', async () => {
    const plainDir = await mkdtemp(join(tmpBase, 'plain-'))
    // plain-dir has no .git

    const result = await checkWorktreeIntegrity(plainDir, 'main')
    expect(result).toEqual({ ok: false, reason: 'not-a-worktree' })
  })

  it('returns wrong-branch when HEAD is on a different branch', async () => {
    const repoDir = await makeGitRepo(tmpBase)
    const currentHead = await currentBranch(repoDir)
    const wrongBranch = currentHead === 'main' ? 'other-branch' : 'main'

    const result = await checkWorktreeIntegrity(repoDir, wrongBranch)
    expect(result).toEqual({ ok: false, reason: 'wrong-branch' })
  })

  it('returns missing-node-modules when package.json exists but node_modules does not', async () => {
    const repoDir = await makeGitRepo(tmpBase)
    const branch = await currentBranch(repoDir)

    // Add a package.json but no node_modules.
    await writeFile(join(repoDir, 'package.json'), JSON.stringify({ name: 'test' }))

    const result = await checkWorktreeIntegrity(repoDir, branch)
    expect(result).toEqual({ ok: false, reason: 'missing-node-modules' })
  })

  it('returns ok:true when package.json and node_modules both exist', async () => {
    const repoDir = await makeGitRepo(tmpBase)
    const branch = await currentBranch(repoDir)

    await writeFile(join(repoDir, 'package.json'), JSON.stringify({ name: 'test' }))
    await mkdir(join(repoDir, 'node_modules'), { recursive: true })

    const result = await checkWorktreeIntegrity(repoDir, branch)
    expect(result).toEqual({ ok: true })
  })

  it('returns ok:true when there is no package.json (node_modules check skipped)', async () => {
    // A repo with no package.json at all — the node_modules check must not apply.
    const repoDir = await makeGitRepo(tmpBase)
    const branch = await currentBranch(repoDir)

    const result = await checkWorktreeIntegrity(repoDir, branch)
    expect(result).toEqual({ ok: true })
  })

  it('returns wrong-branch for a linked worktree on a different branch', async () => {
    const repoDir = await makeGitRepo(tmpBase)
    const wtDir = join(tmpBase, 'linked-wt')

    // Create a new branch and a linked worktree for it.
    await execFileAsync('git', ['-C', repoDir, 'branch', 'feature'])
    await execFileAsync('git', ['-C', repoDir, 'worktree', 'add', wtDir, 'feature'])

    // Check with wrong branch name.
    const result = await checkWorktreeIntegrity(wtDir, 'main')
    expect(result).toEqual({ ok: false, reason: 'wrong-branch' })
  })

  it('returns ok:true for a linked worktree on the expected branch', async () => {
    const repoDir = await makeGitRepo(tmpBase)
    const wtDir = join(tmpBase, 'linked-wt-ok')

    await execFileAsync('git', ['-C', repoDir, 'branch', 'task/abc123'])
    await execFileAsync('git', ['-C', repoDir, 'worktree', 'add', wtDir, 'task/abc123'])

    const result = await checkWorktreeIntegrity(wtDir, 'task/abc123')
    expect(result).toEqual({ ok: true })
  })
})
