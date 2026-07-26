/**
 * Regression test: coreRestartTask must refuse when the target task has an
 * active merge_jobs row (status IN queued/claimed/running).
 *
 * 2026-07-21 incident: bulk restart deleted worktrees under in-flight merges.
 * The guard added in this slice prevents that by refusing restart if a merge
 * job is still active, instructing the operator to cancel it first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { InMemoryStore } from '@mars/workflow'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface RestartModule {
  coreRestartTask: typeof import('../restart-task').coreRestartTask
  RestartTaskError: typeof import('../restart-task').RestartTaskError
}

interface MergeJobStoreModule {
  createMergeJobStore: typeof import('../../store/merge-job-store').createMergeJobStore
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-restart-merge-guard-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; restart: RestartModule; mergeStore: MergeJobStoreModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const restart = (await import('../restart-task')) as unknown as RestartModule
  const mergeStore = (await import('../../store/merge-job-store')) as unknown as MergeJobStoreModule
  return { q, restart, mergeStore }
}

describe('coreRestartTask merge-job guard', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it.each([['queued'], ['claimed'], ['running']])(
    'throws RestartTaskError(WRONG_STATUS) when an active merge_jobs row with status "%s" exists for the task',
    async (mergeStatus: string) => {
      const { q, restart, mergeStore } = await loadModules(repo)
      const client = q.resolveQueueClient()
      const store = mergeStore.createMergeJobStore(client)

      const task = await q.enqueueTask('task under merge', undefined, {
        skipTriage: true,
      })
      // Put the task in 'failed' status so restart would otherwise be allowed.
      await client.execute({
        sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
        args: [task.id],
      })

      // Insert an active merge_jobs row for the task.
      await store.enqueue({
        taskId: task.id,
        integrationBranch: 'main',
        worktreePath: `/tmp/worktrees/${task.id}`,
        branch: `task/${task.id}`,
      })
      // Advance the status if needed (enqueue starts as 'queued').
      if (mergeStatus !== 'queued') {
        await client.execute({
          sql: `UPDATE merge_jobs SET status = ? WHERE task_id = ?`,
          args: [mergeStatus, task.id],
        })
      }

      await expect(
        restart.coreRestartTask(
          task.id,
          new Set(['failed']),
          new InMemoryStore(),
        ),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof restart.RestartTaskError && e.code === 'WRONG_STATUS',
      )
    },
  )

  it('error message names the active merge job id and the cancel command', async () => {
    const { q, restart, mergeStore } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const store = mergeStore.createMergeJobStore(client)

    const task = await q.enqueueTask('task under merge', undefined, {
      skipTriage: true,
    })
    await client.execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [task.id],
    })

    const job = await store.enqueue({
      taskId: task.id,
      integrationBranch: 'main',
      worktreePath: `/tmp/worktrees/${task.id}`,
      branch: `task/${task.id}`,
    })

    let thrownError: unknown
    try {
      await restart.coreRestartTask(
        task.id,
        new Set(['failed']),
        new InMemoryStore(),
      )
    } catch (e) {
      thrownError = e
    }

    expect(thrownError).toBeInstanceOf(restart.RestartTaskError)
    const err = thrownError as InstanceType<typeof restart.RestartTaskError>
    expect(err.message).toContain(task.id)
    expect(err.message).toContain(job.id)
    expect(err.message).toContain('mars merge cancel')
    expect(err.code).toBe('WRONG_STATUS')
  })

  it('allows restart when there is no active merge_jobs row for the task', async () => {
    const { q, restart } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const task = await q.enqueueTask('standalone task', undefined, {
      skipTriage: true,
    })
    await client.execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [task.id],
    })

    // No merge_jobs row seeded — restart should proceed.
    const result = await restart.coreRestartTask(
      task.id,
      new Set(['failed']),
      new InMemoryStore(),
    )
    expect(result.status).toBe('queued')
  })

  it('allows restart when the only merge_jobs row is in terminal status (done/failed/canceled)', async () => {
    const { q, restart, mergeStore } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const store = mergeStore.createMergeJobStore(client)

    const task = await q.enqueueTask('finished merge task', undefined, {
      skipTriage: true,
    })
    await client.execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [task.id],
    })

    // Insert a merge_jobs row and mark it done.
    const job = await store.enqueue({
      taskId: task.id,
      integrationBranch: 'main',
      worktreePath: `/tmp/worktrees/${task.id}`,
      branch: `task/${task.id}`,
    })
    await store.markDone(job.id)

    // Terminal merge job — restart should proceed.
    const result = await restart.coreRestartTask(
      task.id,
      new Set(['failed']),
      new InMemoryStore(),
    )
    expect(result.status).toBe('queued')
  })
})
