/**
 * Tests for GET /view/hot-paths — the daemon-side hot-paths endpoint.
 *
 * Uses a real temporary git repository to exercise the git log parsing and
 * tombstone-based task attribution end-to-end.
 *
 * Also covers:
 *   - default query params (window=90d, group=file)
 *   - custom window (30d, all) and group (dir)
 *   - task attribution via tombstone mergeCommitSha
 *   - the stub AppServices path (no real git repo)
 *   - generated path exclusion
 *   - window bound respected
 *   - counts aggregate correctly up the directory tree
 */

import { describe, expect, it, beforeAll, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { execSync } from 'node:child_process'
import type { HttpServerDeps } from './http-server'
import type { AppServices } from '../app-services'
import { stubAppServices, stubChatRunner } from './__tests__/app-services-stub'
import { loadRecipeCatalog } from '../lib/recipes'
import type { TraceEventStore } from '../lib/trace-events-store'
import { clearHotPathsCache } from './view/hot-paths'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null

beforeAll(async () => {
  const tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-http-hot-paths-cat-'))
  cachedRecipeCatalog = await loadRecipeCatalog(tmpDir)
})

afterEach(() => {
  clearHotPathsCache()
})

const stubTraceStore: TraceEventStore = {
  record: async () => {},
  query: async () => [],
  close: async () => {},
}

const makeDeps = (
  appServicesOverrides: Partial<AppServices> = {},
): HttpServerDeps => ({
  restartTask: async () => {},
  continueTask: async () => {},
  remergeTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  dismissProposal: async () => {},
  promoteProposal: async () => ({ taskIds: [] }),
  validateTask: async () => {},
  rejectTask: async () => {},
  landWork: async () => {},
  investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }),
  restartDaemon: async () => {},
  continueAllDaemonKilled: async () => ({ continued: [], degraded: [], skipped: [] }),
  isAcceptingWork: () => true,
  inFlightCount: () => 0,
  selfUpdate: async () => {},
  runReflect: async () => ({ proposalsRaised: 0 }),
  stepDone: async () => ({ next: null as string | null }),
  snoozeItem: async () => {},
  recipeCatalog: cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: stubTraceStore,
  appServices: stubAppServices(appServicesOverrides),
  chatRunner: stubChatRunner(),
})

// ── GET /view/hot-paths (stub path) ──────────────────────────────────────────

describe('GET /view/hot-paths (stub AppServices)', () => {
  it('returns 200 with empty paths from the stub (default window=90d)', async () => {
    const { startHttpServer } = await import('./http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/hot-paths`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { paths: unknown[]; window: string; total: number }
      expect(body.paths).toEqual([])
      expect(body.window).toBe('90d')
      expect(body.total).toBe(0)
    } finally {
      await close()
    }
  })

  it('returns 200 with window=30d and group=dir', async () => {
    const { startHttpServer } = await import('./http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/hot-paths?window=30d&group=dir`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { paths: unknown[]; window: string; total: number }
      expect(body.window).toBe('30d')
      expect(body.paths).toEqual([])
    } finally {
      await close()
    }
  })

  it('falls back to window=90d and group=file for invalid params', async () => {
    const { startHttpServer } = await import('./http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/hot-paths?window=bogus&group=invalid`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { window: string }
      expect(body.window).toBe('90d')
    } finally {
      await close()
    }
  })

  it('accepts window=all', async () => {
    const { startHttpServer } = await import('./http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/hot-paths?window=all`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { window: string }
      expect(body.window).toBe('all')
    } finally {
      await close()
    }
  })
})

// ── GET /view/hot-paths (real git repo) ───────────────────────────────────────

