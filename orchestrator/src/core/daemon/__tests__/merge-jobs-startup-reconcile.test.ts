/**
 * Tests for `reconcileMergeJobs` — the startup reconciler that re-hydrates
 * the durable merge queue from task state left by a prior daemon.
 *
 * Three DB states are seeded:
 *  1. orphan-merging-task  — task.status='merging' with no merge_jobs row
 *  2. stuck-claimed job    — merge_jobs row in 'claimed' status
 *  3. stuck-running job    — merge_jobs row in 'running' status
 *
 * Each scenario is asserted to normalise to exactly one queued merge_jobs row
 * after `reconcileMergeJobs` runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

// ── Helpers ───────────────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-merge-jobs-startup-reconcile-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * Reset modules, point MARS_REPO at the temp repo, import a fresh module
 * graph, run the canonical schema, and return the three objects the tests need.
 */
const loadDeps = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo

  // Queue module provides the DB client, schema migration, and task helpers.
  const queueModule = await import('../../queue')
  await queueModule.migrateQueueSchema()

  // Store modules bound to the same DB connection.
  const mergeJobStoreModule = await import('../../store/merge-job-store')
  const taskStoreModule = await import('../../store/task-store')

  // The function under test.
  const startupModule = await import('../startup-reconcile')

  const client = queueModule.resolveQueueClient()
  const store = mergeJobStoreModule.createMergeJobStore(client)
  const taskStore = taskStoreModule.createTaskStore(client)

  return { queueModule, store, taskStore, startupModule }
}

const JOB_DEFAULTS = {
  integrationBranch: 'main',
  worktreePath: '/tmp/worktree',
  branch: 'task/test-1',
}

// ── Three-scenario combined test ──────────────────────────────────────────────

describe('reconcileMergeJobs — all three startup DB states', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('normalises orphan-merging-task, stuck-claimed, and stuck-running to single queued jobs', async () => {
    const { queueModule, store, taskStore, startupModule } = await loadDeps(repo)

    // ── Scenario 1: orphan merging task ─────────────────────────────────────
    const orphanTask = await queueModule.enqueueTask('orphan merging task', undefined, {
      skipTriage: true,
    })
    // Force task into 'merging' status with worktree info via raw SQL (mirroring
    // the pattern in restart-verb-statuses.test.ts).
    await queueModule.resolveQueueClient().execute({
      sql: `UPDATE tasks
            SET status = 'merging',
                worktree_path = '/tmp/orphan-wt',
                branch = 'task/orphan'
            WHERE id = ?`,
      args: [orphanTask.id],
    })
    // No merge_jobs row for this task — it is orphaned.

    // ── Scenario 2: stuck-claimed job ────────────────────────────────────────
    const claimedTask = await queueModule.enqueueTask('claimed task', undefined, {
      skipTriage: true,
    })
    await store.enqueue({
      taskId: claimedTask.id,
      integrationBranch: 'main',
      worktreePath: '/tmp/claimed-wt',
      branch: 'task/claimed',
    })
    await store.claimNext() // moves the job to 'claimed', attempts=1

    // ── Scenario 3: stuck-running job ────────────────────────────────────────
    const runningTask = await queueModule.enqueueTask('running task', undefined, {
      skipTriage: true,
    })
    await store.enqueue({
      taskId: runningTask.id,
      integrationBranch: 'main',
      worktreePath: '/tmp/running-wt',
      branch: 'task/running',
    })
    const claimedRunning = await store.claimNext() // moves to 'claimed', attempts=1
    await store.markRunning(claimedRunning!.id) // moves to 'running'

    // ── Run the reconciler ────────────────────────────────────────────────────
    const logs: string[] = []
    const result = await startupModule.reconcileMergeJobs({
      store,
      taskStore,
      log: (line) => logs.push(line),
    })

    // ── Assertions ────────────────────────────────────────────────────────────

    // Return counts
    expect(result.resetCount).toBe(2)   // claimed + running reset
    expect(result.rebuiltCount).toBe(1) // orphan merging task rebuilt

    // Scenario 1: orphan merging task now has a queued job
    const orphanJob = await store.getByTaskId(orphanTask.id)
    expect(orphanJob).not.toBeNull()
    expect(orphanJob!.status).toBe('queued')
    expect(orphanJob!.taskId).toBe(orphanTask.id)
    expect(orphanJob!.worktreePath).toBe('/tmp/orphan-wt')
    expect(orphanJob!.branch).toBe('task/orphan')
    expect(orphanJob!.integrationBranch).toBe('main')

    // Scenario 2: stuck-claimed job is reset to queued with incremented attempts
    const claimedJob = await store.getByTaskId(claimedTask.id)
    expect(claimedJob).not.toBeNull()
    expect(claimedJob!.status).toBe('queued')
    expect(claimedJob!.attempts).toBe(2) // 1 from claimNext + 1 from reset
    expect(claimedJob!.claimedAt).toBeNull()
    expect(claimedJob!.startedAt).toBeNull()

    // Scenario 3: stuck-running job is reset to queued with incremented attempts
    const runningJob = await store.getByTaskId(runningTask.id)
    expect(runningJob).not.toBeNull()
    expect(runningJob!.status).toBe('queued')
    expect(runningJob!.attempts).toBe(2) // 1 from claimNext + 1 from reset
    expect(runningJob!.claimedAt).toBeNull()
    expect(runningJob!.startedAt).toBeNull()

    // Warn logs were emitted for each reset job
    const warnLogs = logs.filter((l) => l.includes('merge-jobs-startup'))
    expect(warnLogs.length).toBeGreaterThanOrEqual(3) // 2 resets + 1 rebuild
  })
})

