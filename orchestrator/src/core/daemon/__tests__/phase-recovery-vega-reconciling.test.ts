/**
 * Regression tests for `recoverPhase('vega-reconciling', …)` — the startup
 * reconciler that handles tasks stranded in `vega-reconciling` status after a
 * daemon restart.
 *
 * Background: `vega-reconciling` is a sub-phase of `merging`. It means the
 * deterministic fast-forward failed, a rebase conflict was detected, and the
 * vcs-supervisor (Vega) was spawned to reconcile it. The task stays in this
 * status for the full duration of the Vega session. When the daemon dies while
 * Vega is running, the worktree may be in a partially-applied interactive
 * rebase state that is NOT safe to hand to the checkpoint-resume engine.
 *
 * Correct recovery behaviour:
 *  - If the branch already landed in the integration branch before the daemon
 *    died: finalize the task to `done`.
 *  - If the branch has NOT landed: always discard the worktree (forceCleanWorktree)
 *    and requeue from setup so the next dispatch starts a fresh worktree and
 *    reruns the merge from scratch, rather than re-entering a corrupt rebase
 *    environment.
 *
 * The pre-fix behaviour (before this reconciler was added) was to leave every
 * `vega-reconciling` task stranded after a daemon restart — no reconciler
 * handled that status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  addBlockers: typeof import('../../queue').addBlockers
  updateTask: typeof import('../../queue').updateTask
}

interface RecoverPhaseModule {
  recoverPhase: typeof import('../phase-recovery').recoverPhase
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

/**
 * Create a minimal git repo with one commit on `main` so we can create
 * and fast-forward branches.
 */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-vr-recovery-'))
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: repo, env: GIT_ENV })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, env: GIT_ENV })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; recovery: RecoverPhaseModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const recovery = (await import('../phase-recovery')) as unknown as RecoverPhaseModule
  return { q, recovery }
}

const nullLog = () => {}

const makeBus = (): EventEmitter & { events: Array<[string, unknown]> } => {
  const events: Array<[string, unknown]> = []
  const bus = new EventEmitter() as EventEmitter & { events: Array<[string, unknown]> }
  bus.events = events
  const origEmit = bus.emit.bind(bus)
  bus.emit = (event: string, ...args: unknown[]): boolean => {
    events.push([event, args[0]])
    return origEmit(event, ...args)
  }
  return bus
}

