/**
 * Tests for coreRestartTask blocker-invariant guard.
 *
 * A failed task may have blocker edges to non-done tasks (e.g. it failed after
 * the retry budget was exhausted, while a parallel blocker was still running).
 * Restarting such a task must NOT put it in 'queued' — it must go back to
 * 'blocked' so the dispatcher never sees a queued task with incomplete
 * blockers.
 *
 * Special case: blocker edges pointing at a FAILED RECOVERY TASK (kind='fix',
 * fix_for_task_id IS NOT NULL, status='failed') are permanently unsatisfiable.
 * These dead edges must be cleared by restart so the origin can reach 'queued'
 * rather than being stranded in 'blocked' forever.
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
  await q.migrateQueueSchema()
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
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [dependent.id],
    })

    await restart.coreRestartTask(dependent.id, new Set(['failed']), new InMemoryStore())

    const reloaded = await q.getTask(dependent.id)
    expect(reloaded?.status).toBe('blocked')
  })

  it('puts a failed task back to queued when all its blockers are done', async () => {
    const { q, restart } = await loadModules(repo)
    const blocker = await q.enqueueTask('done blocker', undefined, { skipTriage: true })
    const dependent = await q.enqueueTask('dependent', undefined, { skipTriage: true })

    await q.addBlockers(dependent.id, [blocker.id])
    await q.updateTask(blocker.id, { status: 'done' })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [dependent.id],
    })

    await restart.coreRestartTask(dependent.id, new Set(['failed']), new InMemoryStore())

    const reloaded = await q.getTask(dependent.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('puts a failed task with no blockers back to queued', async () => {
    const { q, restart } = await loadModules(repo)
    const t = await q.enqueueTask('standalone', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [t.id],
    })

    await restart.coreRestartTask(t.id, new Set(['failed']), new InMemoryStore())

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('clears a dead recovery-task blocker edge and reaches queued', async () => {
    // The recovery task (fix_for_task_id IS NOT NULL, status='failed') can
    // never reach 'done'. Leaving the edge in place after restart would strand
    // the origin in 'blocked' permanently. Restart must clear it.
    //
    // ADR-0040 prevents adding a recovery task as a blocker through the normal
    // API path, but these edges exist in practice through legacy state or
    // older code. We insert the edge via raw SQL to represent the real DB state
    // the fix is designed to handle.
    const { q, restart } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
    // Create a fix/recovery task that points at the origin
    const recovery = await q.enqueueTask('recovery', undefined, { skipTriage: true })
    await client.execute({
      sql: `UPDATE tasks SET fix_for_task_id = ?, status = 'failed' WHERE id = ?`,
      args: [origin.id, recovery.id],
    })

    // Insert the blocker edge directly (bypassing the ADR-0040 API guard that
    // rightly prevents this from being created in normal operation — the guard
    // was added after these edges appeared in production).
    await client.execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at)
            VALUES (?, ?, 'confirmed', datetime('now'))`,
      args: [origin.id, recovery.id],
    })
    await client.execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [origin.id],
    })

    await restart.coreRestartTask(origin.id, new Set(['failed']), new InMemoryStore())

    const reloaded = await q.getTask(origin.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('returns { status: "queued" } when the task has no blockers', async () => {
    const { q, restart } = await loadModules(repo)
    const t = await q.enqueueTask('standalone', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [t.id],
    })

    const result = await restart.coreRestartTask(t.id, new Set(['failed']), new InMemoryStore())

    expect(result.status).toBe('queued')
  })

  it('returns { status: "blocked" } when a live incomplete blocker remains', async () => {
    const { q, restart } = await loadModules(repo)
    const blocker = await q.enqueueTask('live blocker', undefined, { skipTriage: true })
    const dependent = await q.enqueueTask('dependent', undefined, { skipTriage: true })

    await q.addBlockers(dependent.id, [blocker.id])
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [dependent.id],
    })

    const result = await restart.coreRestartTask(
      dependent.id,
      new Set(['failed']),
      new InMemoryStore(),
    )

    expect(result.status).toBe('blocked')
  })
})
