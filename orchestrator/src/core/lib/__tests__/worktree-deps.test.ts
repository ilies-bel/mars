import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  provisionWorktreeDeps,
  removeStaleWorktreeLinks,
  resolveDependencyWorkspaces,
} from '../worktree-deps'

describe('resolveDependencyWorkspaces', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  const makeWorktreeRoot = (): string => {
    const root = mkdtempSync(resolve(tmpdir(), 'mars-resolve-workspaces-'))
    roots.push(root)
    return root
  }

  it('expands a literal entry and a trailing /* glob against packages on disk', async () => {
    const root = makeWorktreeRoot()
    writeFileSync(
      resolve(root, 'pnpm-workspace.yaml'),
      'packages:\n  - orchestrator\n  - ui\n  - packages/*\n',
    )
    mkdirSync(resolve(root, 'orchestrator'), { recursive: true })
    mkdirSync(resolve(root, 'ui'), { recursive: true })
    mkdirSync(resolve(root, 'packages', 'workflow'), { recursive: true })
    mkdirSync(resolve(root, 'packages', 'claude-session'), { recursive: true })
    // A stray file under packages/ must not be treated as a package.
    writeFileSync(resolve(root, 'packages', 'README.md'), 'not a package\n')

    const workspaces = await resolveDependencyWorkspaces(root)

    expect([...workspaces].sort()).toEqual(
      ['orchestrator', 'ui', 'packages/claude-session', 'packages/workflow'].sort(),
    )
  })

  it('falls back to the default list when pnpm-workspace.yaml is absent', async () => {
    const root = makeWorktreeRoot()

    const workspaces = await resolveDependencyWorkspaces(root)

    expect([...workspaces]).toEqual([
      'orchestrator',
      'ui',
      'packages/workflow',
      'packages/claude-session',
    ])
  })

  it('falls back to the default list when pnpm-workspace.yaml has no packages array', async () => {
    const root = makeWorktreeRoot()
    writeFileSync(resolve(root, 'pnpm-workspace.yaml'), 'onlyBuiltDependencies:\n  - foo\n')

    const workspaces = await resolveDependencyWorkspaces(root)

    expect([...workspaces]).toEqual([
      'orchestrator',
      'ui',
      'packages/workflow',
      'packages/claude-session',
    ])
  })

  it('falls back to the default list when pnpm-workspace.yaml is unparseable', async () => {
    const root = makeWorktreeRoot()
    writeFileSync(resolve(root, 'pnpm-workspace.yaml'), 'packages:\n  - [unterminated\n')

    const workspaces = await resolveDependencyWorkspaces(root)

    expect([...workspaces]).toEqual([
      'orchestrator',
      'ui',
      'packages/workflow',
      'packages/claude-session',
    ])
  })

  it('ignores negated patterns and skips a glob dir that does not exist', async () => {
    const root = makeWorktreeRoot()
    writeFileSync(
      resolve(root, 'pnpm-workspace.yaml'),
      'packages:\n  - orchestrator\n  - "!orchestrator/fixtures"\n  - packages/*\n',
    )
    mkdirSync(resolve(root, 'orchestrator'), { recursive: true })
    // packages/ deliberately absent — the glob must resolve to nothing for it
    // rather than throw.

    const workspaces = await resolveDependencyWorkspaces(root)

    expect([...workspaces]).toEqual(['orchestrator'])
  })
})

describe('provisionWorktreeDeps', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('links each Mars workspace to the source dependency tree and remains safe to repeat', async () => {
    const sourceRoot = mkdtempSync(resolve(tmpdir(), 'mars-worktree-deps-source-'))
    const worktreeRoot = mkdtempSync(resolve(tmpdir(), 'mars-worktree-deps-target-'))
    roots.push(sourceRoot, worktreeRoot)
    for (const workspace of ['orchestrator', 'ui', 'packages/workflow']) {
      mkdirSync(resolve(sourceRoot, workspace, 'node_modules'), { recursive: true })
      mkdirSync(resolve(worktreeRoot, workspace), { recursive: true })
    }

    await provisionWorktreeDeps({ worktreeRoot, sourceRoot })
    await provisionWorktreeDeps({ worktreeRoot, sourceRoot })

    for (const workspace of ['orchestrator', 'ui', 'packages/workflow']) {
      const link = resolve(worktreeRoot, workspace, 'node_modules')
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(realpathSync(link)).toBe(realpathSync(resolve(sourceRoot, workspace, 'node_modules')))
    }
  })

  it('provisions dependencies when creating a task worktree', async () => {
    const sourceRoot = mkdtempSync(resolve(tmpdir(), 'mars-worktree-create-source-'))
    roots.push(sourceRoot)
    for (const workspace of ['orchestrator', 'ui', 'packages/workflow']) {
      mkdirSync(resolve(sourceRoot, workspace, 'node_modules'), { recursive: true })
    }
    writeFileSync(resolve(sourceRoot, 'README.md'), 'base\n')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: sourceRoot })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: sourceRoot })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: sourceRoot })
    execFileSync('git', ['add', 'README.md'], { cwd: sourceRoot })
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: sourceRoot })

    const originalRepo = process.env.MARS_REPO
    process.env.MARS_REPO = sourceRoot
    const { __resetContextCacheForTests } = await import('../../context')
    __resetContextCacheForTests()
    try {
      const { createWorktree } = await import('../git/worktree')
      const worktree = await createWorktree({
        taskId: 'mars-provisioned',
        integrationBranch: 'main',
      })

      for (const workspace of ['orchestrator', 'ui', 'packages/workflow']) {
        expect(realpathSync(resolve(worktree.path, workspace, 'node_modules'))).toBe(
          realpathSync(resolve(sourceRoot, workspace, 'node_modules')),
        )
      }
    } finally {
      if (originalRepo === undefined) delete process.env.MARS_REPO
      else process.env.MARS_REPO = originalRepo
      __resetContextCacheForTests()
    }
  })
})

