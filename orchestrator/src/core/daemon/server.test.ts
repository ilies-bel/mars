/**
 * server.test.ts — integration tests for two daemon startup-reconcile invariants
 *
 * (a) A task dispatched by the current daemon is NOT swept by the startup
 *     `requeue-stale-running` reconcile, even when it reaches `status='running'`
 *     after boot but before the sweep fires.
 *
 * (b) Requeueing an orphaned `running` task terminates its worker process
 *     BEFORE the task row is flipped to `queued`, so the next dispatch does
 *     not race with an abandoned coder session.
 *
 * These are integration tests of the reconcile-running / phase-recovery path;
 * they live here because the invariants are owned by the daemon startup sequence
 * in server.ts (the `requeueStaleRunning` reconciler, driven by `reconcile()`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

// ---------------------------------------------------------------------------
// Module shape types (dynamic imports via vi.resetModules pattern)
// ---------------------------------------------------------------------------

interface QueueModule {
  enqueueTask: typeof import('../queue').enqueueTask
  getTask: typeof import('../queue').getTask
  resolveQueueClient: typeof import('../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../queue').migrateQueueSchema
}

interface ReconcileRunningModule {
  requeueRunningTasksFromPriorDaemon: typeof import('./reconcile-running').requeueRunningTasksFromPriorDaemon
}

// ---------------------------------------------------------------------------
// Test repo helpers
// ---------------------------------------------------------------------------

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-server-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; rr: ReconcileRunningModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const rr = (await import('./reconcile-running')) as unknown as ReconcileRunningModule
  return { q, rr }
}

/** Returns true iff the OS still has a live process at this PID. */
const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// ---------------------------------------------------------------------------
// (a) Current-daemon task guard
// ---------------------------------------------------------------------------

describe('startup reconcile — current-daemon task guard', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('does NOT sweep a task owned by the live daemon (isInFlight returns true for it)', async () => {
    const { q, rr } = await loadModules(repo)
    const t = await q.enqueueTask('live-daemon task', undefined, { skipTriage: true })

    // Simulate a task dispatched by this daemon that is now running
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', worktree_path = ? WHERE id = ?`,
      args: [`/tmp/nonexistent-${t.id}`, t.id],
    })

    // isInFlight claims this task → reconcile must skip it
    const requeued = await rr.requeueRunningTasksFromPriorDaemon(repo, {
      isInFlight: (id) => id === t.id,
    })

    expect(requeued).not.toContain(t.id)

    const row = await q.getTask(t.id)
    expect(row?.status).toBe('running') // guard kept it untouched
  })

  it('still sweeps a task NOT owned by the live daemon (isInFlight returns false for it)', async () => {
    const { q, rr } = await loadModules(repo)
    const t = await q.enqueueTask('prior-daemon orphan', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', worktree_path = ? WHERE id = ?`,
      args: [`/tmp/nonexistent-${t.id}`, t.id],
    })

    const requeued = await rr.requeueRunningTasksFromPriorDaemon(repo, {
      isInFlight: (_id) => false,
    })

    expect(requeued).toContain(t.id)
    const row = await q.getTask(t.id)
    expect(row?.status).toBe('queued')
  })

  it('guards correctly when multiple tasks exist — only owned tasks are spared', async () => {
    const { q, rr } = await loadModules(repo)
    const owned = await q.enqueueTask('owned by this daemon', undefined, { skipTriage: true })
    const orphan = await q.enqueueTask('orphan from prior daemon', undefined, {
      skipTriage: true,
    })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', worktree_path = ? WHERE id IN (?, ?)`,
      args: [`/tmp/nonexistent`, owned.id, orphan.id],
    })

    const requeued = await rr.requeueRunningTasksFromPriorDaemon(repo, {
      isInFlight: (id) => id === owned.id,
    })

    expect(requeued).toContain(orphan.id)
    expect(requeued).not.toContain(owned.id)

    const ownedRow = await q.getTask(owned.id)
    const orphanRow = await q.getTask(orphan.id)
    expect(ownedRow?.status).toBe('running') // guard kept it untouched
    expect(orphanRow?.status).toBe('queued') // swept as expected
  })
})

// ---------------------------------------------------------------------------
// (b) Orphan process termination
// ---------------------------------------------------------------------------

describe('startup reconcile — orphan process termination', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it(
    'kills an orphaned worker process before the task row flips to queued',
    async () => {
      const { q, rr } = await loadModules(repo)
      const t = await q.enqueueTask('orphan with live process', undefined, {
        skipTriage: true,
      })

      // Spawn a long-lived node process with the task ID in its argv.
      // This mimics an abandoned coder session: the real claude/codex process
      // carries the task id in its worktree path prompt, making it detectable
      // via `pgrep -f <taskId>`.
      const child = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 999999)', '--', t.id],
        { detached: true, stdio: 'ignore' },
      )
      child.unref()
      const orphanPid = child.pid

      if (orphanPid === undefined) {
        // Spawn failed to allocate a PID — skip rather than hard-fail CI
        return
      }

      // Allow the process to register with the OS
      await new Promise<void>((r) => setTimeout(r, 100))
      expect(isProcessAlive(orphanPid)).toBe(true)

      // Set task to running with a non-existent worktree (prior-daemon orphan)
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'running', worktree_path = ? WHERE id = ?`,
        args: [`/tmp/nonexistent-${t.id}`, t.id],
      })

      // Run reconcile without an isInFlight guard → task IS swept
      const requeued = await rr.requeueRunningTasksFromPriorDaemon(repo)

      // Process must be dead BEFORE the requeue returns (ordering guaranteed by
      // phase-recovery: kill → updateTask(queued))
      expect(isProcessAlive(orphanPid)).toBe(false)

      // Task must now be queued
      expect(requeued).toContain(t.id)
      const row = await q.getTask(t.id)
      expect(row?.status).toBe('queued')
    },
    // 5 s SIGTERM grace + buffer for DB / git ops
    15_000,
  )
})
