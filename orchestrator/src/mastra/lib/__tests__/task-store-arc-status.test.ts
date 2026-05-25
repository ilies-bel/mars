import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * Verifies the per-arc rollup predicate added in slice 1 of PRD
 * 9aec85db: given an `origin_id`, the TaskStore returns whether the
 * arc is `in-progress`, `arc-done`, or `arc-failed`, alongside the
 * per-task status list and the merged-commit list pulled from the
 * integration branch.
 *
 * The seam is exposed as a typed method on TaskStore so the rest of
 * the orchestrator can consume it without a one-off helper.
 */

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-arc-status-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  // Required for libsql + the queue migrations.
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  // Empty initial commit so `main` exists and `git log main ...` doesn't
  // fail with "unknown revision" on a brand-new repo.
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'mars-test',
      GIT_AUTHOR_EMAIL: 'mars-test@example.com',
      GIT_COMMITTER_NAME: 'mars-test',
      GIT_COMMITTER_EMAIL: 'mars-test@example.com',
    },
  })
  return repo
}

const loadDeps = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = await import('../../queue')
  const store = await import('../task-store')
  store.__resetDefaultTaskStoreForTests()
  await queue.initQueue()
  const taskStore = await store.getDefaultTaskStore()
  return { queue, store, taskStore }
}

describe('TaskStore.arcStatus', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('rolls up three derived tasks (done, done, queued) as in-progress, then flips to arc-done when the queued one completes', async () => {
    const { queue, taskStore } = await loadDeps(repo)
    const originId = 'prop-arc-12345678'

    const t1 = await queue.enqueueTask('slice 1', undefined, {
      skipTriage: true,
      originId,
    })
    const t2 = await queue.enqueueTask('slice 2', undefined, {
      skipTriage: true,
      originId,
    })
    const t3 = await queue.enqueueTask('slice 3', undefined, {
      skipTriage: true,
      originId,
    })

    await queue.updateTask(t1.id, { status: 'done' })
    await queue.updateTask(t2.id, { status: 'done' })
    // t3 stays 'queued'

    const inProgress = await taskStore.arcStatus(originId, {
      integrationBranch: 'main',
      cwd: repo,
    })
    expect(inProgress.status).toBe('in-progress')
    expect(inProgress.tasks).toHaveLength(3)
    const byId = new Map(inProgress.tasks.map((t) => [t.id, t.status]))
    expect(byId.get(t1.id)).toBe('done')
    expect(byId.get(t2.id)).toBe('done')
    expect(byId.get(t3.id)).toBe('queued')
    expect(Array.isArray(inProgress.landedCommits)).toBe(true)

    await queue.updateTask(t3.id, { status: 'done' })

    const arcDone = await taskStore.arcStatus(originId, {
      integrationBranch: 'main',
      cwd: repo,
    })
    expect(arcDone.status).toBe('arc-done')
    expect(arcDone.tasks).toHaveLength(3)
    for (const t of arcDone.tasks) expect(t.status).toBe('done')
  })

  it('returns arc-failed when every task is terminal but none reached done', async () => {
    const { queue, taskStore } = await loadDeps(repo)
    const originId = 'prop-failed-87654321'

    const t1 = await queue.enqueueTask('a', undefined, {
      skipTriage: true,
      originId,
    })
    const t2 = await queue.enqueueTask('b', undefined, {
      skipTriage: true,
      originId,
    })
    await queue.updateTask(t1.id, { status: 'failed' })
    await queue.updateTask(t2.id, { status: 'dropped' })

    const result = await taskStore.arcStatus(originId, {
      integrationBranch: 'main',
      cwd: repo,
    })
    expect(result.status).toBe('arc-failed')
  })

  it('treats an ad-hoc task as a single-task arc keyed by its own id', async () => {
    const { queue, taskStore } = await loadDeps(repo)
    const t = await queue.enqueueTask('solo', undefined, { skipTriage: true })
    expect(t.originId).toBe(t.id)

    const before = await taskStore.arcStatus(t.id, {
      integrationBranch: 'main',
      cwd: repo,
    })
    expect(before.status).toBe('in-progress')

    await queue.updateTask(t.id, { status: 'done' })

    const after = await taskStore.arcStatus(t.id, {
      integrationBranch: 'main',
      cwd: repo,
    })
    expect(after.status).toBe('arc-done')
    expect(after.tasks).toEqual([{ id: t.id, status: 'done' }])
  })

  it('counts dropped tasks as terminal but not as "landed" for the at-least-one-done check', async () => {
    const { queue, taskStore } = await loadDeps(repo)
    const originId = 'prop-mixed-aaaaaaaa'

    const t1 = await queue.enqueueTask('drop me', undefined, {
      skipTriage: true,
      originId,
    })
    const t2 = await queue.enqueueTask('ship me', undefined, {
      skipTriage: true,
      originId,
    })
    await queue.updateTask(t1.id, { status: 'dropped' })
    await queue.updateTask(t2.id, { status: 'done' })

    const result = await taskStore.arcStatus(originId, {
      integrationBranch: 'main',
      cwd: repo,
    })
    // dropped is terminal; one done means arc-done.
    expect(result.status).toBe('arc-done')
  })
})