// ---------------------------------------------------------------------------
// removeStaleWorktreeLinks
// ---------------------------------------------------------------------------

describe('removeStaleWorktreeLinks', () => {
  let tmpDir = ''

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
    tmpDir = ''
  })

  it('removes top-level symlinks whose target passes through the worktree', async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'mars-stale-links-'))
    const nmDir = resolve(tmpDir, 'parent', 'node_modules')
    const worktreePath = resolve(tmpDir, 'worktree')
    // Simulate a cross-worktree .pnpm virtual-store path
    const staleTarget = resolve(worktreePath, 'ui', 'node_modules', '.pnpm', 'some-pkg', 'node_modules', 'some-pkg')
    await mkdir(nmDir, { recursive: true })
    await mkdir(staleTarget, { recursive: true })

    // Two stale symlinks pointing into the worktree
    await symlink(staleTarget, resolve(nmDir, 'some-pkg'), 'dir')
    await symlink(
      resolve(worktreePath, 'ui', 'node_modules', '.pnpm', 'other-pkg', 'node_modules', 'other-pkg'),
      resolve(nmDir, 'other-pkg'),
      'dir',
    )

    // One legitimate symlink pointing elsewhere (not into worktree)
    const legit = resolve(tmpDir, 'legit')
    await mkdir(legit, { recursive: true })
    await symlink(legit, resolve(nmDir, 'legit-pkg'), 'dir')

    // One real directory that must not be touched
    await mkdir(resolve(nmDir, 'real-pkg'), { recursive: true })

    const removed = await removeStaleWorktreeLinks(nmDir, worktreePath)

    expect(removed).toBe(2)
    // Stale links gone
    await expect(lstat(resolve(nmDir, 'some-pkg'))).rejects.toThrow()
    await expect(lstat(resolve(nmDir, 'other-pkg'))).rejects.toThrow()
    // Legit link and real dir untouched
    const legitSt = await lstat(resolve(nmDir, 'legit-pkg'))
    expect(legitSt.isSymbolicLink()).toBe(true)
    const realSt = await lstat(resolve(nmDir, 'real-pkg'))
    expect(realSt.isDirectory()).toBe(true)
    expect(realSt.isSymbolicLink()).toBe(false)
  })

  it('returns 0 when no symlinks point into the worktree', async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'mars-stale-links-clean-'))
    const nmDir = resolve(tmpDir, 'node_modules')
    const worktreePath = resolve(tmpDir, 'worktree')
    const elsewhere = resolve(tmpDir, 'elsewhere')
    await mkdir(nmDir, { recursive: true })
    await mkdir(elsewhere, { recursive: true })
    await symlink(elsewhere, resolve(nmDir, 'pkg'), 'dir')

    const removed = await removeStaleWorktreeLinks(nmDir, worktreePath)
    expect(removed).toBe(0)

    const st = await lstat(resolve(nmDir, 'pkg'))
    expect(st.isSymbolicLink()).toBe(true)
  })

  it('returns 0 when nmDir does not exist', async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'mars-stale-links-missing-'))
    const missing = resolve(tmpDir, 'nonexistent', 'node_modules')
    const worktreePath = resolve(tmpDir, 'worktree')
    const removed = await removeStaleWorktreeLinks(missing, worktreePath)
    expect(removed).toBe(0)
  })

  it('matches worktreePath with or without trailing slash', async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'mars-stale-links-slash-'))
    const nmDir = resolve(tmpDir, 'node_modules')
    const worktreePath = resolve(tmpDir, 'worktree')
    await mkdir(nmDir, { recursive: true })
    const staleTarget = resolve(worktreePath, 'ui', 'node_modules', '.pnpm', 'x')
    await mkdir(staleTarget, { recursive: true })
    await symlink(staleTarget, resolve(nmDir, 'x'), 'dir')

    // Pass worktreePath with trailing slash — must still match
    const removed = await removeStaleWorktreeLinks(nmDir, `${worktreePath}/`)
    expect(removed).toBe(1)
  })
})
