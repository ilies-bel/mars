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

interface DriftModule {
  repairQueuedWithIncompleteBlockers: typeof import('../reconcile-blocker-drift').repairQueuedWithIncompleteBlockers
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-blocker-drift-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; drift: DriftModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const drift = (await import(
    '../reconcile-blocker-drift'
  )) as unknown as DriftModule
  return { q, drift }
}

describe('repairQueuedWithIncompleteBlockers', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns an empty array and changes nothing when there is no drift', async () => {
    const { q, drift } = await loadModules(repo)
    const t = await q.enqueueTask('clean task', undefined, { skipTriage: true })
    // No blockers — task is legitimately queued
    const demoted = await drift.repairQueuedWithIncompleteBlockers()
    expect(demoted).toHaveLength(0)
    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('demotes a queued task that has an incomplete (non-done) blocker back to blocked', async () => {
    const { q, drift } = await loadModules(repo)
    const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })
    const dependent = await q.enqueueTask('dependent', undefined, { skipTriage: true })

    // Wire blocker edge
    await q.addBlockers(dependent.id, [blocker.id])

    // Force the dependent into 'queued' despite having an incomplete blocker
    // (simulates the invariant violation we are repairing)
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'queued' WHERE id = ?`,
      args: [dependent.id],
    })

    const demoted = await drift.repairQueuedWithIncompleteBlockers()

    expect(demoted).toContain(dependent.id)
    expect(demoted).not.toContain(blocker.id)

    const reloaded = await q.getTask(dependent.id)
    expect(reloaded?.status).toBe('blocked')
  })

  it('does not demote a queued task whose only blockers are all done', async () => {
    const { q, drift } = await loadModules(repo)
    const blocker = await q.enqueueTask('done blocker', undefined, { skipTriage: true })
    const dependent = await q.enqueueTask('dependent', undefined, { skipTriage: true })

    await q.addBlockers(dependent.id, [blocker.id])
    await q.updateTask(blocker.id, { status: 'done' })

    // dependent starts as 'queued' (blockers are done — invariant is satisfied)
    const demoted = await drift.repairQueuedWithIncompleteBlockers()

    expect(demoted).not.toContain(dependent.id)

    const reloaded = await q.getTask(dependent.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('demotes all drifted queued tasks in one pass', async () => {
    const { q, drift } = await loadModules(repo)
    const blocker1 = await q.enqueueTask('blocker1', undefined, { skipTriage: true })
    const blocker2 = await q.enqueueTask('blocker2', undefined, { skipTriage: true })
    const dep1 = await q.enqueueTask('dep1', undefined, { skipTriage: true })
    const dep2 = await q.enqueueTask('dep2', undefined, { skipTriage: true })

    await q.addBlockers(dep1.id, [blocker1.id])
    await q.addBlockers(dep2.id, [blocker2.id])

    // Force both dependents to 'queued' with incomplete blockers
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'queued' WHERE id IN (?, ?)`,
      args: [dep1.id, dep2.id],
    })

    const demoted = await drift.repairQueuedWithIncompleteBlockers()

    expect(demoted).toHaveLength(2)
    expect(demoted).toContain(dep1.id)
    expect(demoted).toContain(dep2.id)

    const r1 = await q.getTask(dep1.id)
    const r2 = await q.getTask(dep2.id)
    expect(r1?.status).toBe('blocked')
    expect(r2?.status).toBe('blocked')
  })

  it('is idempotent — running twice on a clean queue is a no-op', async () => {
    const { q, drift } = await loadModules(repo)
    await q.enqueueTask('clean task', undefined, { skipTriage: true })

    const first = await drift.repairQueuedWithIncompleteBlockers()
    const second = await drift.repairQueuedWithIncompleteBlockers()

    expect(first).toHaveLength(0)
    expect(second).toHaveLength(0)
  })
})