describe('recoverPhase("vega-reconciling") — daemon restart recovery', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Pre-fix regression: stuck tasks were never recovered ──────────────────

  it('requeues a vega-reconciling task from setup when the branch is not merged', async () => {
    // This is the primary regression: before the fix, no reconciler handled
    // the vega-reconciling status, leaving the task stranded forever.
    const { q, recovery } = await loadModules(repo)
    const task = await q.enqueueTask('merge conflict work', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'vega-reconciling', branch = ?, worktree_path = ? WHERE id = ?`,
      args: [`task/${task.id}`, `/tmp/nonexistent-wt-${task.id}`, task.id],
    })

    const bus = makeBus()
    const result = await recovery.recoverPhase('vega-reconciling', {
      log: nullLog,
      bus,
      repoRoot: repo,
    })

    // Task is requeued from setup (not left stranded in vega-reconciling).
    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('queued')
    // git pointers cleared — next dispatch starts fresh setup
    expect(updated?.branch).toBeNull()
    expect(updated?.worktreePath).toBeNull()

    expect(result.requeued).toContain(task.id)
    expect(result.finalized).toBe(0)

    // task.queued is emitted so the dispatch loop picks the task up
    expect(bus.events.some(([e]) => e === 'task.queued')).toBe(true)
  })

  // ── forceCleanWorktree: worktree on disk is ALWAYS discarded ─────────────

  it('clears the worktree even when it still exists on disk (mid-rebase state)', async () => {
    // Key invariant: unlike merging-recovery, vega-reconciling NEVER tries to
    // preserve the worktree for checkpoint resume because the rebase may be
    // partially applied (interactive rebase in progress). forceCleanWorktree
    // forces the clean path regardless of whether existsSync returns true.
    const { q, recovery } = await loadModules(repo)
    const task = await q.enqueueTask('conflict with live worktree', undefined, { skipTriage: true })

    // Create a real directory on disk to simulate a surviving worktree.
    const liveWorktreePath = mkdtempSync(resolve(tmpdir(), `mars-live-wt-${task.id}-`))

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks
              SET status = 'vega-reconciling',
                  branch = ?,
                  worktree_path = ?,
                  claude_session_id = 'vega-session-xyz',
                  error = 'prior vega error',
                  failed_phase = 'merge'
            WHERE id = ?`,
      args: [`task/${task.id}`, liveWorktreePath, task.id],
    })

    // Sanity: the directory IS on disk before recovery.
    expect(existsSync(liveWorktreePath)).toBe(true)

    const bus = makeBus()
    await recovery.recoverPhase('vega-reconciling', {
      log: nullLog,
      bus,
      repoRoot: repo,
    })

    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('queued')
    // branch and worktreePath MUST be cleared — checkpoint resume with a
    // mid-rebase worktree would corrupt the next dispatch.
    expect(updated?.branch).toBeNull()
    expect(updated?.worktreePath).toBeNull()
    // Transient fields also cleared
    expect(updated?.claudeSessionId).toBeNull()
    expect(updated?.error).toBeNull()
    expect(updated?.failedPhase).toBeNull()

    // Clean up the live worktree directory (may already be removed by recoverPhase).
    rmSync(liveWorktreePath, { recursive: true, force: true })
  })

  // ── Finalize path: branch already landed before daemon died ──────────────

  it('finalizes to done when the branch is already merged into the integration branch', async () => {
    // Simulate: the vcs-supervisor finished its work and the fast-forward
    // landed just before the daemon died. The task is stuck in vega-reconciling
    // but the work is already on main.
    const branch = 'task/already-merged'

    // Create a task branch with a commit and fast-forward it into main.
    execFileSync('git', ['checkout', '-b', branch], { cwd: repo, env: GIT_ENV })
    execFileSync('git', ['commit', '--allow-empty', '-m', 'task work'], { cwd: repo, env: GIT_ENV })
    execFileSync('git', ['checkout', 'main'], { cwd: repo, env: GIT_ENV })
    execFileSync('git', ['merge', '--ff-only', branch], { cwd: repo, env: GIT_ENV })

    const { q, recovery } = await loadModules(repo)
    const task = await q.enqueueTask('already merged work', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'vega-reconciling', branch = ? WHERE id = ?`,
      args: [branch, task.id],
    })

    const bus = makeBus()
    const result = await recovery.recoverPhase('vega-reconciling', {
      log: nullLog,
      bus,
      repoRoot: repo,
    })

    // Task finalized to done — the work already landed.
    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('done')

    expect(result.finalized).toBe(1)
    expect(result.requeued).not.toContain(task.id)
    // No task.queued event — we finalized, not requeued.
    expect(bus.events.filter(([e]) => e === 'task.queued')).toHaveLength(0)
  })

  // ── Blocker handling ──────────────────────────────────────────────────────

  it('restores to blocked (not queued) when the task has incomplete blockers', async () => {
    const { q, recovery } = await loadModules(repo)
    const blocker = await q.enqueueTask('blocking work', undefined, { skipTriage: true })
    const task = await q.enqueueTask('blocked vega task', undefined, { skipTriage: true })

    await q.addBlockers(task.id, [blocker.id])

    // Blocker is still queued (not done) — task has an incomplete blocker.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'vega-reconciling' WHERE id = ?`,
      args: [task.id],
    })

    const bus = makeBus()
    const result = await recovery.recoverPhase('vega-reconciling', {
      log: nullLog,
      bus,
      repoRoot: repo,
    })

    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('blocked')
    expect(result.requeued).not.toContain(task.id)
    // No task.queued event when blocked
    expect(bus.events.filter(([e]) => e === 'task.queued')).toHaveLength(0)
  })

  // ── No-op when nothing is stuck ───────────────────────────────────────────

  it('returns empty results when there are no vega-reconciling tasks', async () => {
    const { q, recovery } = await loadModules(repo)
    await q.enqueueTask('normal queued task', undefined, { skipTriage: true })

    const bus = makeBus()
    const result = await recovery.recoverPhase('vega-reconciling', {
      log: nullLog,
      bus,
      repoRoot: repo,
    })

    expect(result.requeued).toHaveLength(0)
    expect(result.finalized).toBe(0)
    expect(result.blocked).toBe(0)
  })
})
