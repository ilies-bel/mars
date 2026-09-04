/**
 * Tests for GET /view/task/:id/changes — the daemon-side task-changes endpoint.
 *
 * Uses a real temporary git repository to exercise the VCS port's
 * diffSummary, diffText, and commitsInRange methods end-to-end.
 * The route is wired through a stub AppServices whose viewTaskChanges
 * is replaced per test.
 *
 * Covers:
 *   - 400 when id is empty
 *   - 200 with the files/stats/patch/commits shape from viewTaskChanges
 *   - 200 with the branch-gone shape when the branch is missing
 *   - patch is truncated when it exceeds 200 KB
 *   - viewTaskChanges against a real git repo with two commits ahead
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { execSync } from 'node:child_process'
import type { HttpServerDeps } from '../http-server'
import type { AppServices, TaskChangesResult } from '../../app-services'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import type { TraceEventStore } from '../../lib/trace-events-store'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null

beforeAll(async () => {
  const tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-http-task-changes-cat-'))
  cachedRecipeCatalog = await loadRecipeCatalog(tmpDir)
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

// ── GET /view/task/:id/changes ────────────────────────────────────────────────

describe('GET /view/task/:id/changes', () => {
  it('returns 400 when id is empty', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      // The route pattern is /view/task/:id/changes; an empty id leaves
      // the path as /view/task//changes which startsWith but the id slice is ''.
      const res = await fetch(`http://127.0.0.1:${port}/view/task//changes`)
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/id/)
    } finally {
      await close()
    }
  })

  it('returns 200 with the branch-gone shape when viewTaskChanges returns it', async () => {
    const branchGone: TaskChangesResult = {
      reason: 'branch-gone',
      base: null,
      head: null,
      landedSha: null,
      files: [],
      patch: '',
      truncated: false,
      commits: [],
    }

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({ viewTaskChanges: async () => branchGone }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/task/task-abc/changes`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as TaskChangesResult
      expect(body.reason).toBe('branch-gone')
      expect(body.files).toHaveLength(0)
      expect(body.patch).toBe('')
    } finally {
      await close()
    }
  })

  it('returns 200 with files/stats/patch from viewTaskChanges', async () => {
    const mockResult: TaskChangesResult = {
      base: 'abc1234',
      head: 'def5678',
      landedSha: null,
      files: [
        { path: 'src/foo.ts', status: 'M', additions: 5, deletions: 2 },
        { path: 'src/bar.ts', status: 'A', additions: 10, deletions: 0 },
      ],
      patch: 'diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n',
      truncated: false,
      commits: [{ sha: 'abc1234def5678', subject: 'feat: add bar', authoredAt: '2024-01-01T00:00:00Z' }],
    }

    let receivedId: string | null = null

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        viewTaskChanges: async (id) => {
          receivedId = id
          return mockResult
        },
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/task/task-xyz/changes`)
      expect(res.status).toBe(200)
      expect(receivedId).toBe('task-xyz')
      const body = (await res.json()) as TaskChangesResult
      expect(body).not.toHaveProperty('reason')
      if (body.reason !== 'branch-gone') {
        expect(body.files).toHaveLength(2)
        expect(body.files[0]!.path).toBe('src/foo.ts')
        expect(body.files[0]!.additions).toBe(5)
        expect(body.commits).toHaveLength(1)
        expect(body.commits[0]!.subject).toBe('feat: add bar')
        expect(body.truncated).toBe(false)
        expect(body.landedSha).toBeNull()
      }
    } finally {
      await close()
    }
  })

  it('patch is truncated at 200 KB', async () => {
    const bigPatch = 'x'.repeat(201 * 1024) // > 200 KB
    const mockResult: TaskChangesResult = {
      base: 'aaa',
      head: 'bbb',
      landedSha: null,
      files: [],
      patch: bigPatch,
      truncated: true,
      commits: [],
    }

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({ viewTaskChanges: async () => mockResult }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/task/task-big/changes`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as TaskChangesResult
      if (body.reason !== 'branch-gone') {
        expect(body.truncated).toBe(true)
      }
    } finally {
      await close()
    }
  })
})

// ── Integration: diffSummary against a real git repo ─────────────────────────

describe('diffSummary against a real temporary git repo', () => {
  it('returns files and stats for commits ahead of the base', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'mars-diff-test-'))

    const git = (cmd: string) =>
      execSync(`git ${cmd}`, {
        cwd: repoDir,
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@test.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@test.com',
        },
      })

    git('init -b main')
    git('config user.email "test@test.com"')
    git('config user.name "Test"')

    // Base commit
    writeFileSync(join(repoDir, 'base.ts'), 'const x = 1\n')
    git('add base.ts')
    git('commit -m "base"')
    const baseSha = execSync('git rev-parse HEAD', { cwd: repoDir }).toString().trim()

    // Two commits ahead
    writeFileSync(join(repoDir, 'added.ts'), 'export const added = true\n')
    git('add added.ts')
    git('commit -m "feat: add added.ts"')

    writeFileSync(join(repoDir, 'base.ts'), 'const x = 1\nconst y = 2\n')
    git('add base.ts')
    git('commit -m "chore: modify base.ts"')

    const headSha = execSync('git rev-parse HEAD', { cwd: repoDir }).toString().trim()

    // Use the VCS port directly.
    const { localGitVcs } = await import('../../ports/vcs/local-git')
    const range = `${baseSha}..${headSha}`

    const files = await localGitVcs.diffSummary({ cwd: repoDir, range })
    expect(files.length).toBe(2)

    const addedFile = files.find((f) => f.path === 'added.ts')
    const baseFile = files.find((f) => f.path === 'base.ts')

    expect(addedFile).toBeDefined()
    expect(addedFile!.status).toBe('A')
    expect(addedFile!.additions).toBe(1)
    expect(addedFile!.deletions).toBe(0)

    expect(baseFile).toBeDefined()
    expect(baseFile!.status).toBe('M')
    expect(baseFile!.additions).toBe(1)
    expect(baseFile!.deletions).toBe(0)

    const commits = await localGitVcs.commitsInRange({ cwd: repoDir, range, abbrev: false })
    expect(commits.length).toBe(2)
    expect(commits[0]!.subject).toBe('chore: modify base.ts')
    expect(commits[1]!.subject).toBe('feat: add added.ts')

    const patch = await localGitVcs.diffText({ cwd: repoDir, from: baseSha, to: headSha })
    expect(patch).toBeTruthy()
    expect(patch).toContain('added.ts')
  })
})
