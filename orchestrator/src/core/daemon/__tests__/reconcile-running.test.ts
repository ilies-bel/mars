import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
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
  await q.migrateQueueSchema()
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
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', branch = ?, worktree_path = ? WHERE id = ?`,
      args: [`task/${t.id}`, `/tmp/nonexistent-worktree-${t.id}`, t.id],
    })

    const requeued = await rr.requeueRunningTasksFromPriorDaemon(repo)

    expect(requeued).toContain(t.id)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('does not increment recoverySpawnedCount — a daemon restart is not a task fault', async () => {
    const { q, rr } = await loadModules(repo)
    const t = await q.enqueueTask('some work', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', recovery_spawned_count = 1 WHERE id = ?`,
      args: [t.id],
    })

    await rr.requeueRunningTasksFromPriorDaemon(repo)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.recoverySpawnedCount).toBe(1) // unchanged from before the restart
  })

  it('clears all in-flight fields (including pointers) when the worktree path does not exist on disk', async () => {
    // When the recorded worktree_path does NOT exist on disk the task must
    // restart from setup — so branch/worktreePath are cleared in addition to
    // the transient fields. This is the "worktree gone" branch of Fix 1
    // (mars-c11be862): path `/mars/worktrees/<id>` is a synthetic path that
    // will never be present on the test host.
    const { q, rr } = await loadModules(repo)
    const t = await q.enqueueTask('some work', undefined, { skipTriage: true })

    // Simulate all in-flight fields a running task might have set
    await q.resolveQueueClient().execute({
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

  it('preserves the worktree directory and pointers when the worktree is still on disk', async () => {
    // Fix 1 (mars-c11be862): when a running task's worktree still exists on
    // disk after a daemon restart, the reconciler must NOT evict it. The
    // workflow engine's checkpoint-resume logic will skip the completed
    // setup step and re-enter the code step using the preserved worktree.
    // Evicting here nulls branch/worktreePath while the setup checkpoint
    // still says "completed", causing the next dispatch to throw "no worktree
    // available" every time — the root cause of the 1,014-iteration overnight
    // loop observed 2026-07-02.

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

    // Register a real git worktree so existsSync returns true.
    execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], { cwd: repo })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', branch = ?, worktree_path = ?,
                              claude_session_id = 'sess-xyz', error = 'old error',
                              failed_phase = 'code'
            WHERE id = ?`,
      args: [branch, worktreePath, t.id],
    })

    try {
      await rr.requeueRunningTasksFromPriorDaemon(repo)

      // The worktree directory must still be on disk — we do NOT evict it.
      expect(existsSync(worktreePath)).toBe(true)

      // Task is requeued and the git pointers are preserved.
      const reloaded = await q.getTask(t.id)
      expect(reloaded?.status).toBe('queued')
      expect(reloaded?.worktreePath).toBe(worktreePath)
      expect(reloaded?.branch).toBe(branch)

      // Only the transient fields are cleared.
      expect(reloaded?.claudeSessionId).toBeNull()
      expect(reloaded?.error).toBeNull()
      expect(reloaded?.failedPhase).toBeNull()
    } finally {
      // Clean up the external worktree directory (preserved by the fix, so
      // afterEach's rmSync of `repo` does not reach it).
      rmSync(worktreePath, { recursive: true, force: true })
    }
  })

  it('removes the worktree directory and clears all pointers when the worktree path is gone', async () => {
    // When the worktree path does NOT exist on disk (e.g. it was on a
    // different host or was already deleted), the reconciler should clear
    // both branch and worktreePath so the next dispatch re-runs setup fresh
    // rather than resuming against a missing path.
    const { q, rr } = await loadModules(repo)
    const t = await q.enqueueTask('work with missing worktree', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', branch = ?, worktree_path = ?,
                              claude_session_id = 'sess-abc', error = 'prior error',
                              failed_phase = 'verify'
            WHERE id = ?`,
      args: [`task/${t.id}`, `/tmp/nonexistent-path-${t.id}`, t.id],
    })

    await rr.requeueRunningTasksFromPriorDaemon(repo)

    // All in-flight fields cleared — task restarts from setup.
    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
    expect(reloaded?.worktreePath).toBeNull()
    expect(reloaded?.branch).toBeNull()
    expect(reloaded?.claudeSessionId).toBeNull()
    expect(reloaded?.error).toBeNull()
    expect(reloaded?.failedPhase).toBeNull()
  })

  it('restores a running task to blocked (not queued) when it still has incomplete blockers', async () => {
    const { q, rr } = await loadModules(repo)
    const blocker = await q.enqueueTask('blocker work', undefined, { skipTriage: true })
    const dependent = await q.enqueueTask('dependent work', undefined, { skipTriage: true })

    // Wire blocker edge (blocker is 'queued', not 'done')
    await q.addBlockers(dependent.id, [blocker.id])

    // Simulate: dependent was running when daemon died
    await q.resolveQueueClient().execute({
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
    await q.resolveQueueClient().execute({
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

  // ── Cancellation guard ────────────────────────────────────────────────────

  it('does NOT re-queue a running task that carries failureReason=cancelled (user-cancelled)', async () => {
    // Scenario: stop-task sets failureReason='cancelled' on a running task as a
    // pre-kill marker but the daemon exits before the status transitions to
    // 'failed'. On restart the task must land in 'failed' (preserving the user's
    // intent) rather than being resurrected in 'queued'.
    const { q, rr } = await loadModules(repo)
    const t = await q.enqueueTask('work the user stopped', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', failure_reason = 'cancelled' WHERE id = ?`,
      args: [t.id],
    })

    const requeued = await rr.requeueRunningTasksFromPriorDaemon(repo)

    // The cancelled task must NOT appear in the requeued list.
    expect(requeued).not.toContain(t.id)

    // It must be 'failed', not 'queued' or 'running'.
    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')

    // The cancellation reason must be preserved.
    expect(reloaded?.failureReason).toBe('cancelled')
  })

  it('re-queues a running task that has no failureReason (normal daemon-restart path)', async () => {
    // Baseline: an ordinary interrupted running task (no cancellation marker)
    // must still be re-queued on daemon restart.
    const { q, rr } = await loadModules(repo)
    const t = await q.enqueueTask('interrupted work', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', worktree_path = ? WHERE id = ?`,
      args: [`/tmp/nonexistent-wt-${t.id}`, t.id],
    })

    const requeued = await rr.requeueRunningTasksFromPriorDaemon(repo)

    expect(requeued).toContain(t.id)
    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('handles a mix of cancelled and normal running tasks correctly', async () => {
    // When both a cancelled and a legitimately-interrupted running task exist,
    // only the legitimately-interrupted one is re-queued.
    const { q, rr } = await loadModules(repo)
    const cancelled = await q.enqueueTask('user-cancelled work', undefined, { skipTriage: true })
    const interrupted = await q.enqueueTask('interrupted work', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', failure_reason = 'cancelled' WHERE id = ?`,
      args: [cancelled.id],
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', worktree_path = ? WHERE id = ?`,
      args: [`/tmp/nonexistent-wt-${interrupted.id}`, interrupted.id],
    })

    const requeued = await rr.requeueRunningTasksFromPriorDaemon(repo)

    // Only the legitimately interrupted task is re-queued.
    expect(requeued).toContain(interrupted.id)
    expect(requeued).not.toContain(cancelled.id)

    const cancelledRow = await q.getTask(cancelled.id)
    const interruptedRow = await q.getTask(interrupted.id)
    expect(cancelledRow?.status).toBe('failed')
    expect(cancelledRow?.failureReason).toBe('cancelled')
    expect(interruptedRow?.status).toBe('queued')
  })

  it('handles multiple running tasks in one pass', async () => {
    const { q, rr } = await loadModules(repo)
    const t1 = await q.enqueueTask('work 1', undefined, { skipTriage: true })
    const t2 = await q.enqueueTask('work 2', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
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
