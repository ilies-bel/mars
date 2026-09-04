/**
 * Tests for GET /view/hot-paths — the daemon-side hot-paths endpoint.
 *
 * Uses a real temporary git repository to exercise the git log parsing and
 * tombstone-based task attribution end-to-end.
 *
 * Also covers:
 *   - default query params (window=7d, group=file)
 *   - custom window (30d, 90d) and group (dir)
 *   - task attribution via tombstone mergeCommitSha
 *   - the stub AppServices path (no real git repo)
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
  it('returns 200 with empty paths from the stub', async () => {
    const { startHttpServer } = await import('./http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/hot-paths`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { paths: unknown[]; window: string; total: number }
      expect(body.paths).toEqual([])
      expect(body.window).toBe('7d')
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

  it('falls back to window=7d and group=file for invalid params', async () => {
    const { startHttpServer } = await import('./http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/hot-paths?window=bogus&group=invalid`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { window: string }
      expect(body.window).toBe('7d')
    } finally {
      await close()
    }
  })

  it('accepts window=90d', async () => {
    const { startHttpServer } = await import('./http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/hot-paths?window=90d`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { window: string }
      expect(body.window).toBe('90d')
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
      execSync(cmd, { cwd: repoRoot, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } })

    git('git init -b main')
    git('git config user.email "test@example.com"')
    git('git config user.name "Test"')

    // First commit — human author
    writeFileSync(join(repoRoot, 'human.ts'), 'export const x = 1')
    git('git add human.ts')
    git('git commit -m "chore: human commit"')

    // Second commit — this will be the task's mergeCommitSha
    writeFileSync(join(repoRoot, 'src/feature.ts'), 'export const y = 2')
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'src/feature.ts'), 'export const y = 2')
    git('git add src/feature.ts')
    git('git commit -m "feat(task): implement feature"')
    const taskSha = execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim()

    // Write tombstone mapping taskSha → taskId
    const taskId = 'mars-abc123'
    writeFileSync(
      join(worktreesDir, `${taskId}.removed.json`),
      JSON.stringify({ taskId, mergeCommitSha: taskSha, reason: 'merged' }),
    )

    const { buildHotPathsView } = await import('./view/hot-paths')
    const result = await buildHotPathsView({ stateDir, repoRoot, window: '7d', group: 'file' })

    // human.ts and src/feature.ts should both appear
    expect(result.paths.length).toBeGreaterThan(0)

    const featurePath = result.paths.find((p) => p.path === 'src/feature.ts')
    expect(featurePath).toBeDefined()
    if (featurePath) {
      expect(featurePath.tasks).toContain(taskId)
      expect(featurePath.touchedByMars).toBe(1)
      expect(featurePath.touchedByHumans).toBe(0)
    }

    const humanPath = result.paths.find((p) => p.path === 'human.ts')
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
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    mkdirSync(join(stateDir, 'worktrees'), { recursive: true })

    const git = (cmd: string) =>
      execSync(cmd, { cwd: repoRoot, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } })

    git('git init -b main')
    git('git config user.email "t@t.com"')
    git('git config user.name "T"')

    writeFileSync(join(repoRoot, 'src/a.ts'), '1')
    writeFileSync(join(repoRoot, 'src/b.ts'), '2')
    git('git add src/')
    git('git commit -m "feat: two files in src"')

    const { buildHotPathsView } = await import('./view/hot-paths')
    const result = await buildHotPathsView({ stateDir, repoRoot, window: '7d', group: 'dir' })

    const srcEntry = result.paths.find((p) => p.path === 'src')
    expect(srcEntry).toBeDefined()
    if (srcEntry) {
      // Two files in src → changes = 2
      expect(srcEntry.changes).toBe(2)
    }
  })
})
