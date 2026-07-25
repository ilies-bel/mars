/**
 * Regression tests for `recoverPhase('verifying', ...)` — the startup
 * reconciler that handles tasks stranded in verifying status after a daemon
 * restart.
 *
 * Bug (mars-a60f2b80): after a daemon restart, a recovery task (fix-xxx) can
 * remain `status=verifying` even though its `workflow_runs.status=failed`.
 * The prior reconciler took the `'recover'` path when the worktree was still
 * on disk, preserved its stale step checkpoints, and requeued the task.
 * The next dispatch found `setup-worktree: completed` and `fix-code: completed`
 * in the checkpoint journal, skipped those steps, and jumped straight to
 * verify — which failed again with "working directory no longer exists".
 *
 * Fix: when the worktree is on disk BUT the workflow run is terminal failed,
 * treat the situation as "worktree gone": delete the checkpoint journal and
 * clear branch/worktreePath so the next dispatch reruns from setup with a
 * fresh worktree.
 *
 * Bug (mars-0207f3b1): after a daemon restart, tasks that were in `verifying`
 * but whose branch had ALREADY been fast-forwarded into main were incorrectly
 * marked `failed`. The prior classify only checked for a surviving worktree
 * directory; a gone worktree was always treated as "nothing to resume", even
 * when the work was already on main (the common post-merge cleanup case).
 *
 * Fix: when the worktree is absent, probe `isBranchMergedIntoMain` before
 * declaring failure. If the branch already landed, finalize to `done` (same
 * path as `merging` and `vega-reconciling`).
 *
 * These tests cover:
 *   ✓ Verifying task: on-disk worktree + failed run → checkpoints cleared, task queued from setup
 *   ✓ Verifying task: no worktree on disk → task marked failed (existing behaviour)
 *   ✓ Verifying task: on-disk worktree + no failed run → worktree preserved (existing behaviour)
 *   ✓ Verifying task: worktree absent + branch already merged → finalized to done (new)
 *   ✓ Verifying task: worktree absent + branch absent in git → still failed (new)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  updateTask: typeof import('../../queue').updateTask
}

interface QueueWorkflowStoreModule {
  createQueueWorkflowStore: typeof import('../../../workflows/queue-workflow-store').createQueueWorkflowStore
}

interface RecoverPhaseModule {
  recoverPhase: typeof import('../phase-recovery').recoverPhase
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-phase-recovery-verifying-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{
  q: QueueModule
  store: QueueWorkflowStoreModule
  recovery: RecoverPhaseModule
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const store = (await import(
    '../../../workflows/queue-workflow-store'
  )) as unknown as QueueWorkflowStoreModule
  const recovery = (await import(
    '../phase-recovery'
  )) as unknown as RecoverPhaseModule
  return { q, store, recovery }
}

const nullLog = () => {}
const makeBus = (): EventEmitter & { events: Array<[string, unknown]> } => {
  const events: Array<[string, unknown]> = []
  const bus = new EventEmitter() as EventEmitter & {
    events: Array<[string, unknown]>
  }
  bus.events = events
  const origEmit = bus.emit.bind(bus)
  bus.emit = (event: string, ...args: unknown[]): boolean => {
    events.push([event, args[0]])
    return origEmit(event, ...args)
  }
  return bus
}

describe('recoverPhase("verifying") — stale checkpoint detection', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Core regression: on-disk worktree + failed run → treat as worktree-gone ─

  it('clears stale checkpoints and requeues from setup when worktree is on disk but run is failed', async () => {
    const { q, store, recovery } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const task = await q.enqueueTask('stale verifier', undefined, { skipTriage: true })

    // Create a fake worktree directory on disk so exists() returns true.
    const fakeWorktreePath = mkdtempSync(
      resolve(tmpdir(), `mars-fake-worktree-${task.id}-`),
    )
    // Simulate the task stranded in verifying with a branch and worktree.
    await client.execute({
      sql: `UPDATE tasks
              SET status = 'verifying',
                  branch = ?,
                  worktree_path = ?
              WHERE id = ?`,
      args: [`task/${task.id}`, fakeWorktreePath, task.id],
    })

    // Seed the workflow_runs table with a failed run record (as the engine
    // would after a verify step failure — "working directory no longer exists").
    const wfStore = store.createQueueWorkflowStore()
    await wfStore.createRun({
      id: task.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await wfStore.putStep({
      runId: task.id,
      name: 'setup-worktree',
      status: 'completed',
      sha: null,
      startedAt: Date.now(),
      finishedAt: Date.now() + 100,
      attempt: 1,
      summary: 'worktree created',
      errorSummary: null,
      transcriptKey: null,
      resultJson: '"done"',
    })
    await wfStore.setRunStatus(task.id, 'failed', Date.now() + 200)

    // Sanity: stale journal present before reconciliation.
    expect(await wfStore.getRun(task.id)).toBeDefined()
    expect(await wfStore.listSteps(task.id)).toHaveLength(1)

    const bus = makeBus()
    const result = await recovery.recoverPhase('verifying', {
      log: nullLog,
      bus,
      repoRoot: repo,
    })

    // Task must be requeued (not failed) — we detected the failed run and
    // treated the situation as "worktree gone", clearing the checkpoints.
    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('queued')
    // branch and worktreePath must be nulled out so the next dispatch runs
    // setup from scratch and creates a new worktree.
    expect(updated?.branch).toBeNull()
    expect(updated?.worktreePath).toBeNull()

    // Checkpoint journal must be gone: the next dispatch will not skip setup.
    expect(await wfStore.getRun(task.id)).toBeUndefined()
    expect(await wfStore.listSteps(task.id)).toEqual([])

    // Result counts: 1 requeued, 0 failed.
    expect(result.requeued).toContain(task.id)
    expect(result.failed).toBe(0)

    // Requeued tasks emit task.queued for dispatch (emitOnRequeue=true for verifying).
    expect(bus.events.some(([event]) => event === 'task.queued')).toBe(true)

    // Cleanup the fake worktree dir (recoverPhase may have already removed it).
    rmSync(fakeWorktreePath, { recursive: true, force: true })
  })

  // ── Existing behaviour: no worktree → mark failed ─────────────────────────

  it('marks failed when the worktree directory does not exist on disk', async () => {
    const { q, store, recovery } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const task = await q.enqueueTask('missing worktree task', undefined, { skipTriage: true })
    // Point the task at a path that doesn't exist.
    await client.execute({
      sql: `UPDATE tasks
              SET status = 'verifying',
                  branch = ?,
                  worktree_path = ?
              WHERE id = ?`,
      args: [`task/${task.id}`, `/nonexistent/path/${task.id}`, task.id],
    })

    const bus = makeBus()
    const result = await recovery.recoverPhase('verifying', {
      log: nullLog,
      bus,
      repoRoot: repo,
    })

    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('failed')
    expect(result.failed).toBe(1)
    expect(result.requeued).not.toContain(task.id)
  })

  // ── Existing behaviour: on-disk worktree + no failed run → preserve it ─────

  it('preserves the on-disk worktree and requeues with branch intact when the run is not failed', async () => {
    const { q, store, recovery } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const task = await q.enqueueTask('resumable verifier', undefined, { skipTriage: true })

    const fakeWorktreePath = mkdtempSync(
      resolve(tmpdir(), `mars-fake-worktree-live-${task.id}-`),
    )
    const fakeBranch = `task/${task.id}`
    await client.execute({
      sql: `UPDATE tasks
              SET status = 'verifying',
                  branch = ?,
                  worktree_path = ?
              WHERE id = ?`,
      args: [fakeBranch, fakeWorktreePath, task.id],
    })

    // No workflow run entry → the run is considered live (not failed).
    // The reconciler should NOT clear the worktree pointer.
    const wfStore = store.createQueueWorkflowStore()
    expect(await wfStore.getRun(task.id)).toBeUndefined()

    const bus = makeBus()
    await recovery.recoverPhase('verifying', {
      log: nullLog,
      bus,
      repoRoot: repo,
    })

    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('queued')
    // Worktree pointer must be preserved — the engine can resume from the
    // existing worktree without re-running setup.
    expect(updated?.branch).toBe(fakeBranch)
    expect(updated?.worktreePath).toBe(fakeWorktreePath)

    rmSync(fakeWorktreePath, { recursive: true, force: true })
  })
})

// ── Git environment for branch/commit operations ─────────────────────────────
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

/**
 * Create a repo with an initial commit on `main` so `isBranchMergedIntoMain`
 * has a valid integration ref to probe against.
 */
