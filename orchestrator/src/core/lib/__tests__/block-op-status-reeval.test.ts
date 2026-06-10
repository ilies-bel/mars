import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * Regression tests for the post-hoc `mars block` status re-evaluation bug.
 *
 * Invariant: a task must be in status `'blocked'` whenever ANY of its confirmed
 * blockers has not reached `'done'`.  The enqueue path enforces this, but the
 * post-hoc `mars block <dep> <blocker>` path (`handleBlock` in server.ts) was
 * NOT re-evaluating status after inserting the edge — leaving a `'queued'` task
 * dispatchable while its blocker was unmet.
 *
 * These tests specify the expected behaviour through the public queue interface
 * (`addBlockers` + `hasIncompleteBlockers` + `updateTask`) — the exact sequence
 * that the fixed `handleBlock` runs.
 */

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-block-reeval-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('mars block post-hoc status re-evaluation', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('queued task with unmet blocker becomes blocked after addBlockers + re-eval', async () => {
    const { migrateQueueSchema, enqueueTask, addBlockers, hasIncompleteBlockers, updateTask, getTask } =
      await import('../../queue')
    await migrateQueueSchema()

    const dep = await enqueueTask('dependent', undefined, { skipTriage: true })
    const blocker = await enqueueTask('blocker-task', undefined, { skipTriage: true })

    // Both tasks are queued; blocker is NOT done.
    expect(dep.status).toBe('queued')
    expect(blocker.status).toBe('queued')

    // Simulate the fixed handleBlock: addBlockers + conditional updateTask.
    await addBlockers(dep.id, [blocker.id])
    if (
      (dep.status === 'queued' || dep.status === 'draft') &&
      (await hasIncompleteBlockers(dep.id))
    ) {
      await updateTask(dep.id, { status: 'blocked' })
    }

    const updated = await getTask(dep.id)
    expect(updated?.status).toBe('blocked')
  })

  it('queued task with an already-done blocker stays queued after addBlockers + re-eval', async () => {
    const { migrateQueueSchema, enqueueTask, addBlockers, hasIncompleteBlockers, updateTask, getTask } =
      await import('../../queue')
    await migrateQueueSchema()

    const dep = await enqueueTask('dependent', undefined, { skipTriage: true })
    const blocker = await enqueueTask('done-blocker', undefined, { skipTriage: true })

    // Mark the blocker done before adding the edge.
    await updateTask(blocker.id, { status: 'done' })

    await addBlockers(dep.id, [blocker.id])

    // Re-eval: blocker is done → hasIncompleteBlockers returns false.
    const depTask = await getTask(dep.id)
    if (
      (depTask?.status === 'queued' || depTask?.status === 'draft') &&
      (await hasIncompleteBlockers(dep.id))
    ) {
      await updateTask(dep.id, { status: 'blocked' })
    }

    const updated = await getTask(dep.id)
    expect(updated?.status).toBe('queued')
  })

  it('draft task with unmet blocker becomes blocked after addBlockers + re-eval', async () => {
    const { migrateQueueSchema, enqueueTask, addBlockers, hasIncompleteBlockers, updateTask, getTask } =
      await import('../../queue')
    await migrateQueueSchema()

    // A draft task (skipTriage: false keeps it in draft initially).
    const dep = await enqueueTask('draft-dependent', undefined, { skipTriage: false })
    const blocker = await enqueueTask('blocker-task', undefined, { skipTriage: true })

    expect(dep.status).toBe('draft')
    expect(blocker.status).toBe('queued')

    await addBlockers(dep.id, [blocker.id])
    const depTask = await getTask(dep.id)
    if (
      (depTask?.status === 'queued' || depTask?.status === 'draft') &&
      (await hasIncompleteBlockers(dep.id))
    ) {
      await updateTask(dep.id, { status: 'blocked' })
    }

    const updated = await getTask(dep.id)
    expect(updated?.status).toBe('blocked')
  })

  it('running task is NOT touched by re-eval even if it has an unmet blocker', async () => {
    // Post-hoc `mars block` on an already-dispatched task is a separate concern
    // and must not interrupt it.
    const { migrateQueueSchema, enqueueTask, addBlockers, hasIncompleteBlockers, updateTask, getTask, resolveQueueClient } =
      await import('../../queue')
    await migrateQueueSchema()

    const dep = await enqueueTask('running-task', undefined, { skipTriage: true })
    const blocker = await enqueueTask('blocker-task', undefined, { skipTriage: true })

    // Simulate the task already being dispatched.
    await resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running' WHERE id = ?`,
      args: [dep.id],
    })

    await addBlockers(dep.id, [blocker.id])

    // Re-eval only applies to pre-dispatch states (queued / draft).
    const depTask = await getTask(dep.id)
    if (
      (depTask?.status === 'queued' || depTask?.status === 'draft') &&
      (await hasIncompleteBlockers(dep.id))
    ) {
      await updateTask(dep.id, { status: 'blocked' })
    }

    const updated = await getTask(dep.id)
    expect(updated?.status).toBe('running')
  })
})
