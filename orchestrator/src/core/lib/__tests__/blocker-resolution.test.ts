import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  addBlockers: typeof import('../../queue').addBlockers
}

type ArcStatic = typeof import('../../arc').Arc
type ArcInstance = ArcStatic['prototype']

interface BlockerModule {
  onBlockerTaskCompleted: ArcStatic['unblockByCompletion']
  onBlockerTaskFailed: ArcStatic['blockByTaskFailure']
  markOriginDoneFromRecovery: (
    originTaskId: string,
  ) => ReturnType<ArcInstance['propagateRecoveryDone']>
  recoverBlockedTask: (
    taskId: string,
  ) => ReturnType<ArcInstance['recoverBlocked']>
  recoverAllBlockedTasks: ArcStatic['recoverAllBlocked']
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
  await q.migrateQueueSchema()
  const { Arc } = await import('../../arc')
  // Adapter: the six writers relocated into the Arc aggregate (ADR-0052).
  // The historic free-function names map onto Arc static/instance methods so
  // the test bodies below exercise the relocated logic unchanged.
  const br: BlockerModule = {
    onBlockerTaskCompleted: (id) => Arc.unblockByCompletion(id),
    onBlockerTaskFailed: (id) => Arc.blockByTaskFailure(id),
    markOriginDoneFromRecovery: (originTaskId) =>
      Arc.load(originTaskId).propagateRecoveryDone(),
    recoverBlockedTask: (id) => Arc.load(id).recoverBlocked(),
    recoverAllBlockedTasks: () => Arc.recoverAllBlocked(),
  }
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
  await q.resolveQueueClient().execute({
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

  it('queues a dependent that already burned a retry (retry_count=1) at unblock time — no retry-budget gate', async () => {
    // The retry-budget silent-fail gate was removed (mars-3d63fe52): a
    // dependent that becomes eligible must ALWAYS re-dispatch (queued),
    // regardless of retry_count. Previously a retry_count>=1 dependent was
    // silently failed with recovery_exhausted_at_unblock and never ran.
    const { q, br } = await loadModules(repo)
    const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
    const fix = await q.enqueueTask('fix', undefined, { skipTriage: true })
    await blockTask(q, dep.id, fix.id, 1)
    // Mark fix done WITHOUT calling updateTask (which would auto-promote);
    // simulate the daemon-down path.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [fix.id],
    })

    const r = await br.onBlockerTaskCompleted(fix.id)
    expect(r.outcomes).toHaveLength(1)
    expect(r.outcomes[0].outcome).toBe('queued')
    expect(r.outcomes[0].retryCount).toBe(1)
    const reloaded = await q.getTask(dep.id)
    expect(reloaded?.status).toBe('queued')
    expect(reloaded?.failureReason).toBeFalsy()

    // No silent-fail action-queue item is raised for a re-queued dependent.
    const actionQueue = (await import('../action-queue')) as unknown as {
      listActionQueueItems: typeof import('../action-queue').listActionQueueItems
    }
    const open = await actionQueue.listActionQueueItems('open')
    const taskBlocked = open.filter((i) => i.kind === 'failed' && i.payload.taskId === dep.id)
    expect(taskBlocked).toHaveLength(0)
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
    await q.resolveQueueClient().execute({
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
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked', retry_count = 1 WHERE id = ?`,
      args: [dep.id],
    })
    // Only a is done; b is still pending.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [a.id],
    })

