import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  __resetContextCacheForTests,
  resolveContext,
} from './context.js'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

describe('resolveContext repo-root detection', () => {
  let tmpRoot: string
  let realRepo: string
  let worktreeDir: string
  let originalCwd: string
  let originalMarsRepo: string | undefined

  beforeEach(() => {
    originalCwd = process.cwd()
    originalMarsRepo = process.env.MARS_REPO
    // Drop MARS_REPO so the cwd-based detection branch is exercised.
    delete process.env.MARS_REPO

    // `realpathSync` because macOS tmp paths can resolve through
    // `/private/var/...`; git always reports the realpath, so we need
    // the test to compare apples to apples.
    tmpRoot = realpathSync(mkdtempSync(resolve(tmpdir(), 'mars-ctx-')))
    realRepo = resolve(tmpRoot, 'repo')
    mkdirSync(realRepo, { recursive: true })

    git(realRepo, 'init', '-q', '-b', 'main')
    git(realRepo, 'config', 'user.email', 'test@example.com')
    git(realRepo, 'config', 'user.name', 'test')
    writeFileSync(resolve(realRepo, 'README.md'), '# fixture\n')
    git(realRepo, 'add', 'README.md')
    git(realRepo, 'commit', '-q', '-m', 'init')

    // Mars layout: `<repo>/.mars/worktrees/<id>`.
    mkdirSync(resolve(realRepo, '.mars', 'worktrees'), { recursive: true })
    worktreeDir = resolve(realRepo, '.mars', 'worktrees', 'wt1')
    git(realRepo, 'worktree', 'add', '-q', '-b', 'task/wt1', worktreeDir)

    __resetContextCacheForTests()
  })

  afterEach(() => {
    __resetContextCacheForTests()
    process.chdir(originalCwd)
    if (originalMarsRepo === undefined) {
      delete process.env.MARS_REPO
    } else {
      process.env.MARS_REPO = originalMarsRepo
    }
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('resolves to the real repo root when cwd is inside a Mars-managed linked worktree', () => {
    process.chdir(worktreeDir)
    const ctx = resolveContext()
    expect(ctx.repoRoot).toBe(realRepo)
    expect(ctx.stateDir).toBe(resolve(realRepo, '.mars'))
    expect(ctx.queueDbPath).toBe(resolve(realRepo, '.mars', 'queue.db'))
    // Never the fabricated worktree-local `.mars/`.
    expect(ctx.queueDbPath).not.toBe(
      resolve(worktreeDir, '.mars', 'queue.db'),
    )
  })

  it('resolves to the repo root unchanged when cwd is the primary worktree', () => {
    process.chdir(realRepo)
    const ctx = resolveContext()
    expect(ctx.repoRoot).toBe(realRepo)
    expect(ctx.queueDbPath).toBe(resolve(realRepo, '.mars', 'queue.db'))
  })

  it('honors an explicit override even when cwd is inside a linked worktree', () => {
    process.chdir(worktreeDir)
    const ctx = resolveContext(realRepo)
    expect(ctx.repoRoot).toBe(realRepo)
  })
})
