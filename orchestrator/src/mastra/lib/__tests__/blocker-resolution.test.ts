import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
  getClient: typeof import('../../queue').getClient
  initQueue: typeof import('../../queue').initQueue
  addBlockers: typeof import('../../queue').addBlockers
}

interface BlockerModule {
  onBlockerTaskCompleted: typeof import('../../blocker-resolution').onBlockerTaskCompleted
  recoverBlockedTasks: typeof import('../../blocker-resolution').recoverBlockedTasks
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-blocker-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; br: BlockerModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const br = (await import(
    '../../blocker-resolution'
  )) as unknown as BlockerModule
  return { q, br }
}

const blockTask = async (
  q: QueueModule,
  taskId: string,
  blockerTaskId: string,
  retryCount: number = 1,
): Promise<void> => {
  await q.addBlockers(taskId, [blockerTaskId])
  await q.getClient().execute({
    sql: `UPDATE tasks SET status = 'blocked', retry_count = ? WHERE id = ?`,
    args: [retryCount, taskId],
  })
}

describe('blocker-resolution (task_blockers)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  it('onBlockerTaskCompleted unblocks a single dependent when its sole blocker lands done', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, br } = await loadModules(repo)
    const dep = await q.enqueueTask('dependent', undefined, { skipTriage: true })
    const fix = await q.enqueueTask('fix', undefined, { skipTriage: true })
    await blockTask(q, dep.id, fix.id)
    await q.updateTask(fix.id, { status: 'done' })

    // updateTask already promoted via promoteDraftToQueued, so the dependent
    // should now be queued; onBlockerTaskCompleted is idempotent.
    const r = await br.onBlockerTaskCompleted(fix.id)
    const reloaded = await q.getTask(dep.id)
    expect(reloaded?.status).toBe('queued')
    // Outcome list is empty because the dependent already left 'blocked'.
    expect(r.outcomes.every((o) => o.outcome !== 'queued' || o.taskId === dep.id)).toBe(
      true,
    )
  })

  it('fails dependent when retry budget is exhausted at unblock time', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '1'
    const { q, br } = await loadModules(repo)
    const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
    const fix = await q.enqueueTask('fix', undefined, { skipTriage: true })
    await blockTask(q, dep.id, fix.id, 1)
    // Mark fix done WITHOUT calling updateTask (which would auto-promote);
    // simulate the daemon-down path.
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [fix.id],
    })

    const r = await br.onBlockerTaskCompleted(fix.id)
    expect(r.outcomes).toHaveLength(1)
    expect(r.outcomes[0].outcome).toBe('failed')
    const reloaded = await q.getTask(dep.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failureReason).toBe('retry_budget_exhausted_at_unblock')

    const inbox = (await import('../inbox')) as unknown as {
      listInboxItems: typeof import('../inbox').listInboxItems
    }
    const open = await inbox.listInboxItems('open')
    const taskBlocked = open.filter((i) => i.kind.startsWith('task-blocked('))
    expect(taskBlocked).toHaveLength(1)
    expect(taskBlocked[0].kind).toBe(`task-blocked(${dep.id.slice(0, 8)})`)
    expect(taskBlocked[0].signature).toBe(dep.id)
    expect(taskBlocked[0].payload.taskId).toBe(dep.id)
  })

  it('does not unblock when one of multiple blockers is still pending', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, br } = await loadModules(repo)
    const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
    const a = await q.enqueueTask('a', undefined, { skipTriage: true })
    const b = await q.enqueueTask('b', undefined, { skipTriage: true })
    await q.addBlockers(dep.id, [a.id, b.id])
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'blocked', retry_count = 1 WHERE id = ?`,
      args: [dep.id],
    })
    // Only a is done; b is still pending.
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [a.id],
    })

    const r = await br.onBlockerTaskCompleted(a.id)
    expect(r.outcomes).toHaveLength(1)
    expect(r.outcomes[0].outcome).toBe('noop')
    const reloaded = await q.getTask(dep.id)
    expect(reloaded?.status).toBe('blocked')
  })

  it('recoverBlockedTasks queues a task whose blocker landed while daemon was down', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, br } = await loadModules(repo)
    const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
    const fix = await q.enqueueTask('fix', undefined, { skipTriage: true })
    await blockTask(q, dep.id, fix.id)
    // Bypass updateTask to simulate the daemon dying mid-handoff.
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [fix.id],
    })

    const recovered = await br.recoverBlockedTasks()
    expect(recovered).toHaveLength(1)
    expect(recovered[0].outcomes[0].outcome).toBe('queued')
    const reloaded = await q.getTask(dep.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('recoverBlockedTasks is a no-op when blocker is still pending', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, br } = await loadModules(repo)
    const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
    const fix = await q.enqueueTask('fix', undefined, { skipTriage: true })
    await blockTask(q, dep.id, fix.id)

    const recovered = await br.recoverBlockedTasks()
    expect(recovered).toHaveLength(0)
    const reloaded = await q.getTask(dep.id)
    expect(reloaded?.status).toBe('blocked')
  })
})