const setupRepoWithMain = (): string => {
  const r = mkdtempSync(resolve(tmpdir(), 'mars-phase-recovery-verifying-main-'))
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: r, env: GIT_ENV })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: r, env: GIT_ENV })
  mkdirSync(resolve(r, '.mars'), { recursive: true })
  return r
}

// ── Regression: verifying + absent worktree + branch merged/absent ────────────

describe('recoverPhase("verifying") — merged-branch finalize detection', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepoWithMain()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('finalizes to done when the worktree is absent but the branch is already merged into main', async () => {
    // Simulate: the verify step ran, the merge succeeded and cleaned up the
    // worktree, but the daemon died before the task could be finalized.
    // The branch should be detected as merged and the task finalized to done.
    const branch = 'task/already-merged-verify'

    execFileSync('git', ['checkout', '-b', branch], { cwd: repo, env: GIT_ENV })
    execFileSync('git', ['commit', '--allow-empty', '-m', 'task work'], {
      cwd: repo,
      env: GIT_ENV,
    })
    execFileSync('git', ['checkout', 'main'], { cwd: repo, env: GIT_ENV })
    execFileSync('git', ['merge', '--ff-only', branch], { cwd: repo, env: GIT_ENV })

    const { q, recovery } = await loadModules(repo)
    const task = await q.enqueueTask('already merged verifying task', undefined, {
      skipTriage: true,
    })

    // Strand the task in verifying: branch is the merged one, no worktree.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'verifying', branch = ?, worktree_path = NULL WHERE id = ?`,
      args: [branch, task.id],
    })

    const bus = makeBus()
    const result = await recovery.recoverPhase('verifying', {
      log: nullLog,
      bus,
      repoRoot: repo,
    })

    // Must be finalized to done, not failed.
    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('done')

    expect(result.finalized).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.requeued).not.toContain(task.id)
    // No task.queued event — we finalized, not requeued.
    expect(bus.events.filter(([e]) => e === 'task.queued')).toHaveLength(0)
  })

  it('marks failed when the worktree is absent and the branch does not exist in git', async () => {
    // No task branch was ever created in this repo — the git ref is absent.
    // The reconciler must still declare the task failed (not finalize it).
    const { q, recovery } = await loadModules(repo)
    const task = await q.enqueueTask('ghost branch verifying task', undefined, {
      skipTriage: true,
    })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'verifying', branch = ?, worktree_path = NULL WHERE id = ?`,
      args: [`task/${task.id}`, task.id],
    })

    const bus = makeBus()
    const result = await recovery.recoverPhase('verifying', {
      log: nullLog,
      bus,
      repoRoot: repo,
    })

    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('failed')
    expect(result.failed).toBe(1)
    expect(result.finalized).toBe(0)
    expect(result.requeued).not.toContain(task.id)
  })
})