// ── Individual scenario tests for detailed assertions ─────────────────────────

describe('reconcileMergeJobs — stuck-claimed job', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('resets a claimed job back to queued, increments attempts, clears claimed_at', async () => {
    const { queueModule, store, taskStore, startupModule } = await loadDeps(repo)

    const task = await queueModule.enqueueTask('test', undefined, { skipTriage: true })
    await store.enqueue({ taskId: task.id, ...JOB_DEFAULTS })
    const claimed = await store.claimNext()
    expect(claimed!.status).toBe('claimed')
    expect(claimed!.attempts).toBe(1)

    const result = await startupModule.reconcileMergeJobs({
      store,
      taskStore,
      log: () => {},
    })

    expect(result.resetCount).toBe(1)
    expect(result.rebuiltCount).toBe(0)

    const job = await store.getByTaskId(task.id)
    expect(job!.status).toBe('queued')
    expect(job!.attempts).toBe(2)
    expect(job!.claimedAt).toBeNull()
    expect(job!.startedAt).toBeNull()
  })

  it('emits a warn log containing the previous status', async () => {
    const { queueModule, store, taskStore, startupModule } = await loadDeps(repo)

    const task = await queueModule.enqueueTask('test', undefined, { skipTriage: true })
    await store.enqueue({ taskId: task.id, ...JOB_DEFAULTS })
    await store.claimNext()

    const logs: string[] = []
    await startupModule.reconcileMergeJobs({ store, taskStore, log: (l) => logs.push(l) })

    const warnLine = logs.find((l) => l.includes('claimed'))
    expect(warnLine).toBeDefined()
    expect(warnLine).toContain('merge-jobs-startup')
  })
})

describe('reconcileMergeJobs — stuck-running job', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('resets a running job back to queued, increments attempts, clears started_at', async () => {
    const { queueModule, store, taskStore, startupModule } = await loadDeps(repo)

    const task = await queueModule.enqueueTask('test', undefined, { skipTriage: true })
    await store.enqueue({ taskId: task.id, ...JOB_DEFAULTS })
    const claimed = await store.claimNext()
    await store.markRunning(claimed!.id)

    const result = await startupModule.reconcileMergeJobs({
      store,
      taskStore,
      log: () => {},
    })

    expect(result.resetCount).toBe(1)
    expect(result.rebuiltCount).toBe(0)

    const job = await store.getByTaskId(task.id)
    expect(job!.status).toBe('queued')
    expect(job!.attempts).toBe(2)
    expect(job!.startedAt).toBeNull()
    expect(job!.claimedAt).toBeNull()
  })
})

describe('reconcileMergeJobs — orphan merging task', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('rebuilds a queued merge job for a task in merging status with no active job', async () => {
    const { queueModule, store, taskStore, startupModule } = await loadDeps(repo)

    const task = await queueModule.enqueueTask('merging task', undefined, { skipTriage: true })
    await queueModule.resolveQueueClient().execute({
      sql: `UPDATE tasks
            SET status = 'merging',
                worktree_path = '/tmp/merging-wt',
                branch = 'task/merging-test'
            WHERE id = ?`,
      args: [task.id],
    })

    const result = await startupModule.reconcileMergeJobs({
      store,
      taskStore,
      log: () => {},
    })

    expect(result.resetCount).toBe(0)
    expect(result.rebuiltCount).toBe(1)

    const job = await store.getByTaskId(task.id)
    expect(job).not.toBeNull()
    expect(job!.status).toBe('queued')
    expect(job!.taskId).toBe(task.id)
    expect(job!.worktreePath).toBe('/tmp/merging-wt')
    expect(job!.branch).toBe('task/merging-test')
    expect(job!.integrationBranch).toBe('main')
    expect(job!.attempts).toBe(0)
  })

  it('does not rebuild a job when an active merge_jobs row already exists', async () => {
    const { queueModule, store, taskStore, startupModule } = await loadDeps(repo)

    const task = await queueModule.enqueueTask('merging with job', undefined, { skipTriage: true })
    await queueModule.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'merging', worktree_path = '/tmp/wt', branch = 'task/x' WHERE id = ?`,
      args: [task.id],
    })
    // Already has a queued merge job.
    await store.enqueue({
      taskId: task.id,
      integrationBranch: 'main',
      worktreePath: '/tmp/wt',
      branch: 'task/x',
    })

    const result = await startupModule.reconcileMergeJobs({
      store,
      taskStore,
      log: () => {},
    })

    expect(result.rebuiltCount).toBe(0)

    // The existing queued job is untouched.
    const active = await store.listActive()
    expect(active).toHaveLength(1)
    expect(active[0].status).toBe('queued')
  })

  it('is a no-op when the DB is clean', async () => {
    const { store, taskStore, startupModule } = await loadDeps(repo)

    const result = await startupModule.reconcileMergeJobs({
      store,
      taskStore,
      log: () => {},
    })

    expect(result.resetCount).toBe(0)
    expect(result.rebuiltCount).toBe(0)
  })
})
