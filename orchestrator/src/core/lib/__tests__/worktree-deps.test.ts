import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
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

  it('returns an empty list when pnpm-workspace.yaml is absent', async () => {
    const root = makeWorktreeRoot()

    const workspaces = await resolveDependencyWorkspaces(root)

    expect([...workspaces]).toEqual([])
  })

  it('returns an empty list when pnpm-workspace.yaml has no packages array', async () => {
    const root = makeWorktreeRoot()
    writeFileSync(resolve(root, 'pnpm-workspace.yaml'), 'onlyBuiltDependencies:\n  - foo\n')

    const workspaces = await resolveDependencyWorkspaces(root)

    expect([...workspaces]).toEqual([])
  })

  it('returns an empty list when pnpm-workspace.yaml is unparseable', async () => {
    const root = makeWorktreeRoot()
    writeFileSync(resolve(root, 'pnpm-workspace.yaml'), 'packages:\n  - [unterminated\n')

    const workspaces = await resolveDependencyWorkspaces(root)

    expect([...workspaces]).toEqual([])
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

  it('links each workspace to the source dependency tree and remains safe to repeat', async () => {
    const sourceRoot = mkdtempSync(resolve(tmpdir(), 'mars-worktree-deps-source-'))
    const worktreeRoot = mkdtempSync(resolve(tmpdir(), 'mars-worktree-deps-target-'))
    roots.push(sourceRoot, worktreeRoot)
    for (const workspace of ['orchestrator', 'ui', 'packages/workflow']) {
      mkdirSync(resolve(sourceRoot, workspace, 'node_modules'), { recursive: true })
      mkdirSync(resolve(worktreeRoot, workspace), { recursive: true })
    }
    // resolveDependencyWorkspaces reads pnpm-workspace.yaml from the worktree
    // root — it no longer falls back to a hardcoded Mars-specific list.
    writeFileSync(
      resolve(worktreeRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - orchestrator\n  - ui\n  - packages/*\n',
    )

    await provisionWorktreeDeps({ worktreeRoot, sourceRoot })
    await provisionWorktreeDeps({ worktreeRoot, sourceRoot })

    for (const workspace of ['orchestrator', 'ui', 'packages/workflow']) {
      const link = resolve(worktreeRoot, workspace, 'node_modules')
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(realpathSync(link)).toBe(realpathSync(resolve(sourceRoot, workspace, 'node_modules')))
    }
  })

  it('provisions dependencies for a git worktree when pnpm-workspace.yaml is committed', async () => {
    // Set up a source repo whose committed tree includes pnpm-workspace.yaml.
    // resolveDependencyWorkspaces reads the yaml from the WORKTREE root —
    // without it the function returns [] and no symlinks are created.
    const sourceRoot = mkdtempSync(resolve(tmpdir(), 'mars-worktree-create-source-'))
    roots.push(sourceRoot)
    for (const workspace of ['orchestrator', 'ui', 'packages/workflow']) {
      mkdirSync(resolve(sourceRoot, workspace, 'node_modules'), { recursive: true })
    }
    writeFileSync(resolve(sourceRoot, 'README.md'), 'base\n')
    writeFileSync(
      resolve(sourceRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - orchestrator\n  - ui\n  - packages/workflow\n',
    )
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: sourceRoot })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: sourceRoot })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: sourceRoot })
    execFileSync('git', ['add', 'README.md', 'pnpm-workspace.yaml'], { cwd: sourceRoot })
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: sourceRoot })

    // Create a linked worktree from the committed branch.
    const worktreePath = resolve(sourceRoot, '.mars', 'worktrees', 'test-wt')
    mkdirSync(resolve(worktreePath, '..'), { recursive: true })
    execFileSync('git', ['worktree', 'add', '-b', 'task/test', worktreePath, 'main'], {
      cwd: sourceRoot,
    })

    // provisionWorktreeDeps with an explicit sourceRoot uses the committed
    // pnpm-workspace.yaml from the worktree to discover workspaces and then
    // symlinks node_modules from sourceRoot.
    await provisionWorktreeDeps({ worktreeRoot: worktreePath, sourceRoot })

    for (const workspace of ['orchestrator', 'ui', 'packages/workflow']) {
      expect(realpathSync(resolve(worktreePath, workspace, 'node_modules'))).toBe(
        realpathSync(resolve(sourceRoot, workspace, 'node_modules')),
      )
    }
  })

  it('does nothing when no pnpm-workspace.yaml is present (empty workspace list)', async () => {
    const sourceRoot = mkdtempSync(resolve(tmpdir(), 'mars-worktree-empty-source-'))
    const worktreeRoot = mkdtempSync(resolve(tmpdir(), 'mars-worktree-empty-target-'))
    roots.push(sourceRoot, worktreeRoot)
    // No pnpm-workspace.yaml — resolveDependencyWorkspaces returns [].
    mkdirSync(resolve(sourceRoot, 'some-package', 'node_modules'), { recursive: true })

    await provisionWorktreeDeps({ worktreeRoot, sourceRoot })

    // Nothing was linked — the worktree root is empty.
    const entries = rmSync(resolve(worktreeRoot, 'some-package'), { force: true })
    void entries // confirm no exception — directory not created
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

// ---------------------------------------------------------------------------
// Regression: no hardcoded Mars workspace names in path-position source
// ---------------------------------------------------------------------------

describe('regression: no Mars workspace names hardcoded as path literals', () => {
  it('worktree-deps.ts does not embed Mars workspace directory names as path-position string literals', () => {
    const src = readFileSync(resolve(__dirname, '../worktree-deps.ts'), 'utf8')
    // Strip comments so explanatory prose does not trigger the check.
    const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    // These are Mars's own workspace package paths — they must not appear as
    // hardcoded string literals used in filesystem path operations.  A consumer
    // repo does not have this layout, so encoding it here silently misbehaves.
    for (const marsDir of [
      "'packages/workflow'",
      "'packages/claude-session'",
    ]) {
      expect(withoutComments, `found hardcoded Mars workspace path literal: ${marsDir}`).not.toContain(marsDir)
    }
  })
})
