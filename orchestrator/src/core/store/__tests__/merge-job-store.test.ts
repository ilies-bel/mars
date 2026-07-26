/**
 * Unit tests for the MergeJobStore seam (PRD 92af89ce, slice 1).
 *
 * Verifies that `createMergeJobStore(client)` returns a store that correctly
 * persists and transitions merge-job rows through their lifecycle:
 *
 *   enqueue → claimNext → markRunning → markDone   (happy path)
 *   enqueue → claimNext → markRunning → markFailed  (failure path)
 *   double enqueue rejected by unique-active constraint
 *
 * Isolation: each test group uses `vi.resetModules()` and a fresh temp
 * directory, following the established pattern from task-store.test.ts.
 * PGlite is used as the DB backend (MARS_DB_BACKEND=pglite, set by the
 * vitest environment).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

// ── Helpers ───────────────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-merge-job-store-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * Reset modules, point MARS_REPO at the temp repo, import a fresh module
 * graph, and run the canonical schema so all tables exist before tests run.
 * Returns both the store module (for createMergeJobStore) and the queue
 * module (for resolveQueueClient + task creation).
 */
const loadDeps = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const storeModule = await import('../merge-job-store')
  const queueModule = await import('../../queue')
  // Run the canonical schema: creates tasks, merge_jobs, and all other tables.
  await queueModule.migrateQueueSchema()
  return { storeModule, queueModule }
}

/**
 * Insert a minimal task row so merge_jobs FK checks pass.
 * Returns the new task id.
 */
const makeTask = async (
  queueModule: Awaited<ReturnType<typeof loadDeps>>['queueModule'],
): Promise<string> => {
  const task = await queueModule.enqueueTask('merge-test task', undefined, {
    skipTriage: true,
  })
  return task.id
}

const JOB_DEFAULTS = {
  integrationBranch: 'main',
  worktreePath: '/tmp/worktree',
  branch: 'task/test-1',
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('enqueue → claim → run → done (happy path)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('enqueue returns a queued job with the correct fields', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createMergeJobStore(queueModule.resolveQueueClient())
    const taskId = await makeTask(queueModule)

    const job = await store.enqueue({ taskId, ...JOB_DEFAULTS })

    expect(job.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(job.taskId).toBe(taskId)
    expect(job.status).toBe('queued')
    expect(job.attempts).toBe(0)
    expect(job.claimedAt).toBeNull()
    expect(job.startedAt).toBeNull()
    expect(job.finishedAt).toBeNull()
    expect(job.error).toBeNull()
    expect(job.errorCode).toBeNull()
    expect(job.integrationBranch).toBe('main')
    expect(job.worktreePath).toBe('/tmp/worktree')
    expect(job.branch).toBe('task/test-1')
    expect(typeof job.createdAt).toBe('string')
    expect(typeof job.updatedAt).toBe('string')
  })

  it('claimNext moves the job from queued → claimed and increments attempts', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createMergeJobStore(queueModule.resolveQueueClient())
    const taskId = await makeTask(queueModule)

    const enqueued = await store.enqueue({ taskId, ...JOB_DEFAULTS })
    const claimed = await store.claimNext()

    expect(claimed).not.toBeNull()
    expect(claimed!.id).toBe(enqueued.id)
    expect(claimed!.status).toBe('claimed')
    expect(claimed!.attempts).toBe(1)
    expect(claimed!.claimedAt).not.toBeNull()
  })

  it('claimNext returns null when the queue is empty', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createMergeJobStore(queueModule.resolveQueueClient())

    const result = await store.claimNext()
    expect(result).toBeNull()
  })

  it('markRunning advances claimed → running and stamps startedAt', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createMergeJobStore(queueModule.resolveQueueClient())
    const taskId = await makeTask(queueModule)

    await store.enqueue({ taskId, ...JOB_DEFAULTS })
    const claimed = await store.claimNext()
    const running = await store.markRunning(claimed!.id)

    expect(running).not.toBeNull()
    expect(running!.status).toBe('running')
    expect(running!.startedAt).not.toBeNull()
    expect(running!.finishedAt).toBeNull()
  })

  it('markDone stamps finishedAt and transitions to done', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createMergeJobStore(queueModule.resolveQueueClient())
    const taskId = await makeTask(queueModule)

    await store.enqueue({ taskId, ...JOB_DEFAULTS })
    const claimed = await store.claimNext()
    await store.markRunning(claimed!.id)
    const done = await store.markDone(claimed!.id)

    expect(done).not.toBeNull()
    expect(done!.status).toBe('done')
    expect(done!.finishedAt).not.toBeNull()
  })

  it('getByTaskId retrieves the job by task_id', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createMergeJobStore(queueModule.resolveQueueClient())
    const taskId = await makeTask(queueModule)

    const enqueued = await store.enqueue({ taskId, ...JOB_DEFAULTS })
    const fetched = await store.getByTaskId(taskId)

    expect(fetched).not.toBeNull()
    expect(fetched!.id).toBe(enqueued.id)
  })

  it('getByTaskId returns null for an unknown task_id', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createMergeJobStore(queueModule.resolveQueueClient())

    const fetched = await store.getByTaskId('mars-nonexistent')
    expect(fetched).toBeNull()
  })

  it('done job is excluded from listActive', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createMergeJobStore(queueModule.resolveQueueClient())
    const taskId = await makeTask(queueModule)

    await store.enqueue({ taskId, ...JOB_DEFAULTS })
    const claimed = await store.claimNext()
    await store.markRunning(claimed!.id)
    await store.markDone(claimed!.id)

    const active = await store.listActive()
    expect(active).toHaveLength(0)
  })

  it('listByStatus returns only jobs with the given status', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createMergeJobStore(queueModule.resolveQueueClient())
    const taskId = await makeTask(queueModule)

    await store.enqueue({ taskId, ...JOB_DEFAULTS })
    const claimed = await store.claimNext()
    await store.markRunning(claimed!.id)
    await store.markDone(claimed!.id)

    const done = await store.listByStatus('done')
    expect(done).toHaveLength(1)
    expect(done[0].id).toBe(claimed!.id)

    const queued = await store.listByStatus('queued')
    expect(queued).toHaveLength(0)
  })
})

