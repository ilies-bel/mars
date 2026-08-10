import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  __resetContextCacheForTests,
  resolveContext,
  resolveDbTarget,
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
    expect(ctx.queueDbPath).toBe(resolve(realRepo, '.mars', 'mars.db'))
    // Never the fabricated worktree-local `.mars/`.
    expect(ctx.queueDbPath).not.toBe(
      resolve(worktreeDir, '.mars', 'mars.db'),
    )
  })

  it('resolves to the repo root unchanged when cwd is the primary worktree', () => {
    process.chdir(realRepo)
    const ctx = resolveContext()
    expect(ctx.repoRoot).toBe(realRepo)
    expect(ctx.queueDbPath).toBe(resolve(realRepo, '.mars', 'mars.db'))
  })

  it('honors an explicit override even when cwd is inside a linked worktree', () => {
    process.chdir(worktreeDir)
    const ctx = resolveContext(realRepo)
    expect(ctx.repoRoot).toBe(realRepo)
  })

  it("co-locates Mars's trace-event store inside the unified mars.db", () => {
    const ctx = resolveContext(realRepo)
    // Slice B collapsed the old DuckDB-backed mars-trace store into the
    // shared SQLite mars.db. The framework's observability.duckdb stays a
    // separate file, written by the framework's own observability hook.
    expect(ctx.stateDbPath).toBe(resolve(realRepo, '.mars', 'mars.db'))
    expect(ctx.observabilityDbPath).toBe(
      resolve(realRepo, '.mars', 'observability.duckdb'),
    )
    expect(ctx.stateDbPath).not.toBe(ctx.observabilityDbPath)
  })

  // Regression guard: a dispatched coder running in a worktree resolves the
  // real repo root (via --git-common-dir) and therefore can see the parent
  // repo's live .mars/pg.dsn. The test suite forces MARS_DB_BACKEND=pglite in
  // test/setup-env.ts (unconditional '=', not '??=') precisely to prevent
  // worktree-running code from accidentally writing to the live database.
  // This assertion documents and enforces that guarantee.
  it('resolveDbTarget returns pglite key from worktree cwd, not parent repo live DSN', () => {
    // Write a fake pg.dsn in the real repo's .mars/ to simulate a live daemon.
    const marsDir = resolve(realRepo, '.mars')
    mkdirSync(marsDir, { recursive: true })
    const fakeDsn = 'postgres://mars@127.0.0.1:54321/mars'
    writeFileSync(resolve(marsDir, 'pg.dsn'), fakeDsn)

    // Act as a dispatched coder whose cwd is a Mars-managed linked worktree.
    process.chdir(worktreeDir)
    __resetContextCacheForTests()

    // With MARS_DB_BACKEND=pglite forced by the test setup, resolveDbTarget
    // must return the pglite identity key (the .mars/ state dir path), never
    // the live postgres:// DSN from the parent repo.
    const target = resolveDbTarget()
    expect(target).not.toBe(fakeDsn)
    expect(target).not.toMatch(/^postgres:\/\//)
    // The pglite key is a filesystem path rooted at the real repo's .mars dir.
    expect(target).toContain('.mars')
  })
})
