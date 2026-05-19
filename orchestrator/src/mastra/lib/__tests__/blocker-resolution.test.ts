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
  markOriginDoneFromRecovery: typeof import('../../blocker-resolution').markOriginDoneFromRecovery
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

  it('fails dependent that already burned a retry (retry_count=1, default budget=0) at unblock time', async () => {
    // No MARS_FIX_RETRY_BUDGET => DEFAULT_RETRY_BUDGET (0). A dependent with
    // retry_count=1 has burned a retry, so the guard (retryCount > budget,
    // i.e. 1 > 0) must still fire and fail it.
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
    expect(taskBlocked[0].kind).toBe(`task-blocked(${dep.id})`)
    expect(taskBlocked[0].signature).toBe(dep.id)
    expect(taskBlocked[0].payload.taskId).toBe(dep.id)
  })

  it('recoverBlockedTasks fails a dependent that already burned a retry (retry_count=1, default budget=0)', async () => {
    // Negative path for the daemon-startup recovery entry point.
    const { q, br } = await loadModules(repo)
    const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
    const fix = await q.enqueueTask('fix', undefined, { skipTriage: true })
    await blockTask(q, dep.id, fix.id, 1)
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [fix.id],
    })

    const recovered = await br.recoverBlockedTasks()
    expect(recovered).toHaveLength(1)
    expect(recovered[0].outcomes[0].outcome).toBe('failed')
    const reloaded = await q.getTask(dep.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failureReason).toBe('retry_budget_exhausted_at_unblock')

    const inbox = (await import('../inbox')) as unknown as {
      listInboxItems: typeof import('../inbox').listInboxItems
    }
    const open = await inbox.listInboxItems('open')
    const taskBlocked = open.filter((i) => i.kind.startsWith('task-blocked('))
    expect(taskBlocked).toHaveLength(1)
    expect(taskBlocked[0].kind).toBe(`task-blocked(${dep.id})`)
  })

  it('onBlockerTaskCompleted queues a never-run dependent (retry_count=0, default budget=0) instead of failing it', async () => {
    // Regression: off-by-one in the retry-budget guard. With the default
    // budget of 0 and the old `retryCount >= budget`, 0 >= 0 was true and
    // every fresh dependent was wrongly failed at unblock. The guard must
    // be `retryCount > budget` so a never-run task (retry_count=0) recovers.
    const { q, br } = await loadModules(repo)
    const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
    const fix = await q.enqueueTask('fix', undefined, { skipTriage: true })
    await blockTask(q, dep.id, fix.id, 0)
    // Bypass updateTask auto-promote so onBlockerTaskCompleted is exercised.
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [fix.id],
    })

    const r = await br.onBlockerTaskCompleted(fix.id)
    expect(r.outcomes).toHaveLength(1)
    expect(r.outcomes[0].outcome).toBe('queued')
    expect(r.outcomes[0].retryCount).toBe(0)
    const reloaded = await q.getTask(dep.id)
    expect(reloaded?.status).toBe('queued')
    expect(reloaded?.failureReason).toBeFalsy()

    const inbox = (await import('../inbox')) as unknown as {
      listInboxItems: typeof import('../inbox').listInboxItems
    }
    const open = await inbox.listInboxItems('open')
    const taskBlocked = open.filter((i) => i.kind.startsWith('task-blocked('))
    expect(taskBlocked).toHaveLength(0)
  })

  it('recoverBlockedTasks queues a never-run dependent (retry_count=0, default budget=0) instead of failing it', async () => {
    // Same regression as above, exercised via the daemon-startup recovery
    // entry point (a blocker completed while the daemon was down).
    const { q, br } = await loadModules(repo)
    const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
    const fix = await q.enqueueTask('fix', undefined, { skipTriage: true })
    await blockTask(q, dep.id, fix.id, 0)
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [fix.id],
    })

    const recovered = await br.recoverBlockedTasks()
    expect(recovered).toHaveLength(1)
    expect(recovered[0].outcomes[0].outcome).toBe('queued')
    expect(recovered[0].outcomes[0].retryCount).toBe(0)
    const reloaded = await q.getTask(dep.id)
    expect(reloaded?.status).toBe('queued')
    expect(reloaded?.failureReason).toBeFalsy()

    const inbox = (await import('../inbox')) as unknown as {
      listInboxItems: typeof import('../inbox').listInboxItems
    }
    const open = await inbox.listInboxItems('open')
    const taskBlocked = open.filter((i) => i.kind.startsWith('task-blocked('))
    expect(taskBlocked).toHaveLength(0)
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

  it('never-run dependent (no error field) produces inbox lastStep of "blocked-dependent", not "unblock"', async () => {
    // A task that sat in blocked without ever running has no error field.
    // The inbox item must NOT use the bogus 'unblock' sentinel — it must
    // use 'blocked-dependent' so a human reading mars inbox can tell this
    // task never executed vs failing at a real workflow step.
    const { q, br } = await loadModules(repo)
    const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
    const fix = await q.enqueueTask('fix', undefined, { skipTriage: true })
    // retry_count=1 so retryBudgetExhausted fires; no error field (never ran).
    await blockTask(q, dep.id, fix.id, 1)
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [fix.id],
    })

    await br.onBlockerTaskCompleted(fix.id)

    const inbox = (await import('../inbox')) as unknown as {
      listInboxItems: typeof import('../inbox').listInboxItems
    }
    const open = await inbox.listInboxItems('open')
    const item = open.find((i) => i.kind === `task-blocked(${dep.id})`)
    expect(item).toBeDefined()
    expect(item!.payload.lastStep).toBe('blocked-dependent')
    expect(item!.payload.lastStep).not.toBe('unblock')
    expect(item!.body).not.toContain('at step `unblock`')
    expect(item!.body).toMatch(/never ran|blocked dependent/i)
  })

  it('task that failed at a real step produces inbox lastStep matching the step name', async () => {
    // A task with error='verify:test: npm test failed' should surface
    // lastStep='verify:test' — the real step — not 'blocked-dependent'.
    const { q, br } = await loadModules(repo)
    const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
    const fix = await q.enqueueTask('fix', undefined, { skipTriage: true })
    await blockTask(q, dep.id, fix.id, 1)
    // Give it a real step error.
    await q.getClient().execute({
      sql: `UPDATE tasks SET error = 'verify:test: npm test failed' WHERE id = ?`,
      args: [dep.id],
    })
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [fix.id],
    })

    await br.onBlockerTaskCompleted(fix.id)

    const inbox = (await import('../inbox')) as unknown as {
      listInboxItems: typeof import('../inbox').listInboxItems
    }
    const open = await inbox.listInboxItems('open')
    const item = open.find((i) => i.kind === `task-blocked(${dep.id})`)
    expect(item).toBeDefined()
    expect(item!.payload.lastStep).toBe('verify:test')
    expect(item!.body).toContain('at step `verify:test`')
    expect(item!.body).not.toContain('never ran')
  })

  describe('markOriginDoneFromRecovery', () => {
    const makeRecoveryRow = async (
      q: QueueModule,
      originTaskId: string,
    ): Promise<string> => {
      const fix = await q.enqueueTask('fix', undefined, { skipTriage: true })
      await q.getClient().execute({
        sql: `UPDATE tasks
                 SET kind = 'fix',
                     fix_for_task_id = ?,
                     status = 'running'
               WHERE id = ?`,
        args: [originTaskId, fix.id],
      })
      return fix.id
    }

    it('flips origin to done and unblocks dependents when recovery succeeds', async () => {
      const { q, br } = await loadModules(repo)
      const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
      const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
      await blockTask(q, dep.id, origin.id, 0)
      await q.getClient().execute({
        sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
        args: [origin.id],
      })
      const recoveryId = await makeRecoveryRow(q, origin.id)
      await q.getClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [recoveryId],
      })

      const result = await br.markOriginDoneFromRecovery(origin.id)

      expect(result.originFlipped).toBe(true)
      expect(result.unblock).not.toBeNull()
      expect(result.unblock!.outcomes.map((o) => o.outcome)).toContain('queued')
      expect((await q.getTask(origin.id))?.status).toBe('done')
      expect((await q.getTask(dep.id))?.status).toBe('queued')
    })

    it('is idempotent — second call is a no-op', async () => {
      const { q, br } = await loadModules(repo)
      const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
      await q.getClient().execute({
        sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
        args: [origin.id],
      })
      const recoveryId = await makeRecoveryRow(q, origin.id)
      await q.getClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [recoveryId],
      })

      const first = await br.markOriginDoneFromRecovery(origin.id)
      const second = await br.markOriginDoneFromRecovery(origin.id)

      expect(first.originFlipped).toBe(true)
      expect(second.originFlipped).toBe(false)
      expect(second.unblock).toBeNull()
      expect((await q.getTask(origin.id))?.status).toBe('done')
    })

    it('is a no-op when origin is already in a terminal state', async () => {
      const { q, br } = await loadModules(repo)
      const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
      await q.getClient().execute({
        sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
        args: [origin.id],
      })

      const result = await br.markOriginDoneFromRecovery(origin.id)

      expect(result.originFlipped).toBe(false)
      expect(result.unblock).toBeNull()
      expect(result.inboxItemsClosed).toBe(0)
      expect((await q.getTask(origin.id))?.status).toBe('failed')
    })

    it('returns no-op when origin does not exist', async () => {
      const { br } = await loadModules(repo)
      const result = await br.markOriginDoneFromRecovery('missing-id')
      expect(result.originFlipped).toBe(false)
      expect(result.unblock).toBeNull()
    })
  })
})
