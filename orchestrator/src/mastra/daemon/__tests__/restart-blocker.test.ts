/**
 * Tests for coreRestartTask blocker-invariant guard.
 *
 * A failed task may have blocker edges to non-done tasks (e.g. it failed after
 * the retry budget was exhausted, while a parallel blocker was still running).
 * Restarting such a task must NOT put it in 'queued' — it must go back to
 * 'blocked' so the dispatcher never sees a queued task with incomplete
 * blockers.
 */
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
  addBlockers: typeof import('../../queue').addBlockers
  updateTask: typeof import('../../queue').updateTask
}

interface RestartModule {
  coreRestartTask: typeof import('../restart-task').coreRestartTask
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-restart-blocker-'))
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
  await q.initQueue()
  const restart = (await import('../restart-task')) as unknown as RestartModule
  return { q, restart }
}

describe('coreRestartTask blocker invariant', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('restores a failed task to blocked (not queued) when it has an incomplete blocker', async () => {
    const { q, restart } = await loadModules(repo)
    const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })
    const dependent = await q.enqueueTask('dependent', undefined, { skipTriage: true })

    await q.addBlockers(dependent.id, [blocker.id])
    // Manually put dependent in 'failed' with an incomplete blocker still in place
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [dependent.id],
    })

    await restart.coreRestartTask(dependent.id, new Set(['failed']))

    const reloaded = await q.getTask(dependent.id)
    expect(reloaded?.status).toBe('blocked')
  })

  it('puts a failed task back to queued when all its blockers are done', async () => {
    const { q, restart } = await loadModules(repo)
    const blocker = await q.enqueueTask('done blocker', undefined, { skipTriage: true })
    const dependent = await q.enqueueTask('dependent', undefined, { skipTriage: true })

    await q.addBlockers(dependent.id, [blocker.id])
    await q.updateTask(blocker.id, { status: 'done' })
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [dependent.id],
    })

    await restart.coreRestartTask(dependent.id, new Set(['failed']))

    const reloaded = await q.getTask(dependent.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('puts a failed task with no blockers back to queued', async () => {
    const { q, restart } = await loadModules(repo)
    const t = await q.enqueueTask('standalone', undefined, { skipTriage: true })
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [t.id],
    })

    await restart.coreRestartTask(t.id, new Set(['failed']))

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
  })
})
