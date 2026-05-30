import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
  onBlockerTaskFailed: typeof import('../../blocker-resolution').onBlockerTaskFailed
  markOriginDoneFromRecovery: typeof import('../../blocker-resolution').markOriginDoneFromRecovery
}

interface ActionQueueModule {
  raiseActionQueueItem: typeof import('../action-queue').raiseActionQueueItem
  listActionQueueItems: typeof import('../action-queue').listActionQueueItems
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-blocker-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  // git needs an identity for the test commits below.
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * Seed `main` with an initial commit and branch a per-task worktree off it.
 * Returns the worktree path and the initial main sha, so callers can later
 * advance main and assert the worktree gets reset to the new tip.
 */
const setupTaskWorktree = (
  repo: string,
  taskId: string,
): { worktreePath: string; initialMainSha: string } => {
  writeFileSync(resolve(repo, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  const initialMainSha = execFileSync('git', ['rev-parse', 'main'], {
    cwd: repo,
  })
    .toString()
    .trim()
  const worktreePath = resolve(repo, '.mars', 'worktrees', taskId)
  mkdirSync(resolve(repo, '.mars', 'worktrees'), { recursive: true })
  execFileSync(
    'git',
    ['worktree', 'add', '-b', `task/${taskId}`, worktreePath, 'main'],
    { cwd: repo },
  )
  return { worktreePath, initialMainSha }
}

const advanceMain = (repo: string, content: string): string => {
  writeFileSync(resolve(repo, 'README.md'), content)
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'advance main'], { cwd: repo })
  return execFileSync('git', ['rev-parse', 'main'], { cwd: repo })
    .toString()
    .trim()
}

const headSha = (cwd: string): string =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd }).toString().trim()

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; br: BlockerModule; actionQueue: ActionQueueModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const br = (await import(
    '../../blocker-resolution'
  )) as unknown as BlockerModule
  const actionQueue = (await import('../action-queue')) as unknown as ActionQueueModule
  return { q, br, actionQueue }
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

    const actionQueue = (await import('../action-queue')) as unknown as {
      listActionQueueItems: typeof import('../action-queue').listActionQueueItems
    }
    const open = await actionQueue.listActionQueueItems('open')
    const taskBlocked = open.filter((i) => i.kind === 'failed' && i.payload.taskId === dep.id)
    expect(taskBlocked).toHaveLength(1)
    expect(taskBlocked[0].kind).toBe('failed')
    expect(taskBlocked[0].signature).toBe(dep.id)
    expect(taskBlocked[0].payload.taskId).toBe(dep.id)
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

    const actionQueue = (await import('../action-queue')) as unknown as {
      listActionQueueItems: typeof import('../action-queue').listActionQueueItems
    }
    const open = await actionQueue.listActionQueueItems('open')
    const taskBlocked = open.filter((i) => i.kind === 'failed')
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

  it('never-run dependent (no error field) produces actionQueue lastStep of "blocked-dependent", not "unblock"', async () => {
    // A task that sat in blocked without ever running has no error field.
    // The actionQueue item must NOT use the bogus 'unblock' sentinel — it must
    // use 'blocked-dependent' so a human reading mars actionQueue can tell this
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

    const actionQueue = (await import('../action-queue')) as unknown as {
      listActionQueueItems: typeof import('../action-queue').listActionQueueItems
    }
    const open = await actionQueue.listActionQueueItems('open')
    const item = open.find((i) => i.kind === 'failed' && i.payload.taskId === dep.id)
    expect(item).toBeDefined()
    expect(item!.payload.lastStep).toBe('blocked-dependent')
    expect(item!.payload.lastStep).not.toBe('unblock')
    expect(item!.body).not.toContain('at step `unblock`')
    expect(item!.body).toMatch(/never ran|blocked dependent/i)
  })

  it('task that failed at a real step produces actionQueue lastStep matching the step name', async () => {
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

    const actionQueue = (await import('../action-queue')) as unknown as {
      listActionQueueItems: typeof import('../action-queue').listActionQueueItems
    }
    const open = await actionQueue.listActionQueueItems('open')
    const item = open.find((i) => i.kind === 'failed' && i.payload.taskId === dep.id)
    expect(item).toBeDefined()
    expect(item!.payload.lastStep).toBe('verify:test')
    expect(item!.body).toContain('at step `verify:test`')
    expect(item!.body).not.toContain('never ran')
  })

  describe('onBlockerTaskFailed — block downstream queued dependents', () => {
    it('flips a queued downstream task to blocked and raises an actionQueue item when its sole blocker fails', async () => {
      // A is the prerequisite (queued, then fails). B is queued with
      // --blocked-by A. A's failure must move B to blocked and raise one
      // actionQueue item naming the failed prerequisite.
      const { q, br } = await loadModules(repo)
      const a = await q.enqueueTask('prerequisite-a', undefined, { skipTriage: true })
      const b = await q.enqueueTask('downstream-b', undefined, { skipTriage: true })
      await q.addBlockers(b.id, [a.id])
      // b is queued; addBlockers does not auto-block when blocker is non-terminal.
      // Force b into 'queued' to match the AC precondition explicitly.
      await q.getClient().execute({
        sql: `UPDATE tasks SET status = 'queued' WHERE id = ?`,
        args: [b.id],
      })

      // Run the helper directly (verb under test).
      const queueRetry = (await import('../../queue-retry')) as unknown as {
        markTaskFailed: typeof import('../../queue-retry').markTaskFailed
      }
      await queueRetry.markTaskFailed(a.id, 'verify_failed')

      // Per AC: B must be blocked because its prerequisite failed.
      const reloaded = await q.getTask(b.id)
      expect(reloaded?.status).toBe('blocked')

      // Per AC: exactly one actionQueue item naming the failed prerequisite.
      const actionQueue = (await import('../action-queue')) as unknown as {
        listActionQueueItems: typeof import('../action-queue').listActionQueueItems
      }
      const open = await actionQueue.listActionQueueItems('open')
      const prereqItems = open.filter((i) => i.kind === 'prerequisite-failed')
      expect(prereqItems).toHaveLength(1)
      expect(prereqItems[0].kind).toBe('prerequisite-failed')
      expect(prereqItems[0].payload.dependentTaskId).toBe(b.id)
      expect(prereqItems[0].payload.failedBlockerTaskId).toBe(a.id)
    })

    it('does not disturb downstream tasks already in a non-queued state', async () => {
      // AC: tasks already in non-queued states are not disturbed. We
      // verify with status='running' (in-flight) and status='done'
      // (terminal) as representative non-queued states.
      const { q, br } = await loadModules(repo)
      const a = await q.enqueueTask('prerequisite-a', undefined, { skipTriage: true })
      const running = await q.enqueueTask('running-b', undefined, { skipTriage: true })
      const done = await q.enqueueTask('done-c', undefined, { skipTriage: true })
      await q.addBlockers(running.id, [a.id])
      await q.addBlockers(done.id, [a.id])
      await q.getClient().execute({
        sql: `UPDATE tasks SET status = 'running' WHERE id = ?`,
        args: [running.id],
      })
      await q.getClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [done.id],
      })

      const result = await br.onBlockerTaskFailed(a.id)

      // No outcomes recorded — the helper's SELECT skips non-queued rows.
      expect(result.outcomes).toHaveLength(0)
      expect((await q.getTask(running.id))?.status).toBe('running')
      expect((await q.getTask(done.id))?.status).toBe('done')
    })

    it('applies to every failure mode — also triggers when failure_reason is not the fix-task path', async () => {
      // AC: behaviour applies to all failure modes, not only fix-task
      // failure. Drive the helper through a generic markTaskFailed call
      // with an arbitrary failure_reason, and verify the downstream
      // still flips.
      const { q } = await loadModules(repo)
      const a = await q.enqueueTask('prereq', undefined, { skipTriage: true })
      const b = await q.enqueueTask('downstream', undefined, { skipTriage: true })
      await q.addBlockers(b.id, [a.id])
      await q.getClient().execute({
        sql: `UPDATE tasks SET status = 'queued' WHERE id = ?`,
        args: [b.id],
      })

      const queueRetry = (await import('../../queue-retry')) as unknown as {
        markTaskFailed: typeof import('../../queue-retry').markTaskFailed
      }
      await queueRetry.markTaskFailed(a.id, 'some_other_failure_mode')

      expect((await q.getTask(b.id))?.status).toBe('blocked')
    })
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
      expect(result.actionQueueItemsClosed).toBe(0)
      expect((await q.getTask(origin.id))?.status).toBe('failed')
    })

    // Bug guard: a recovery-failed actionQueue row keyed to an origin that is
    // already terminal (origin parked in `failed` by the retry-budget
    // guard before recovery finished) must still be closed when the
    // recovery itself reaches done. Previously the early-return on
    // terminal-origin skipped supersedeActionQueueItemsForOrigin entirely and
    // stranded the row.
    it('closes actionQueue rows keyed to a terminal origin even though it cannot flip status', async () => {
      const { q, br, actionQueue } = await loadModules(repo)
      const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
      await q.getClient().execute({
        sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
        args: [origin.id],
      })
      await actionQueue.raiseActionQueueItem({
        kind: 'failed',
        category: 'orchestrator',
        priority: 'high',
        title: 'recovery failed',
        body: 'test',
        payload: {},
        context: {},
        raisedBy: 'test',
        signature: 'verify:has-diff/no-commits-ahead',
        originTaskId: origin.id,
      })

      const result = await br.markOriginDoneFromRecovery(origin.id)

      expect(result.originFlipped).toBe(false)
      expect(result.actionQueueItemsClosed).toBe(1)
      const open = await actionQueue.listActionQueueItems('open')
      expect(open.find((r) => r.kind === 'failed')).toBeUndefined()
    })

    it('returns no-op when origin does not exist', async () => {
      const { br } = await loadModules(repo)
      const result = await br.markOriginDoneFromRecovery('missing-id')
      expect(result.originFlipped).toBe(false)
      expect(result.unblock).toBeNull()
    })

    // Bug guard companion: when the recovery's fixForTaskId is a PRD
    // slug rather than a real task row (real failure mode seen in the
    // 2026-05-25 dirty-main cluster), the origin lookup returns null but
    // any actionQueue rows keyed to that origin string must still close.
    it('closes actionQueue rows keyed to a missing origin id', async () => {
      const { br, actionQueue } = await loadModules(repo)
      const orphanOriginId = '1d4d2e62-add-an-events-view-and-an-actionQueue-view-to'
      await actionQueue.raiseActionQueueItem({
        kind: 'failed',
        category: 'orchestrator',
        priority: 'high',
        title: 'recovery failed',
        body: 'test',
        payload: {},
        context: {},
        raisedBy: 'test',
        signature: 'verify:main-dirty',
        originTaskId: orphanOriginId,
      })

      const result = await br.markOriginDoneFromRecovery(orphanOriginId)

      expect(result.originFlipped).toBe(false)
      expect(result.actionQueueItemsClosed).toBe(1)
    })
  })

  describe('diagnose Chore verdict-driven branch (PRD 06e677fb)', () => {
    interface DiagnoseModule {
      setDiagnosis: typeof import('../diagnose').setDiagnosis
    }
    interface ActionQueueListModule {
      listActionQueueItems: typeof import('../action-queue').listActionQueueItems
    }

    const loadModulesWithDiagnose = async (
      repoPath: string,
    ): Promise<{
      q: QueueModule
      br: BlockerModule
      d: DiagnoseModule
      actionQueue: ActionQueueListModule
    }> => {
      vi.resetModules()
      process.env.MARS_REPO = repoPath
      const q = (await import('../../queue')) as unknown as QueueModule
      await q.initQueue()
      const br = (await import(
        '../../blocker-resolution'
      )) as unknown as BlockerModule
      const d = (await import('../diagnose')) as unknown as DiagnoseModule
      const actionQueue = (await import('../action-queue')) as unknown as ActionQueueListModule
      return { q, br, d, actionQueue }
    }

    const seedParkedParent = async (
      q: QueueModule,
      parentPrompt = 'do the original work',
    ): Promise<{ parentId: string; choreId: string }> => {
      const parent = await q.enqueueTask(parentPrompt, undefined, {
        skipTriage: true,
      })
      const chore = await q.enqueueTask(
        '# Diagnose-only Chore for ' + parent.id,
        undefined,
        { skipTriage: true, kind: 'diagnose', originId: parent.id },
      )
      await q.updateTask(chore.id, { status: 'done' })
      await q.addBlockers(parent.id, [chore.id])
      await q.updateTask(parent.id, { status: 'blocked', failedPhase: 'code' })
      return { parentId: parent.id, choreId: chore.id }
    }

    it('root-cause verdict: dispatches exactly one fix attempt seeded with the diagnosis and parks the parent behind it', async () => {
      const { q, br, d } = await loadModulesWithDiagnose(repo)
      const { parentId, choreId } = await seedParkedParent(q)
      await d.setDiagnosis(choreId, {
        kind: 'root-cause-found',
        evidence: 'helper foo() is not exported from src/utils.ts',
        involvedFiles: ['src/utils.ts', 'src/consumer.ts'],
        fixDirection: 'add `export` to foo and re-run the consumer',
      })

      const r = await br.onBlockerTaskCompleted(choreId)

      // The intercept returns an empty outcome list — the verdict-driven
      // branch owns the state transitions, not the generic unblock loop.
      expect(r.outcomes).toHaveLength(0)

      // Exactly one fix attempt was enqueued, seeded with the recorded diagnosis.
      const all = await q.getClient().execute({ sql: `SELECT * FROM tasks`, args: [] })
      const tasks = all.rows as unknown as Array<{ kind: string | null; prompt: string }>
      const fixes = tasks.filter((t) => t.kind === 'task' && t.prompt.includes('foo()'))
      expect(fixes).toHaveLength(1)
      expect(fixes[0].prompt).toContain('helper foo() is not exported')
      expect(fixes[0].prompt).toContain('src/utils.ts')
      expect(fixes[0].prompt).toContain('add `export` to foo')

      // The parent is parked blocked behind the fix — NOT queued.
      expect((await q.getTask(parentId))?.status).toBe('blocked')
      // No second diagnose Chore was spawned.
      const allKinds = tasks.map((t) => t.kind)
      expect(allKinds.filter((k) => k === 'diagnose')).toHaveLength(1)
    })

    it('inconclusive verdict: parks the parent failed and raises exactly one actionable actionQueue item, no fix dispatched', async () => {
      const { q, br, d, actionQueue } = await loadModulesWithDiagnose(repo)
      const { parentId, choreId } = await seedParkedParent(q)
      await d.setDiagnosis(choreId, {
        kind: 'inconclusive',
        whatChecked: 'walked src/foo, src/bar, looked for the missing helper',
        whyUnscoped: 'task references a module that does not exist in the repo',
      })

      await br.onBlockerTaskCompleted(choreId)

      // Parent must be failed, not queued.
      expect((await q.getTask(parentId))?.status).toBe('failed')

      // Exactly one actionQueue item of kind 'diagnose-inconclusive' was raised.
      const open = await actionQueue.listActionQueueItems('open')
      const diagnoseItems = open.filter((i) => i.kind === 'diagnose-inconclusive')
      expect(diagnoseItems).toHaveLength(1)
      expect(diagnoseItems[0].body).toContain('walked src/foo')
      expect(diagnoseItems[0].body).toContain('does not exist in the repo')

      // No fix attempt was created.
      const all = await q.getClient().execute({ sql: `SELECT kind FROM tasks`, args: [] })
      const kinds = (all.rows as unknown as Array<{ kind: string | null }>).map((r) => r.kind)
      expect(kinds.filter((k) => k === 'task')).toHaveLength(1) // only the original parent
    })

    it('no-verdict: treated as inconclusive — parent failed, one actionQueue item, no fix dispatched', async () => {
      const { q, br, actionQueue } = await loadModulesWithDiagnose(repo)
      const { parentId, choreId } = await seedParkedParent(q)
      // Deliberately omit setDiagnosis — emulate a Chore that exited cleanly
      // without recording a verdict.

      await br.onBlockerTaskCompleted(choreId)

      expect((await q.getTask(parentId))?.status).toBe('failed')

      const open = await actionQueue.listActionQueueItems('open')
      const diagnoseItems = open.filter((i) => i.kind === 'diagnose-inconclusive')
      expect(diagnoseItems).toHaveLength(1)
      expect(diagnoseItems[0].title).toMatch(/no verdict/i)

      // No fix was dispatched.
      const all = await q.getClient().execute({ sql: `SELECT kind FROM tasks`, args: [] })
      const kinds = (all.rows as unknown as Array<{ kind: string | null }>).map((r) => r.kind)
      expect(kinds.filter((k) => k === 'diagnose')).toHaveLength(1) // only the original chore
    })

    it('generic tasks are not intercepted — an ordinary done task still unblocks dependents normally', async () => {
      process.env.MARS_FIX_RETRY_BUDGET = '5'
      const { q, br } = await loadModulesWithDiagnose(repo)
      const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
      const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })
      await q.addBlockers(dep.id, [blocker.id])
      await q.getClient().execute({
        sql: `UPDATE tasks SET status = 'blocked', retry_count = 0 WHERE id = ?`,
        args: [dep.id],
      })
      await q.getClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [blocker.id],
      })

      const r = await br.onBlockerTaskCompleted(blocker.id)

      expect(r.outcomes).toHaveLength(1)
      expect(r.outcomes[0].outcome).toBe('queued')
      expect((await q.getTask(dep.id))?.status).toBe('queued')
    })
  })

  describe('worktree reset before re-dispatch (PRD a4deccc2 slice 1)', () => {
    it('onBlockerTaskCompleted hard-resets the dependent worktree to integration HEAD before flipping to queued', async () => {
      const { q, br } = await loadModules(repo)
      const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
      const fix = await q.enqueueTask('fix', undefined, { skipTriage: true })
      const { worktreePath, initialMainSha } = setupTaskWorktree(repo, dep.id)
      await q.updateTask(dep.id, { worktreePath, branch: `task/${dep.id}` })
      await blockTask(q, dep.id, fix.id, 0)
      // Advance main AFTER the worktree was branched off the initial sha.
      const advancedMainSha = advanceMain(repo, 'advanced\n')
      expect(advancedMainSha).not.toBe(initialMainSha)
      // Dependent worktree should still be at the initial main sha before reset.
      expect(headSha(worktreePath)).toBe(initialMainSha)
      // Resolve the blocker via the daemon-down path so onBlockerTaskCompleted
      // is exercised (auto-promote inside updateTask would otherwise short-circuit).
      await q.getClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [fix.id],
      })

      const r = await br.onBlockerTaskCompleted(fix.id)

      expect(r.outcomes).toHaveLength(1)
      expect(r.outcomes[0].outcome).toBe('queued')
      expect((await q.getTask(dep.id))?.status).toBe('queued')
      // The observable behaviour: the dependent's worktree HEAD now matches
      // the integration tip, so a dispatched implementor sees the blocker's
      // landed commits before it starts.
      expect(headSha(worktreePath)).toBe(advancedMainSha)
    })

    it('refuses to re-dispatch and fails with worktree_ahead_of_integration_at_unblock when the dependent worktree has commits ahead of integration', async () => {
      const { q, br } = await loadModules(repo)
      const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
      const fix = await q.enqueueTask('fix', undefined, { skipTriage: true })
      const { worktreePath } = setupTaskWorktree(repo, dep.id)
      await q.updateTask(dep.id, { worktreePath, branch: `task/${dep.id}` })
      // Add a commit on the dependent's branch so it's ahead of main.
      writeFileSync(resolve(worktreePath, 'dep.txt'), 'dep work\n')
      execFileSync('git', ['add', 'dep.txt'], { cwd: worktreePath })
      execFileSync('git', ['commit', '-q', '-m', 'dep ahead'], {
        cwd: worktreePath,
      })
      const depHeadBefore = headSha(worktreePath)
      await blockTask(q, dep.id, fix.id, 0)
      await q.getClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [fix.id],
      })

      const r = await br.onBlockerTaskCompleted(fix.id)

      expect(r.outcomes).toHaveLength(1)
      expect(r.outcomes[0].outcome).toBe('failed')
      expect(r.outcomes[0].failureReason).toBe(
        'worktree_ahead_of_integration_at_unblock',
      )
      const reloaded = await q.getTask(dep.id)
      expect(reloaded?.status).toBe('failed')
      // The worktree must be left untouched — no auto-rebase.
      expect(headSha(worktreePath)).toBe(depHeadBefore)

      const actionQueue = (await import('../action-queue')) as unknown as {
        listActionQueueItems: typeof import('../action-queue').listActionQueueItems
      }
      const open = await actionQueue.listActionQueueItems('open')
      const ahead = open.find(
        (i) => i.kind === 'worktree-ahead',
      )
      expect(ahead).toBeDefined()
      expect(ahead!.payload.taskId).toBe(dep.id)
      expect(ahead!.payload.aheadCount).toBe(1)
    })

    it('skips reset cleanly when the dependent has no worktree yet (fresh row, no prior setup)', async () => {
      // Negative-space test: a never-dispatched dependent has worktreePath=null.
      // The reset must be a no-op so the dependent flips to queued normally and
      // the implement workflow's setup step creates a fresh worktree off main.
      const { q, br } = await loadModules(repo)
      const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
      const fix = await q.enqueueTask('fix', undefined, { skipTriage: true })
      await blockTask(q, dep.id, fix.id, 0)
      await q.getClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [fix.id],
      })

      const r = await br.onBlockerTaskCompleted(fix.id)

      expect(r.outcomes).toHaveLength(1)
      expect(r.outcomes[0].outcome).toBe('queued')
      expect((await q.getTask(dep.id))?.status).toBe('queued')
    })
  })

  // publish() call sites in this module are all legitimate co-commits: each
  // opens a single transaction that atomically flips a task status AND writes
  // the outbox event. None are standalone "publish-only" transactions, so none
  // are rewired to publishWithRetry. These tests guard that atomicity: if the
  // co-commit is ever accidentally split, the event row would disappear while
  // the task row stays — a regression these assertions would catch.
  describe('outbox event publication — publish() co-commits are atomic with status flips', () => {
    it('onBlockerTaskCompleted writes a task.unblocked event to the outbox atomically with the queued flip', async () => {
      const { q, br } = await loadModules(repo)
      const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
      const fix = await q.enqueueTask('fix', undefined, { skipTriage: true })
      await blockTask(q, dep.id, fix.id, 0)
      await q.getClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [fix.id],
      })

      await br.onBlockerTaskCompleted(fix.id)

      const events = await q.getClient().execute({
        sql: `SELECT type, payload FROM events WHERE type = 'task.unblocked' ORDER BY id DESC LIMIT 1`,
        args: [],
      })
      expect(events.rows).toHaveLength(1)
      const payload = JSON.parse(events.rows[0].payload as string) as {
        taskId: string
        blockerTaskId: string
      }
      expect(payload.taskId).toBe(dep.id)
      expect(payload.blockerTaskId).toBe(fix.id)
      // State and event must both be present — they committed in the same tx.
      expect((await q.getTask(dep.id))?.status).toBe('queued')
    })

    it('markOriginDoneFromRecovery writes a task.completed event to the outbox atomically with the done flip', async () => {
      const { q, br } = await loadModules(repo)
      const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
      await q.getClient().execute({
        sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
        args: [origin.id],
      })

      const result = await br.markOriginDoneFromRecovery(origin.id)

      expect(result.originFlipped).toBe(true)
      const events = await q.getClient().execute({
        sql: `SELECT type, payload FROM events WHERE type = 'task.completed' ORDER BY id DESC LIMIT 1`,
        args: [],
      })
      expect(events.rows).toHaveLength(1)
      const payload = JSON.parse(events.rows[0].payload as string) as {
        taskId: string
        result: { via: string }
      }
      expect(payload.taskId).toBe(origin.id)
      expect(payload.result.via).toBe('recovery')
      // State and event must both be present — they committed in the same tx.
      expect((await q.getTask(origin.id))?.status).toBe('done')
    })
  })
})