    const r = await br.onBlockerTaskCompleted(a.id)
    expect(r.outcomes).toHaveLength(1)
    expect(r.outcomes[0].outcome).toBe('noop')
    const reloaded = await q.getTask(dep.id)
    expect(reloaded?.status).toBe('blocked')
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
      await q.resolveQueueClient().execute({
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
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'running' WHERE id = ?`,
        args: [running.id],
      })
      await q.resolveQueueClient().execute({
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
      await q.resolveQueueClient().execute({
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
      await q.resolveQueueClient().execute({
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
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
        args: [origin.id],
      })
      const recoveryId = await makeRecoveryRow(q, origin.id)
      await q.resolveQueueClient().execute({
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
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
        args: [origin.id],
      })
      const recoveryId = await makeRecoveryRow(q, origin.id)
      await q.resolveQueueClient().execute({
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

    it('is a no-op when origin is already done (true idempotent case)', async () => {
      // 'done' is the only status that is a genuine no-op: the origin is already
      // in the desired terminal state and there is no open failed-task row.
      const { q, br } = await loadModules(repo)
      const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [origin.id],
      })

      const result = await br.markOriginDoneFromRecovery(origin.id)

      expect(result.originFlipped).toBe(false)
      expect(result.unblock).toBeNull()
      expect(result.actionQueueItemsClosed).toBe(0)
      expect((await q.getTask(origin.id))?.status).toBe('done')
    })

    // Regression guard for the status-reconciliation race (mars-a007a7d0):
    // a successful recovery must flip a 'failed' origin to 'done' — origins
    // stranding in 'failed' after their recovery succeeds was the bug.
    it('flips a failed origin to done, closes its action-queue row, and unblocks dependents', async () => {
      const { q, br, actionQueue } = await loadModules(repo)
      const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
      const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
      await blockTask(q, dep.id, origin.id, 0)
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
        args: [origin.id],
      })
      await actionQueue.raiseActionQueueItem({
        kind: 'failed',
        category: 'orchestrator',
        priority: 'high',
        title: 'origin task failed',
        body: 'test',
        payload: {},
        context: {},
        raisedBy: 'test',
        signature: 'verify:has-diff/no-commits-ahead',
        originTaskId: origin.id,
      })

      const result = await br.markOriginDoneFromRecovery(origin.id)

      // The recovery is authoritative: the origin must flip to done.
      expect(result.originFlipped).toBe(true)
      expect(result.actionQueueItemsClosed).toBe(1)
      expect(result.unblock).not.toBeNull()
      expect(result.unblock!.outcomes.map((o) => o.outcome)).toContain('queued')
      expect((await q.getTask(origin.id))?.status).toBe('done')
      expect((await q.getTask(dep.id))?.status).toBe('queued')
      // Action-queue row must be closed.
      const open = await actionQueue.listActionQueueItems('open')
      expect(open.find((r) => r.kind === 'failed')).toBeUndefined()
    })

    it('flips a dropped origin to done when recovery succeeds', async () => {
      const { q, br } = await loadModules(repo)
      const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'dropped' WHERE id = ?`,
        args: [origin.id],
      })

      const result = await br.markOriginDoneFromRecovery(origin.id)