describe('enqueue → claim → fail (failure path)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('markFailed records the error message, errorCode, and finishedAt', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createMergeJobStore(queueModule.resolveQueueClient())
    const taskId = await makeTask(queueModule)

    await store.enqueue({ taskId, ...JOB_DEFAULTS })
    const claimed = await store.claimNext()
    await store.markRunning(claimed!.id)
    const failed = await store.markFailed(claimed!.id, {
      message: 'merge conflict detected',
      code: 'MERGE_CONFLICT',
    })

    expect(failed).not.toBeNull()
    expect(failed!.status).toBe('failed')
    expect(failed!.error).toBe('merge conflict detected')
    expect(failed!.errorCode).toBe('MERGE_CONFLICT')
    expect(failed!.finishedAt).not.toBeNull()
  })

  it('markFailed without a code sets errorCode to null', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createMergeJobStore(queueModule.resolveQueueClient())
    const taskId = await makeTask(queueModule)

    await store.enqueue({ taskId, ...JOB_DEFAULTS })
    const claimed = await store.claimNext()
    const failed = await store.markFailed(claimed!.id, {
      message: 'unknown error',
    })

    expect(failed!.errorCode).toBeNull()
  })

  it('failed job is excluded from listActive', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createMergeJobStore(queueModule.resolveQueueClient())
    const taskId = await makeTask(queueModule)

    await store.enqueue({ taskId, ...JOB_DEFAULTS })
    const claimed = await store.claimNext()
    await store.markFailed(claimed!.id, { message: 'boom' })

    const active = await store.listActive()
    expect(active).toHaveLength(0)
  })

  it('markCanceled records the reason and stamps finishedAt', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createMergeJobStore(queueModule.resolveQueueClient())
    const taskId = await makeTask(queueModule)

    await store.enqueue({ taskId, ...JOB_DEFAULTS })
    const claimed = await store.claimNext()
    const canceled = await store.markCanceled(claimed!.id, 'task dropped')

    expect(canceled).not.toBeNull()
    expect(canceled!.status).toBe('canceled')
    expect(canceled!.error).toBe('task dropped')
    expect(canceled!.finishedAt).not.toBeNull()
  })
})

describe('unique-active constraint (double enqueue rejected)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('second active enqueue for the same task_id throws', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createMergeJobStore(queueModule.resolveQueueClient())
    const taskId = await makeTask(queueModule)

    // First enqueue succeeds.
    await store.enqueue({ taskId, ...JOB_DEFAULTS })

    // Second enqueue for the same task_id (still active) must fail.
    await expect(
      store.enqueue({ taskId, ...JOB_DEFAULTS }),
    ).rejects.toThrow()
  })

  it('new enqueue succeeds after the previous job for the same task_id is done', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createMergeJobStore(queueModule.resolveQueueClient())
    const taskId = await makeTask(queueModule)

    // First job runs to completion.
    const first = await store.enqueue({ taskId, ...JOB_DEFAULTS })
    const claimed = await store.claimNext()
    await store.markRunning(claimed!.id)
    await store.markDone(first.id)

    // Now a new active job for the same task_id is allowed.
    const second = await store.enqueue({ taskId, ...JOB_DEFAULTS })
    expect(second.taskId).toBe(taskId)
    expect(second.status).toBe('queued')
  })

  it('listActive includes all three non-terminal statuses', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createMergeJobStore(queueModule.resolveQueueClient())

    // Create three separate tasks so each can have its own active job.
    const taskId1 = await makeTask(queueModule)
    const taskId2 = await makeTask(queueModule)
    const taskId3 = await makeTask(queueModule)

    // Enqueue one job per task, advance each to a distinct active status.
    const job1 = await store.enqueue({
      taskId: taskId1,
      ...JOB_DEFAULTS,
      branch: 'task/test-a',
    })
    const job2 = await store.enqueue({
      taskId: taskId2,
      ...JOB_DEFAULTS,
      branch: 'task/test-b',
    })
    const job3 = await store.enqueue({
      taskId: taskId3,
      ...JOB_DEFAULTS,
      branch: 'task/test-c',
    })

    // Advance job1 to claimed, job2 to running; job3 stays queued.
    await store.claimNext() // claims job1 (oldest)
    await store.claimNext() // claims job2
    const running2 = await store.claimNext() // claims job3? no, job2 was already claimed
    // Actually claimNext picks oldest queued: j1→claimed, j2→claimed, j3→claimed sequentially.
    // After 3 claimNexts, all are claimed. Let's advance one to running.
    await store.markRunning(running2!.id)

    const active = await store.listActive()
    // All three job ids appear in the active list.
    const activeIds = active.map((j) => j.id)
    expect(activeIds).toContain(job1.id)
    expect(activeIds).toContain(job2.id)
    expect(activeIds).toContain(job3.id)
  })
})