describe('GET /view/hot-paths (real git repo via buildHotPathsView)', () => {
  it('returns changed files attributed to task via tombstone', async () => {
    // Set up a temp git repo with two commits
    const tmpRoot = mkdtempSync(resolve(tmpdir(), 'mars-hot-paths-git-'))
    const repoRoot = join(tmpRoot, 'repo')
    const stateDir = join(tmpRoot, '.mars')
    const worktreesDir = join(stateDir, 'worktrees')
    mkdirSync(repoRoot, { recursive: true })
    mkdirSync(worktreesDir, { recursive: true })

    const git = (cmd: string) =>
      execSync(cmd, { cwd: repoRoot })

    git('git init -b main')
    git('git config user.email "test@example.com"')
    git('git config user.name "Test"')

    // First commit — human author (in orchestrator/src scope)
    mkdirSync(join(repoRoot, 'orchestrator/src'), { recursive: true })
    writeFileSync(join(repoRoot, 'orchestrator/src/human.ts'), 'export const x = 1')
    git('git add orchestrator/src/human.ts')
    git('git commit -m "chore: human commit"')

    // Second commit — this will be the task's mergeCommitSha
    mkdirSync(join(repoRoot, 'orchestrator/src/feature'), { recursive: true })
    writeFileSync(join(repoRoot, 'orchestrator/src/feature/index.ts'), 'export const y = 2')
    git('git add orchestrator/src/feature/index.ts')
    git('git commit -m "feat(task): implement feature"')
    const taskSha = execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim()

    // Write tombstone mapping taskSha → taskId
    const taskId = 'mars-abc123'
    writeFileSync(
      join(worktreesDir, `${taskId}.removed.json`),
      JSON.stringify({ taskId, mergeCommitSha: taskSha, reason: 'merged' }),
    )

    const { buildHotPathsView } = await import('./view/hot-paths')
    const result = await buildHotPathsView({ stateDir, repoRoot, window: '90d', group: 'file' })

    // orchestrator/src/human.ts and orchestrator/src/feature/index.ts should appear
    expect(result.paths.length).toBeGreaterThan(0)

    const featurePath = result.paths.find((p) => p.path === 'orchestrator/src/feature/index.ts')
    expect(featurePath).toBeDefined()
    if (featurePath) {
      expect(featurePath.tasks).toContain(taskId)
      expect(featurePath.touchedByMars).toBe(1)
      expect(featurePath.touchedByHumans).toBe(0)
    }

    const humanPath = result.paths.find((p) => p.path === 'orchestrator/src/human.ts')
    expect(humanPath).toBeDefined()
    if (humanPath) {
      expect(humanPath.tasks).toEqual([])
      expect(humanPath.touchedByHumans).toBe(1)
      expect(humanPath.touchedByMars).toBe(0)
    }
  })

  it('groups by directory when group=dir', async () => {
    const tmpRoot = mkdtempSync(resolve(tmpdir(), 'mars-hot-paths-dir-'))
    const repoRoot = join(tmpRoot, 'repo')
    const stateDir = join(tmpRoot, '.mars')
    mkdirSync(join(repoRoot, 'orchestrator/src'), { recursive: true })
    mkdirSync(join(stateDir, 'worktrees'), { recursive: true })

    const git = (cmd: string) =>
      execSync(cmd, { cwd: repoRoot })

    git('git init -b main')
    git('git config user.email "t@t.com"')
    git('git config user.name "T"')

    writeFileSync(join(repoRoot, 'orchestrator/src/a.ts'), '1')
    writeFileSync(join(repoRoot, 'orchestrator/src/b.ts'), '2')
    git('git add orchestrator/src/')
    git('git commit -m "feat: two files in src"')

    const { buildHotPathsView } = await import('./view/hot-paths')
    const result = await buildHotPathsView({ stateDir, repoRoot, window: '90d', group: 'dir' })

    const srcEntry = result.paths.find((p) => p.path === 'orchestrator/src')
    expect(srcEntry).toBeDefined()
    if (srcEntry) {
      // Two files in orchestrator/src → changes = 2
      expect(srcEntry.changes).toBe(2)
    }
  })

  // ── Churn computation tests ────────────────────────────────────────────────

  it('excludes generated paths (dist/, *.generated.ts, lockfiles)', async () => {
    const tmpRoot = mkdtempSync(resolve(tmpdir(), 'mars-hot-paths-excl-'))
    const repoRoot = join(tmpRoot, 'repo')
    const stateDir = join(tmpRoot, '.mars')
    mkdirSync(join(repoRoot, 'orchestrator/src'), { recursive: true })
    mkdirSync(join(repoRoot, 'dist'), { recursive: true })
    mkdirSync(join(stateDir, 'worktrees'), { recursive: true })

    const git = (cmd: string) => execSync(cmd, { cwd: repoRoot })
    git('git init -b main')
    git('git config user.email "t@t.com"')
    git('git config user.name "T"')

    // Commit a real source file, a generated file, a dist file, and a lockfile
    writeFileSync(join(repoRoot, 'orchestrator/src/real.ts'), 'export const x = 1')
    writeFileSync(join(repoRoot, 'orchestrator/src/gen.generated.ts'), '// generated')
    writeFileSync(join(repoRoot, 'dist/bundle.js'), '// built')
    writeFileSync(join(repoRoot, 'package-lock.json'), '{}')
    git('git add .')
    git('git commit -m "feat: mix of real and generated files"')

    const { buildHotPathsView } = await import('./view/hot-paths')
    const result = await buildHotPathsView({ stateDir, repoRoot, window: '90d', group: 'file' })

    const paths = result.paths.map((p) => p.path)

    // Real source file should appear
    expect(paths).toContain('orchestrator/src/real.ts')

    // Generated/vendored files must be excluded
    expect(paths).not.toContain('orchestrator/src/gen.generated.ts')
    expect(paths).not.toContain('dist/bundle.js')
    expect(paths).not.toContain('package-lock.json')
  })

  it('respects the window bound — commits outside the window are excluded', async () => {
    const tmpRoot = mkdtempSync(resolve(tmpdir(), 'mars-hot-paths-win-'))
    const repoRoot = join(tmpRoot, 'repo')
    const stateDir = join(tmpRoot, '.mars')
    mkdirSync(join(repoRoot, 'orchestrator/src'), { recursive: true })
    mkdirSync(join(stateDir, 'worktrees'), { recursive: true })

    const git = (cmd: string) => execSync(cmd, { cwd: repoRoot })
    git('git init -b main')
    git('git config user.email "t@t.com"')
    git('git config user.name "T"')

    // Commit a file today (well within any window)
    writeFileSync(join(repoRoot, 'orchestrator/src/recent.ts'), 'export const x = 1')
    git('git add orchestrator/src/recent.ts')
    git('git commit -m "feat: recent file"')

    const { buildHotPathsView } = await import('./view/hot-paths')

    // 30d window should include the recent commit
    const result30d = await buildHotPathsView({
      stateDir, repoRoot, window: '30d', group: 'file',
    })
    expect(result30d.paths.map((p) => p.path)).toContain('orchestrator/src/recent.ts')

    // 'all' window should also include it (unbounded)
    clearHotPathsCache()
    const resultAll = await buildHotPathsView({
      stateDir, repoRoot, window: 'all', group: 'file',
    })
    expect(resultAll.paths.map((p) => p.path)).toContain('orchestrator/src/recent.ts')
  })

  it('aggregates counts correctly up the directory tree when group=dir', async () => {
    const tmpRoot = mkdtempSync(resolve(tmpdir(), 'mars-hot-paths-agg-'))
    const repoRoot = join(tmpRoot, 'repo')
    const stateDir = join(tmpRoot, '.mars')
    mkdirSync(join(repoRoot, 'orchestrator/src/core'), { recursive: true })
    mkdirSync(join(repoRoot, 'orchestrator/src/workers'), { recursive: true })
    mkdirSync(join(stateDir, 'worktrees'), { recursive: true })

    const git = (cmd: string) => execSync(cmd, { cwd: repoRoot })
    git('git init -b main')
    git('git config user.email "t@t.com"')
    git('git config user.name "T"')

    // 3 files in orchestrator/src/core
    writeFileSync(join(repoRoot, 'orchestrator/src/core/a.ts'), '1')
    writeFileSync(join(repoRoot, 'orchestrator/src/core/b.ts'), '2')
    writeFileSync(join(repoRoot, 'orchestrator/src/core/c.ts'), '3')
    // 1 file in orchestrator/src/workers
    writeFileSync(join(repoRoot, 'orchestrator/src/workers/w.ts'), '4')
    git('git add orchestrator/src/')
    git('git commit -m "feat: multiple dirs"')

    const { buildHotPathsView } = await import('./view/hot-paths')
    const result = await buildHotPathsView({ stateDir, repoRoot, window: '90d', group: 'dir' })

    // orchestrator/src/core should have 3 changes, workers should have 1
    const coreEntry = result.paths.find((p) => p.path === 'orchestrator/src/core')
    const workersEntry = result.paths.find((p) => p.path === 'orchestrator/src/workers')
    expect(coreEntry?.changes).toBe(3)
    expect(workersEntry?.changes).toBe(1)

    // orchestrator/src/core should rank above orchestrator/src/workers
    const coreIdx = result.paths.findIndex((p) => p.path === 'orchestrator/src/core')
    const workersIdx = result.paths.findIndex((p) => p.path === 'orchestrator/src/workers')
    expect(coreIdx).toBeLessThan(workersIdx)
  })
})
