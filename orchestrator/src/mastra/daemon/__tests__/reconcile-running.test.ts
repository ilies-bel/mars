import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  getClient: typeof import('../../queue').getClient
  initQueue: typeof import('../../queue').initQueue
  addBlockers: typeof import('../../queue').addBlockers
  updateTask: typeof import('../../queue').updateTask
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

  it('clears all in-flight fields on requeue so the new run starts from setup', async () => {
    const { q, rr } = await loadModules(repo)
    const t = await q.enqueueTask('some work', undefined, { skipTriage: true })

    // Simulate all in-flight fields a running task might have set
    await q.getClient().execute({
      sql: `UPDATE tasks
              SET status = 'running',
                  branch = ?,
                  worktree_path = ?,
                  claude_session_id = 'sess-abc123',
                  error = 'prior error',
                  failed_phase = 'verify',
                  resume_from = 'code'
            WHERE id = ?`,
      args: [`task/${t.id}`, `/mars/worktrees/${t.id}`, t.id],
    })

    await rr.requeueRunningTasksFromPriorDaemon(repo)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.branch).toBeNull()
    expect(reloaded?.worktreePath).toBeNull()
    expect(reloaded?.claudeSessionId).toBeNull()
    expect(reloaded?.error).toBeNull()
    expect(reloaded?.failedPhase).toBeNull()
  })

  it('removes the worktree directory from disk when the path exists', async () => {
    // This test exercises the removeWorktree code path in reconcile-running.ts
    // by creating a real registered git worktree, then verifying reconcile
    // removes both the directory and the git registration.

    // git worktree add requires at least one commit in the repo.
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    }
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, env: gitEnv })

    const { q, rr } = await loadModules(repo)
    const t = await q.enqueueTask('work with disk worktree', undefined, { skipTriage: true })

    const branch = `task/${t.id}`
    const worktreePath = resolve(tmpdir(), `mars-wt-${t.id}`)

    // Register a real git worktree so existsSync returns true and removeWorktree
    // has an actual registration to tear down.
    execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], { cwd: repo })

    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'running', branch = ?, worktree_path = ? WHERE id = ?`,
      args: [branch, worktreePath, t.id],
    })

    await rr.requeueRunningTasksFromPriorDaemon(repo)

    // Observable behaviour: the worktree directory must be gone from disk.
    expect(existsSync(worktreePath)).toBe(false)

    // Task is requeued with cleared in-flight fields.
    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
    expect(reloaded?.worktreePath).toBeNull()
    expect(reloaded?.branch).toBeNull()
  })

  it('restores a running task to blocked (not queued) when it still has incomplete blockers', async () => {
    const { q, rr } = await loadModules(repo)
    const blocker = await q.enqueueTask('blocker work', undefined, { skipTriage: true })
    const dependent = await q.enqueueTask('dependent work', undefined, { skipTriage: true })

    // Wire blocker edge (blocker is 'queued', not 'done')
    await q.addBlockers(dependent.id, [blocker.id])

    // Simulate: dependent was running when daemon died
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'running' WHERE id = ?`,
      args: [dependent.id],
    })

    const requeued = await rr.requeueRunningTasksFromPriorDaemon(repo)

    // Must NOT be in the requeued list (it went back to blocked, not queued)
    expect(requeued).not.toContain(dependent.id)

    // Must be 'blocked', not 'queued'
    const reloaded = await q.getTask(dependent.id)
    expect(reloaded?.status).toBe('blocked')

    // Blocker task is unchanged
    const blockerReloaded = await q.getTask(blocker.id)
    expect(blockerReloaded?.status).toBe('queued')
  })

  it('requeues a running task with all blockers done (done blockers do not gate requeue)', async () => {
    const { q, rr } = await loadModules(repo)
    const blocker = await q.enqueueTask('done blocker', undefined, { skipTriage: true })
    const dependent = await q.enqueueTask('dependent work', undefined, { skipTriage: true })

    await q.addBlockers(dependent.id, [blocker.id])

    // Mark the blocker as done — all blockers satisfied
    await q.updateTask(blocker.id, { status: 'done' })

    // Simulate: dependent was running when daemon died
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'running' WHERE id = ?`,
      args: [dependent.id],
    })

    const requeued = await rr.requeueRunningTasksFromPriorDaemon(repo)

    expect(requeued).toContain(dependent.id)

    const reloaded = await q.getTask(dependent.id)
    expect(reloaded?.status).toBe('queued')
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
