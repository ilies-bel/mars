import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  getClient: typeof import('../../queue').getClient
  initQueue: typeof import('../../queue').initQueue
}

interface ReconcileRunningModule {
  requeueRunningTasksFromPriorDaemon: typeof import('../reconcile-running').requeueRunningTasksFromPriorDaemon
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-reconcile-running-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; rr: ReconcileRunningModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const rr = (await import(
    '../reconcile-running'
  )) as unknown as ReconcileRunningModule
  return { q, rr }
}

describe('requeueRunningTasksFromPriorDaemon', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('requeues a running task instead of marking it failed on daemon restart', async () => {
    const { q, rr } = await loadModules(repo)
    const t = await q.enqueueTask('some work', undefined, { skipTriage: true })

    // Simulate the task being in-flight when the daemon died
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'running', branch = ?, worktree_path = ? WHERE id = ?`,
      args: [`task/${t.id}`, `/tmp/nonexistent-worktree-${t.id}`, t.id],
    })

    const requeued = await rr.requeueRunningTasksFromPriorDaemon(repo)

    expect(requeued).toContain(t.id)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('does not increment retryCount — a daemon restart is not a task fault', async () => {
    const { q, rr } = await loadModules(repo)
    const t = await q.enqueueTask('some work', undefined, { skipTriage: true })

    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'running', retry_count = 1 WHERE id = ?`,
      args: [t.id],
    })

    await rr.requeueRunningTasksFromPriorDaemon(repo)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.retryCount).toBe(1) // unchanged from before the restart
  })

  it('clears branch and worktreePath on requeue so the new run starts from setup', async () => {
    const { q, rr } = await loadModules(repo)
    const t = await q.enqueueTask('some work', undefined, { skipTriage: true })

    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'running', branch = ?, worktree_path = ? WHERE id = ?`,
      args: [`task/${t.id}`, `/mars/worktrees/${t.id}`, t.id],
    })

    await rr.requeueRunningTasksFromPriorDaemon(repo)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.branch).toBeNull()
    expect(reloaded?.worktreePath).toBeNull()
  })

  it('returns an empty array when no tasks are running', async () => {
    const { q, rr } = await loadModules(repo)
    await q.enqueueTask('idle work', undefined, { skipTriage: true })

    const requeued = await rr.requeueRunningTasksFromPriorDaemon(repo)

    expect(requeued).toHaveLength(0)
  })

  it('handles multiple running tasks in one pass', async () => {
    const { q, rr } = await loadModules(repo)
    const t1 = await q.enqueueTask('work 1', undefined, { skipTriage: true })
    const t2 = await q.enqueueTask('work 2', undefined, { skipTriage: true })

    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'running' WHERE id IN (?, ?)`,
      args: [t1.id, t2.id],
    })

    const requeued = await rr.requeueRunningTasksFromPriorDaemon(repo)

    expect(requeued).toHaveLength(2)
    expect(requeued).toContain(t1.id)
    expect(requeued).toContain(t2.id)

    const r1 = await q.getTask(t1.id)
    const r2 = await q.getTask(t2.id)
    expect(r1?.status).toBe('queued')
    expect(r2?.status).toBe('queued')
  })
})
