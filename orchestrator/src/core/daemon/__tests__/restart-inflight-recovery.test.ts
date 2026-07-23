/**
 * Tests for coreRestartTask in-flight recovery guard.
 *
 * When a fix-task (recovery) is currently active for an origin task, calling
 * `mars restart` on the origin must be refused. Without the guard, the restart
 * would wipe the fix task's worktree and branch from underneath it — corrupting
 * the recovery and leaving the fix task's commits dangling with no branch ref
 * pointing to them.
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
  updateTask: typeof import('../../queue').updateTask
}

interface RestartModule {
  coreRestartTask: typeof import('../restart-task').coreRestartTask
  RestartTaskError: typeof import('../restart-task').RestartTaskError
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-restart-inflight-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; restart: RestartModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const restart = (await import('../restart-task')) as unknown as RestartModule
  return { q, restart }
}

describe('coreRestartTask in-flight recovery guard', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it.each([
    ['queued'],
    ['running'],
    ['verifying'],
    ['merging'],
    ['vega-reconciling'],
  ])(
    'throws RestartTaskError(WRONG_STATUS) when a fix task with status "%s" is active for the origin',
    async (fixStatus: string) => {
      const { q, restart } = await loadModules(repo)
      const client = q.resolveQueueClient()

      const origin = await q.enqueueTask('origin task', undefined, {
        skipTriage: true,
      })
      // Put origin in 'failed' so restart would otherwise be allowed
      await client.execute({
        sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
        args: [origin.id],
      })

      // Create a fix task that references the origin
      const fixTask = await q.enqueueTask('recovery fix', undefined, {
        skipTriage: true,
      })
      await client.execute({
        sql: `UPDATE tasks SET fix_for_task_id = ?, status = ? WHERE id = ?`,
        args: [origin.id, fixStatus, fixTask.id],
      })

      await expect(
        restart.coreRestartTask(
          origin.id,
          new Set(['failed']),
          new InMemoryStore(),
        ),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof restart.RestartTaskError && e.code === 'WRONG_STATUS',
      )
    },
  )

  it('allows restart when the only fix task is in done status', async () => {
    const { q, restart } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const origin = await q.enqueueTask('origin task', undefined, {
      skipTriage: true,
    })
    await client.execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [origin.id],
    })

    const fixTask = await q.enqueueTask('done recovery', undefined, {
      skipTriage: true,
    })
    await client.execute({
      sql: `UPDATE tasks SET fix_for_task_id = ?, status = 'done' WHERE id = ?`,
      args: [origin.id, fixTask.id],
    })

    // Should NOT throw — the recovery is already complete
    const result = await restart.coreRestartTask(
      origin.id,
      new Set(['failed']),
      new InMemoryStore(),
    )
    expect(result.status).toBe('queued')

    const reloaded = await q.getTask(origin.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('allows restart when the only fix task is in failed status', async () => {
    const { q, restart } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const origin = await q.enqueueTask('origin task', undefined, {
      skipTriage: true,
    })
    await client.execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [origin.id],
    })

    const fixTask = await q.enqueueTask('failed recovery', undefined, {
      skipTriage: true,
    })
    await client.execute({
      sql: `UPDATE tasks SET fix_for_task_id = ?, status = 'failed' WHERE id = ?`,
      args: [origin.id, fixTask.id],
    })

    // A failed recovery is no longer in-flight; restart is safe
    const result = await restart.coreRestartTask(
      origin.id,
      new Set(['failed']),
      new InMemoryStore(),
    )
    expect(result.status).toBe('queued')
  })

  it('allows restart when there are no fix tasks at all', async () => {
    const { q, restart } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const origin = await q.enqueueTask('standalone task', undefined, {
      skipTriage: true,
    })
    await client.execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [origin.id],
    })

    const result = await restart.coreRestartTask(
      origin.id,
      new Set(['failed']),
      new InMemoryStore(),
    )
    expect(result.status).toBe('queued')
  })

  it('error message names the in-flight recovery task id', async () => {
    const { q, restart } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const origin = await q.enqueueTask('origin task', undefined, {
      skipTriage: true,
    })
    await client.execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [origin.id],
    })

    const fixTask = await q.enqueueTask('active recovery', undefined, {
      skipTriage: true,
    })
    await client.execute({
      sql: `UPDATE tasks SET fix_for_task_id = ?, status = 'running' WHERE id = ?`,
      args: [origin.id, fixTask.id],
    })

    let thrownError: unknown
    try {
      await restart.coreRestartTask(
        origin.id,
        new Set(['failed']),
        new InMemoryStore(),
      )
    } catch (e) {
      thrownError = e
    }

    expect(thrownError).toBeInstanceOf(restart.RestartTaskError)
    expect((thrownError as InstanceType<typeof restart.RestartTaskError>).message).toContain(
      fixTask.id,
    )
  })
})