      expect(result.originFlipped).toBe(true)
      expect((await q.getTask(origin.id))?.status).toBe('done')
    })

    // Bug guard (superseded by mars-a007a7d0 fix): previously the early-return on
    // terminal-origin skipped supersedeActionQueueItemsForOrigin entirely and
    // stranded the row, AND the origin stayed 'failed'. The fix reconciles both:
    // the action-queue row is closed AND the origin is flipped to 'done'.
    it('closes actionQueue rows and reconciles a terminal-failed origin to done when recovery succeeds', async () => {
      const { q, br, actionQueue } = await loadModules(repo)
      const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
      await q.resolveQueueClient().execute({
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

      // Both the status flip AND the row close must happen atomically.
      expect(result.originFlipped).toBe(true)
      expect(result.actionQueueItemsClosed).toBe(1)
      expect((await q.getTask(origin.id))?.status).toBe('done')
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
      await q.migrateQueueSchema()
      const { Arc } = await import('../../arc')
      const br: BlockerModule = {
        onBlockerTaskCompleted: (id) => Arc.unblockByCompletion(id),
        onBlockerTaskFailed: (id) => Arc.blockByTaskFailure(id),
        markOriginDoneFromRecovery: (originTaskId) =>
          Arc.load(originTaskId).propagateRecoveryDone(),
        recoverBlockedTask: (id) => Arc.load(id).recoverBlocked(),
        recoverAllBlockedTasks: () => Arc.recoverAllBlocked(),
      }
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
      const all = await q.resolveQueueClient().execute({ sql: `SELECT * FROM tasks`, args: [] })
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
      const all = await q.resolveQueueClient().execute({ sql: `SELECT kind FROM tasks`, args: [] })
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
      const all = await q.resolveQueueClient().execute({ sql: `SELECT kind FROM tasks`, args: [] })
      const kinds = (all.rows as unknown as Array<{ kind: string | null }>).map((r) => r.kind)
      expect(kinds.filter((k) => k === 'diagnose')).toHaveLength(1) // only the original chore
    })

    it('generic tasks are not intercepted — an ordinary done task still unblocks dependents normally', async () => {
      process.env.MARS_FIX_RETRY_BUDGET = '5'
      const { q, br } = await loadModulesWithDiagnose(repo)
      const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
      const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })
      await q.addBlockers(dep.id, [blocker.id])
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'blocked', retry_count = 0 WHERE id = ?`,
        args: [dep.id],
      })
      await q.resolveQueueClient().execute({
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
      await q.resolveQueueClient().execute({
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
      await q.resolveQueueClient().execute({
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
      // The typed payload carries the actual unique commits ahead of the
      // integration branch (the scalar `aheadCount` field was replaced by this
      // richer list in the WorktreeAheadPayload hard cut); the human-readable
      // count still reaches the operator through the body copy.
      const commitsAhead = ahead!.payload.commitsAhead as Array<{
        shortSha: string
        subject: string
      }>
      expect(commitsAhead).toHaveLength(1)
      expect(commitsAhead[0].subject).toBe('dep ahead')
      expect(ahead!.body).toContain('is 1 commit(s) ahead of main')
    })

    it('skips reset cleanly when the dependent has no worktree yet (fresh row, no prior setup)', async () => {
      // Negative-space test: a never-dispatched dependent has worktreePath=null.
      // The reset must be a no-op so the dependent flips to queued normally and
      // the implement workflow's setup step creates a fresh worktree off main.
      const { q, br } = await loadModules(repo)
      const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
      const fix = await q.enqueueTask('fix', undefined, { skipTriage: true })
      await blockTask(q, dep.id, fix.id, 0)
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [fix.id],
      })

      const r = await br.onBlockerTaskCompleted(fix.id)

      expect(r.outcomes).toHaveLength(1)
      expect(r.outcomes[0].outcome).toBe('queued')
      expect((await q.getTask(dep.id))?.status).toBe('queued')
    })

    // -----------------------------------------------------------------------
    // On-main lean line (PRD cbb37ea7 slice 1)
    // -----------------------------------------------------------------------

    it('appends "lean PURGE" when the worktree branch tip is already reachable from the integration branch', async () => {
      // Scenario: the parked worktree's HEAD is an ancestor of main (its work
      // was merged through some other path while the task sat blocked). The
      // operator should purge rather than restart.
      vi.resetModules()
      process.env.MARS_REPO = repo
      const q2 = (await import('../../queue')) as unknown as QueueModule
      await q2.migrateQueueSchema()
      const { raiseWorktreeAheadActionQueue } = await import('../../blocker-resolution')
      const { listActionQueueItems } = (await import('../action-queue')) as unknown as ActionQueueModule

      const taskId = 'lean-purge-test'
      const { worktreePath } = setupTaskWorktree(repo, taskId)
      // Add a commit on the task branch so the branch is ahead of where it branched.
      writeFileSync(resolve(worktreePath, 'work.txt'), 'work\n')
      execFileSync('git', ['add', 'work.txt'], { cwd: worktreePath })
      execFileSync('git', ['commit', '-q', '-m', 'task work'], { cwd: worktreePath })
      // Fast-forward main to include that commit: now the branch tip IS an
      // ancestor of main (the branch tip == main tip after the fast-forward).
      execFileSync('git', ['merge', '--ff-only', `task/${taskId}`], { cwd: repo })

      await raiseWorktreeAheadActionQueue(taskId, worktreePath, 1, 'main')

      const open = await listActionQueueItems('open')
      const item = open.find((i) => i.kind === 'worktree-ahead' && i.payload.taskId === taskId)
      expect(item).toBeDefined()
      expect(item!.body).toContain('lean PURGE')
      expect(item!.body).not.toContain('lean RESTART')
      // Payload schema is unchanged.
      expect(item!.payload.failureReason).toBe('worktree_ahead_of_integration_at_unblock')
      expect(item!.payload.worktreePath).toBe(worktreePath)
      expect(item!.payload.integrationBranch).toBe('main')
      expect(item!.payload.onMainLean).toBe('on-main')
      // The branch was fast-forwarded into main, so it has no unique commits
      // left ahead of the integration branch — which is exactly why the lean is
      // PURGE. The caller-supplied count still shows up in the body copy.
      expect(item!.payload.commitsAhead).toEqual([])
      expect(item!.body).toContain('is 1 commit(s) ahead of main')
    })

    it('appends "lean RESTART" when the worktree branch tip is NOT reachable from the integration branch', async () => {
      // Scenario: the parked worktree has commits not yet on main (diverged).
      // The operator must restart so those commits can be re-run through verify.
      vi.resetModules()
      process.env.MARS_REPO = repo
      const q2 = (await import('../../queue')) as unknown as QueueModule
      await q2.migrateQueueSchema()
      const { raiseWorktreeAheadActionQueue } = await import('../../blocker-resolution')
      const { listActionQueueItems } = (await import('../action-queue')) as unknown as ActionQueueModule

      const taskId = 'lean-restart-test'
      const { worktreePath } = setupTaskWorktree(repo, taskId)
      // Add a commit on the task branch (branch diverges from main here).
      writeFileSync(resolve(worktreePath, 'task-work.txt'), 'task\n')
      execFileSync('git', ['add', 'task-work.txt'], { cwd: worktreePath })
      execFileSync('git', ['commit', '-q', '-m', 'task work'], { cwd: worktreePath })
      // Add a different commit on main so the histories diverge.
      writeFileSync(resolve(repo, 'main-advance.txt'), 'main\n')
      execFileSync('git', ['add', 'main-advance.txt'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'main advance'], { cwd: repo })
      // Branch tip is NOT in main's ancestry.

      await raiseWorktreeAheadActionQueue(taskId, worktreePath, 1, 'main')

      const open = await listActionQueueItems('open')
      const item = open.find((i) => i.kind === 'worktree-ahead' && i.payload.taskId === taskId)
      expect(item).toBeDefined()
      expect(item!.body).toContain('lean RESTART')
      expect(item!.body).not.toContain('lean PURGE')
      // Payload schema is unchanged.
      expect(item!.payload.failureReason).toBe('worktree_ahead_of_integration_at_unblock')
    })

    it('omits the lean line and still raises the item when the worktree path is missing on disk', async () => {
      // Failure-tolerance: a missing worktree must not prevent the action queue
      // item from being raised — the operator still needs to see the alert.
      vi.resetModules()
      process.env.MARS_REPO = repo
      const q2 = (await import('../../queue')) as unknown as QueueModule
      await q2.migrateQueueSchema()
      const { raiseWorktreeAheadActionQueue } = await import('../../blocker-resolution')
      const { listActionQueueItems } = (await import('../action-queue')) as unknown as ActionQueueModule

      const taskId = 'lean-unknown-test'
      const missingPath = resolve(repo, '.mars', 'worktrees', taskId)
      // missingPath does not exist on disk.

      await raiseWorktreeAheadActionQueue(taskId, missingPath, 1, 'main')

      const open = await listActionQueueItems('open')
      const item = open.find((i) => i.kind === 'worktree-ahead' && i.payload.taskId === taskId)
      expect(item).toBeDefined()
      expect(item!.body).not.toContain('lean PURGE')
      expect(item!.body).not.toContain('lean RESTART')
      // The item is still fully formed.
      expect(item!.payload.failureReason).toBe('worktree_ahead_of_integration_at_unblock')
      expect(item!.payload.worktreePath).toBe(missingPath)
      // No worktree on disk and no such branch → the lean is unknown and the
      // commit list degrades to empty rather than throwing.
      expect(item!.payload.onMainLean).toBe('unknown')
      expect(item!.payload.commitsAhead).toEqual([])
      expect(item!.body).toContain('is 1 commit(s) ahead of main')
    })
  })

  // -----------------------------------------------------------------------
  // recoverBlockedTask / recoverAllBlockedTasks
  // -----------------------------------------------------------------------
  describe('recoverBlockedTask', () => {
    it('queues a blocked task whose sole blocker is already done', async () => {
      process.env.MARS_FIX_RETRY_BUDGET = '5'
      const { q, br } = await loadModules(repo)
      const dep = await q.enqueueTask('dependent', undefined, { skipTriage: true })
      const fix = await q.enqueueTask('fix', undefined, { skipTriage: true })
      await blockTask(q, dep.id, fix.id, 0)
      // Mark the blocker done without going through onBlockerTaskCompleted —
      // simulates a daemon that missed the terminal event (crash, restart, etc.)
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [fix.id],
      })

      const result = await br.recoverBlockedTask(dep.id)

      expect(result.outcome).toBe('queued')
      expect(result.taskId).toBe(dep.id)
      expect((await q.getTask(dep.id))?.status).toBe('queued')
    })

    it('queues a blocked task after its sole blocker edge is removed (edge-removal path)', async () => {
      const { q, br } = await loadModules(repo)
      const dep = await q.enqueueTask('dependent', undefined, { skipTriage: true })
      const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })
      await blockTask(q, dep.id, blocker.id, 0)
      // Simulate the mars unblock dep.id blocker.id edge removal
      await q.resolveQueueClient().execute({
        sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
        args: [dep.id, blocker.id],
      })

      const result = await br.recoverBlockedTask(dep.id)

      expect(result.outcome).toBe('queued')
      expect((await q.getTask(dep.id))?.status).toBe('queued')
    })

    it('is noop when the task still has unmet blockers', async () => {
      const { q, br } = await loadModules(repo)
      const dep = await q.enqueueTask('dependent', undefined, { skipTriage: true })
      const fix1 = await q.enqueueTask('fix1', undefined, { skipTriage: true })
      const fix2 = await q.enqueueTask('fix2', undefined, { skipTriage: true })
      await blockTask(q, dep.id, fix1.id, 0)
      await q.addBlockers(dep.id, [fix2.id])
      // Only fix1 is done; fix2 is still queued
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [fix1.id],
      })

      const result = await br.recoverBlockedTask(dep.id)

      expect(result.outcome).toBe('noop')
      expect((await q.getTask(dep.id))?.status).toBe('blocked')
    })

    it('returns not-blocked for a task that is not blocked', async () => {
      const { q, br } = await loadModules(repo)
      const task = await q.enqueueTask('task', undefined, { skipTriage: true })
      // task is 'queued' by default

      const result = await br.recoverBlockedTask(task.id)

      expect(result.outcome).toBe('not-blocked')
      expect((await q.getTask(task.id))?.status).toBe('queued')
    })

    it('writes a task.unblocked event to the outbox atomically with the queued flip', async () => {
      const { q, br } = await loadModules(repo)
      const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
      const fix = await q.enqueueTask('fix', undefined, { skipTriage: true })
      await blockTask(q, dep.id, fix.id, 0)
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [fix.id],
      })

      await br.recoverBlockedTask(dep.id)

      const events = await q.resolveQueueClient().execute({
        sql: `SELECT type, payload FROM events WHERE type = 'task.unblocked' ORDER BY id DESC LIMIT 1`,
        args: [],
      })
      expect(events.rows).toHaveLength(1)
      const payload = JSON.parse(events.rows[0].payload as string) as { taskId: string }
      expect(payload.taskId).toBe(dep.id)
      // Outbox event and status flip must be in the same transaction
      expect((await q.getTask(dep.id))?.status).toBe('queued')
    })
  })

  // -----------------------------------------------------------------------
  // No retry-budget gate: an eligible dependent ALWAYS re-dispatches (queued)
  // at unblock time, regardless of retry_count. The retry-budget silent-fail
  // gate (recovery_exhausted_at_unblock) was removed — mars-3d63fe52. The
  // one-recovery-per-origin model is unaffected: a recovery reaching done
  // still reconciles its origin to done via propagateRecoveryDone.
  // -----------------------------------------------------------------------
  describe('unblock re-queues eligible dependents regardless of retry_count', () => {
    const makeOwnRecovery = async (
      q: QueueModule,
      originTaskId: string,
      recoveryStatus: string,
    ): Promise<string> => {
      const fix = await q.enqueueTask('recovery fix', undefined, { skipTriage: true })
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks
                 SET kind = 'fix',
                     fix_for_task_id = ?,
                     status = ?
               WHERE id = ?`,
        args: [originTaskId, recoveryStatus, fix.id],
      })
      return fix.id
    }

    it('recoverBlocked: retry_count=1 with all blockers resolved → queued (was failed under the removed gate)', async () => {
      // The gate used to fail this task with recovery_exhausted_at_unblock.
      // Now a dependent that burned a retry re-dispatches like any other.
      const { q, br } = await loadModules(repo)
      const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
      const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })
      await blockTask(q, origin.id, blocker.id, 1)
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [blocker.id],
      })

      const result = await br.recoverBlockedTask(origin.id)

      expect(result.outcome).toBe('queued')
      const reloaded = await q.getTask(origin.id)
      expect(reloaded?.status).toBe('queued')
      expect(reloaded?.failureReason).toBeFalsy()
    })

    it('recoverBlocked: fresh task retry_count=0 with all blockers resolved → queued', async () => {
      const { q, br } = await loadModules(repo)
      const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
      const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })
      await blockTask(q, origin.id, blocker.id, 0)
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [blocker.id],
      })

      const result = await br.recoverBlockedTask(origin.id)

      expect(result.outcome).toBe('queued')
      expect((await q.getTask(origin.id))?.status).toBe('queued')
    })

    it('recoverBlocked: a large retry_count is not a cap — still queues', async () => {
      // There is no budget ceiling anymore, so even a task that "burned"
      // many retries re-dispatches once its blockers resolve.
      const { q, br } = await loadModules(repo)
      const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
      const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })
      await blockTask(q, origin.id, blocker.id, 7)
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [blocker.id],
      })

      const result = await br.recoverBlockedTask(origin.id)

      expect(result.outcome).toBe('queued')
      expect((await q.getTask(origin.id))?.status).toBe('queued')
    })

    it('unblockByCompletion: retry_count=1 dependent released by an external blocker → queued', async () => {
      const { q, br } = await loadModules(repo)
      const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
      const externalBlocker = await q.enqueueTask('external', undefined, { skipTriage: true })
      await blockTask(q, dep.id, externalBlocker.id, 1)
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [externalBlocker.id],
      })

      const r = await br.onBlockerTaskCompleted(externalBlocker.id)

      const outcome = r.outcomes.find((o) => o.taskId === dep.id)
      expect(outcome?.outcome).toBe('queued')
      const reloaded = await q.getTask(dep.id)
      expect(reloaded?.status).toBe('queued')
      expect(reloaded?.failureReason).toBeFalsy()
    })

    it('one-recovery model preserved: a recovery reaching done reconciles its origin to done (retry_count does not fail it)', async () => {
      // The removed gate is orthogonal to the one-recovery-per-origin model.
      // When a recovery ships done, propagateRecoveryDone (the daemon path)
      // flips the origin to done and cascades — regardless of retry_count.
      const { q, br } = await loadModules(repo)
      const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
      const dep = await q.enqueueTask('downstream', undefined, { skipTriage: true })
      // Origin parked as blocked with retry_count=1; its recovery is done.
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'blocked', retry_count = 1 WHERE id = ?`,
        args: [origin.id],
      })
      await q.addBlockers(dep.id, [origin.id])
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'blocked', retry_count = 0 WHERE id = ?`,
        args: [dep.id],
      })
      await makeOwnRecovery(q, origin.id, 'done')

      const propagation = await br.markOriginDoneFromRecovery(origin.id)
      expect(propagation.originFlipped).toBe(true)

      const originReloaded = await q.getTask(origin.id)
      const depReloaded = await q.getTask(dep.id)
      expect(originReloaded?.status).toBe('done')
      expect(originReloaded?.failureReason).not.toBe('recovery_exhausted_at_unblock')
      expect(depReloaded?.status).toBe('queued')
    })
  })

  describe('recoverAllBlockedTasks', () => {
    it('queues all blocked tasks whose blockers are all done and leaves still-blocked tasks alone', async () => {
      const { q, br } = await loadModules(repo)
      const dep1 = await q.enqueueTask('dep1', undefined, { skipTriage: true })
      const dep2 = await q.enqueueTask('dep2', undefined, { skipTriage: true })
      const dep3 = await q.enqueueTask('dep3-still-blocked', undefined, { skipTriage: true })
      const fix1 = await q.enqueueTask('fix1', undefined, { skipTriage: true })
      const fix2 = await q.enqueueTask('fix2', undefined, { skipTriage: true })
      const unmet = await q.enqueueTask('unmet', undefined, { skipTriage: true })
      await blockTask(q, dep1.id, fix1.id, 0)
      await blockTask(q, dep2.id, fix2.id, 0)
      await blockTask(q, dep3.id, unmet.id, 0)
      // fix1 and fix2 done; unmet still queued
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id IN (?, ?)`,
        args: [fix1.id, fix2.id],
      })

      const result = await br.recoverAllBlockedTasks()

      const queuedIds = result.outcomes
        .filter((o) => o.outcome === 'queued')
        .map((o) => o.taskId)
        .sort()
      expect(queuedIds).toEqual([dep1.id, dep2.id].sort())

      const noopIds = result.outcomes
        .filter((o) => o.outcome === 'noop')
        .map((o) => o.taskId)
      expect(noopIds).toEqual([dep3.id])

      expect((await q.getTask(dep1.id))?.status).toBe('queued')
      expect((await q.getTask(dep2.id))?.status).toBe('queued')
      expect((await q.getTask(dep3.id))?.status).toBe('blocked')
    })

    it('returns empty outcomes when no tasks are blocked', async () => {
      const { q, br } = await loadModules(repo)
      await q.enqueueTask('task', undefined, { skipTriage: true })

      const result = await br.recoverAllBlockedTasks()

      expect(result.outcomes).toHaveLength(0)
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
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [fix.id],
      })

      await br.onBlockerTaskCompleted(fix.id)

      const events = await q.resolveQueueClient().execute({
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
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
        args: [origin.id],
      })

      const result = await br.markOriginDoneFromRecovery(origin.id)

      expect(result.originFlipped).toBe(true)
      const events = await q.resolveQueueClient().execute({
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

    it('marks recovery-completed tasks terminal in the same outbox transition', async () => {
      const { q, br } = await loadModules(repo)
      const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
        args: [origin.id],
      })

      await br.markOriginDoneFromRecovery(origin.id)

      const events = await q.resolveQueueClient().execute({
        sql: `SELECT payload FROM events WHERE type = 'task.terminal' ORDER BY id DESC LIMIT 1`,
        args: [],
      })
      expect(events.rows).toHaveLength(1)
      expect(JSON.parse(events.rows[0].payload as string)).toEqual({
        taskId: origin.id,
        reason: 'done',
      })
    })
  })

  describe('IllegalTransitionError — terminal-state guard', () => {
    it('markTaskFailed on a done task throws IllegalTransitionError and leaves the row in done', async () => {
      const { q } = await loadModules(repo)
      const task = await q.enqueueTask('some work', undefined, { skipTriage: true })
      // Force the task into the terminal 'done' state directly.
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
        args: [task.id],
      })

      const queueRetry = (await import('../../queue-retry')) as unknown as {
        markTaskFailed: typeof import('../../queue-retry').markTaskFailed
      }
      const { IllegalTransitionError } = (await import('../../queue')) as unknown as {
        IllegalTransitionError: typeof import('../../queue').IllegalTransitionError
      }

      await expect(queueRetry.markTaskFailed(task.id, 'some error')).rejects.toThrow(
        IllegalTransitionError,
      )

      // Row must remain 'done' — no partial write.
      const reloaded = await q.getTask(task.id)
      expect(reloaded?.status).toBe('done')
    })
  })

  // -----------------------------------------------------------------------
  // landTask — operator gesture to land worktree-ahead commits
  // -----------------------------------------------------------------------
  describe('landTask — operator gesture to land worktree-ahead commits', { timeout: 120_000 }, () => {
    /**
     * Shared load helper for landTask tests.  Resets modules each time so the
     * DB client picks up the MARS_REPO override, matching the pattern used by
     * the rest of this file.
     */
    const loadLandModules = async (repoPath: string) => {
      vi.resetModules()
      process.env.MARS_REPO = repoPath
      const q = (await import('../../queue')) as unknown as QueueModule
      await q.migrateQueueSchema()
      const actionQueue = (await import('../action-queue')) as unknown as ActionQueueModule
      const blockerSubscriber = await import('../../../outbox/subscribers/blocker-resolution')
      const { landTask } = await import('../../land-task')
      return { q, actionQueue, blockerSubscriber, landTask }
    }

    /**
     * Create a task whose worktree branch has one commit ahead of main, and
     * set the task row to 'failed' with the correct worktreePath/branch.
     * Returns the task id, worktree path, and the commit sha.
     */
    const seedWorktreeAheadTask = async (
      q: QueueModule,
      repoPath: string,
    ): Promise<{ taskId: string; worktreePath: string; commitSha: string }> => {
      const task = await q.enqueueTask('do some work', undefined, { skipTriage: true })
      const { worktreePath } = setupTaskWorktree(repoPath, task.id)
      // Add a commit on the task branch so it is ahead of main.
      writeFileSync(resolve(worktreePath, 'work.txt'), 'completed work\n')
      execFileSync('git', ['add', 'work.txt'], { cwd: worktreePath })
      execFileSync('git', ['commit', '-q', '-m', 'task work'], { cwd: worktreePath })
      const commitSha = headSha(worktreePath)
      // Set the task to 'failed' with worktreePath + branch (mimicking the
      // worktree-ahead scenario that prompted the land gesture).
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks
                 SET status = 'failed',
                     worktree_path = ?,
                     branch = ?
               WHERE id = ?`,
        args: [worktreePath, `task/${task.id}`, task.id],
      })
      return { taskId: task.id, worktreePath, commitSha }
    }

    it('clean land: lands commits onto integration, marks task done, resolves action-queue item', async () => {
      const { q, actionQueue, landTask } = await loadLandModules(repo)
      const { taskId, worktreePath, commitSha } = await seedWorktreeAheadTask(q, repo)

      // Raise a worktree-ahead action-queue item (as the daemon would have).
      await actionQueue.raiseActionQueueItem({
        kind: 'worktree-ahead',
        category: 'orchestrator',
        priority: 'normal',
        title: `Task ${taskId} worktree is ahead`,
        body: 'worktree ahead',
        payload: { taskId, worktreePath, aheadCount: 1, integrationBranch: 'main' },
        context: {},
        raisedBy: 'test',
        signature: `${taskId}:worktree-ahead`,
        originTaskId: taskId,
      })

      const result = await landTask(taskId)

      // Observable outcome: landed successfully.
      expect(result.outcome).toBe('landed')
      expect(result.aheadCount).toBe(1)

      // Task must be done.
      const reloaded = await q.getTask(taskId)
      expect(reloaded?.status).toBe('done')

      // Integration branch (main) must now point at the task commit.
      const mainSha = execFileSync('git', ['rev-parse', 'main'], { cwd: repo }).toString().trim()
      expect(mainSha).toBe(commitSha)

      // Action-queue rows for this task must be resolved.
      const open = await actionQueue.listActionQueueItems('open')
      const ahead = open.find((i) => i.kind === 'worktree-ahead' && i.payload.taskId === taskId)
      expect(ahead).toBeUndefined()
    })

    it('queues a task blocked solely on a landed task through the terminal outbox event', async () => {
      const { q, blockerSubscriber, landTask } = await loadLandModules(repo)
      const { taskId: blockerId } = await seedWorktreeAheadTask(q, repo)
      const dependent = await q.enqueueTask('wait for landed work', undefined, { skipTriage: true })
      await blockTask(q, dependent.id, blockerId)

      // Registration precedes land, so this drain observes exactly the event
      // written by the operator gesture rather than relying on startup repair.
      await blockerSubscriber.ensureBlockerResolutionSubscriber(q.resolveQueueClient())

      expect((await landTask(blockerId)).outcome).toBe('landed')
      expect((await blockerSubscriber.drainBlockerResolution(q.resolveQueueClient())).processed).toBeGreaterThan(0)
      expect((await q.getTask(dependent.id))?.status).toBe('queued')
    })

    it('recreates a missing worktree from an ahead failed task branch before landing', async () => {
      const { q, landTask } = await loadLandModules(repo)
      const { taskId, worktreePath, commitSha } = await seedWorktreeAheadTask(q, repo)

      // The task branch still contains the committed work, but the directory
      // was reaped. This is the recovery state `mars land` must repair without
      // directing the operator to destructive restart.
      // Simulate the directory disappearing beneath Git, leaving the stale
      // worktree registration that the incident exposed.
      rmSync(worktreePath, { recursive: true, force: true })

      const result = await landTask(taskId)

      expect(result.outcome).toBe('landed')
      expect(result.message).not.toContain('restart')
      expect(
        execFileSync('git', ['rev-parse', 'main'], { cwd: repo }).toString().trim(),
      ).toBe(commitSha)
    })

    it('verify failure: refuses non-destructively and leaves branch intact', async () => {
      const { q, landTask } = await loadLandModules(repo)
      const { taskId, worktreePath } = await seedWorktreeAheadTask(q, repo)

      // Seed a verify gate that always fails (node is always available in the
      // test environment since we are already running under Node.js).
      await q.resolveQueueClient().execute({
        sql: `INSERT INTO verify_gates (id, scope, name, cmd, args_json, required, tier, source, created_at)
              VALUES (?, '.', 'always-fail', 'node', ?, 1, 'task', 'test', ?)`,
        args: ['gate-always-fail', JSON.stringify(['-e', 'process.exit(1)']), Date.now()],
      })

      const branchAheadBefore = Number(
        execFileSync('git', ['rev-list', '--count', 'main..HEAD'], { cwd: worktreePath })
          .toString().trim(),
      )
      expect(branchAheadBefore).toBe(1)

      const result = await landTask(taskId)

      // Must refuse.
      expect(result.outcome).toBe('verify-failed')

      // Task must NOT be done — left at failed.
      const reloaded = await q.getTask(taskId)
      expect(reloaded?.status).toBe('failed')

      // Branch must remain ahead of main (work is intact).
      const branchAheadAfter = Number(
        execFileSync('git', ['rev-list', '--count', 'main..HEAD'], { cwd: worktreePath })
          .toString().trim(),
      )
      expect(branchAheadAfter).toBe(1)

      // main must NOT have advanced.
      const mainSha = execFileSync('git', ['rev-parse', 'main'], { cwd: repo }).toString().trim()
      const branchBase = execFileSync('git', ['merge-base', `task/${taskId}`, 'main'], { cwd: repo })
        .toString().trim()
      expect(mainSha).toBe(branchBase)
    })

    it('conflict: refuses non-destructively when histories have diverged, branch intact', async () => {
      const { q, landTask } = await loadLandModules(repo)
      const { taskId, worktreePath } = await seedWorktreeAheadTask(q, repo)

      // Advance main with an independent commit so the histories diverge:
      // main = A → B,  task/xxx = A → D  (D's parent is A, not B).
      writeFileSync(resolve(repo, 'unrelated.txt'), 'unrelated advance\n')
      execFileSync('git', ['add', 'unrelated.txt'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'unrelated main advance'], { cwd: repo })

      const mainShaBeforeLand = execFileSync('git', ['rev-parse', 'main'], { cwd: repo })
        .toString().trim()
      const taskSha = headSha(worktreePath)

      const result = await landTask(taskId)

      // Must refuse with conflict.
      expect(result.outcome).toBe('conflict')

      // main must NOT have advanced.
      const mainShaAfter = execFileSync('git', ['rev-parse', 'main'], { cwd: repo })
        .toString().trim()
      expect(mainShaAfter).toBe(mainShaBeforeLand)

      // Task branch must still point at the original commit (work is intact).
      expect(headSha(worktreePath)).toBe(taskSha)
    })
  })
})
