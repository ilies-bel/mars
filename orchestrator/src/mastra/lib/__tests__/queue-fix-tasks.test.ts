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
  unblockTask: typeof import('../../queue').unblockTask
}

interface FixTasksModule {
  upsertFixTask: typeof import('../../queue-fix-tasks').upsertFixTask
  handleTaskFailureWithFixTask: typeof import('../../queue-fix-tasks').handleTaskFailureWithFixTask
}

interface RecipesModule {
  recipes: typeof import('../fix-recipes').recipes
}

interface BlockerModule {
  onBlockerTaskCompleted: typeof import('../../blocker-resolution').onBlockerTaskCompleted
  recoverBlockedTasks: typeof import('../../blocker-resolution').recoverBlockedTasks
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-fix-tasks-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{
  q: QueueModule
  ft: FixTasksModule
  br: BlockerModule
  rc: RecipesModule
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const ft = (await import('../../queue-fix-tasks')) as unknown as FixTasksModule
  const br = (await import(
    '../../blocker-resolution'
  )) as unknown as BlockerModule
  const rc = (await import('../fix-recipes')) as unknown as RecipesModule
  return { q, ft, br, rc }
}

/**
 * Register a synthetic recipe under `signature` for the duration of a
 * single test. Returns a teardown that deletes it. The classifier in
 * `failure-signature.ts` won't produce arbitrary test signatures, so
 * tests that need to exercise the recovery path with a custom signature
 * call this directly via `upsertFixTask` (which takes the signature
 * verbatim).
 */
const registerTestRecipe = (
  rc: RecipesModule,
  signature: string,
): (() => void) => {
  rc.recipes[signature] = {
    signature,
    title: () => `test recipe: ${signature}`,
    buildPrompt: () => `synthetic recovery prompt for ${signature}`,
  }
  return () => {
    delete rc.recipes[signature]
  }
}

describe('queue-fix-tasks', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  it('upsertFixTask creates a queued task and a task_blockers row in one transaction', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, rc } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'sig1')
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })

    const r = await ft.upsertFixTask({
      sourceTaskId: t.id,
      failureSignature: 'sig1',
      failingStep: 'verify:typecheck',
      truncatedError: 'TS2304',
      branch: 'task/x',
      recipeContext: {
        targetPath: '/tmp/x',
        statusOutput: 'TS2304',
        targetBranch: 'task/x',
        originalPrompt: '',
      },
    })
    expect(r.created).toBe(true)
    expect(r.fixTaskId).toBeTruthy()

    const fix = await q.getTask(r.fixTaskId)
    expect(fix?.status).toBe('queued')
    expect(fix?.fixForTaskId).toBe(t.id)
    expect(fix?.failureSignature).toBe('sig1')
    expect(fix?.author?.kind).toBe('agent')

    const blockers = await q.getClient().execute({
      sql: `SELECT task_id, blocker_task_id FROM task_blockers WHERE task_id = ?`,
      args: [t.id],
    })
    expect(blockers.rows).toHaveLength(1)
    expect((blockers.rows[0] as unknown as { blocker_task_id: string }).blocker_task_id).toBe(r.fixTaskId)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('blocked')
    expect(reloaded?.retryCount).toBe(1)
    cleanup()
  })

  it('idempotent: calling upsertFixTask twice with same (sourceTaskId, failureSignature) reuses the existing fix task', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, rc } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'sig-dup')
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })

    const ctx = {
      targetPath: '/tmp/x',
      statusOutput: 'errA',
      targetBranch: 'task/x',
      originalPrompt: '',
    }
    const a = await ft.upsertFixTask({
      sourceTaskId: t.id,
      failureSignature: 'sig-dup',
      failingStep: 'verify:typecheck',
      truncatedError: 'errA',
      branch: null,
      recipeContext: ctx,
    })
    const b = await ft.upsertFixTask({
      sourceTaskId: t.id,
      failureSignature: 'sig-dup',
      failingStep: 'verify:typecheck',
      truncatedError: 'errA',
      branch: null,
      recipeContext: ctx,
    })
    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    expect(b.fixTaskId).toBe(a.fixTaskId)

    const r = await q.getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ? AND failure_signature = ?`,
      args: [t.id, 'sig-dup'],
    })
    expect(Number((r.rows[0] as unknown as { n: number }).n)).toBe(1)
    cleanup()
  })

  it('handleTaskFailureWithFixTask transitions source to blocked with retry_count++ when a recipe is registered', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, rc } = await loadModules(repo)
    // The classifier maps `TS2304:` to typecheck-cannot-find-name, so
    // the produced signature is verify:typecheck/typecheck-cannot-find-name.
    const sig = 'verify:typecheck/typecheck-cannot-find-name'
    const cleanup = registerTestRecipe(rc, sig)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })

    const r = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
      branch: 'task/x',
    })
    expect(r.outcome).toBe('blocked')
    expect(r.failureSignature).toBe(sig)
    expect(r.fixTaskId).toBeTruthy()
    expect(r.retryCount).toBe(1)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('blocked')
    expect(reloaded?.retryCount).toBe(1)
    cleanup()
  })

  it('fails source task and creates no fix task when retry_count >= MARS_FIX_RETRY_BUDGET', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '0'
    const { q, ft } = await loadModules(repo)
    process.env.MARS_FIX_RETRY_BUDGET = '0'
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })

    const r = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'errA',
    })
    expect(r.outcome).toBe('failed')

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')

    const fixTasks = await q.getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [t.id],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  it('daemon trigger: when a fix task lands done, the source task it blocks transitions back to queued', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, br, rc } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'verify:typecheck/unclassified')
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    const f = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'err',
    })
    expect(f.outcome).toBe('blocked')

    // Fix task lands done.
    await q.updateTask(f.fixTaskId!, { status: 'done' })

    const result = await br.onBlockerTaskCompleted(f.fixTaskId!)
    expect(result.outcomes).toHaveLength(1)
    expect(result.outcomes[0].outcome).toBe('queued')

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
    cleanup()
  })

  it('multiple tasks blocked on the same fix task all unblock atomically', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, br, rc } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'shared')
    const t1 = await q.enqueueTask('a', undefined, { skipTriage: true })
    const t2 = await q.enqueueTask('b', undefined, { skipTriage: true })

    const f1 = await ft.upsertFixTask({
      sourceTaskId: t1.id,
      failureSignature: 'shared',
      failingStep: 'verify',
      truncatedError: 'shared err',
      branch: null,
      recipeContext: {
        targetPath: '/tmp/x',
        statusOutput: 'shared err',
        targetBranch: '',
        originalPrompt: '',
      },
    })
    // Manually wire t2 to the same fix task to simulate a shared blocker.
    const now = new Date().toISOString()
    await q.getClient().execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)`,
      args: [t2.id, f1.fixTaskId, now],
    })
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'blocked', retry_count = 1, updated_at = ? WHERE id = ?`,
      args: [now, t2.id],
    })

    await q.updateTask(f1.fixTaskId, { status: 'done' })
    const result = await br.onBlockerTaskCompleted(f1.fixTaskId)
    const queuedIds = result.outcomes
      .filter((o) => o.outcome === 'queued')
      .map((o) => o.taskId)
      .sort()
    expect(queuedIds).toEqual([t1.id, t2.id].sort())

    expect((await q.getTask(t1.id))?.status).toBe('queued')
    expect((await q.getTask(t2.id))?.status).toBe('queued')
    cleanup()
  })

  it('shared recipe: two sources hitting the same signature attach to ONE fix task with max priority', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, br, rc } = await loadModules(repo)
    rc.recipes['shared-sig'] = {
      signature: 'shared-sig',
      title: () => 'shared',
      buildPrompt: () => 'shared recovery',
      shared: true,
    }
    const t1 = await q.enqueueTask('a', undefined, { skipTriage: true })
    const t2 = await q.enqueueTask('b', undefined, { skipTriage: true })
    const ctx = {
      targetPath: '/tmp/x',
      statusOutput: 'dirty',
      targetBranch: 'main',
      originalPrompt: '',
    }
    const r1 = await ft.upsertFixTask({
      sourceTaskId: t1.id,
      failureSignature: 'shared-sig',
      failingStep: 'merge:preflight',
      truncatedError: 'dirty',
      branch: null,
      recipeContext: ctx,
    })
    const r2 = await ft.upsertFixTask({
      sourceTaskId: t2.id,
      failureSignature: 'shared-sig',
      failingStep: 'merge:preflight',
      truncatedError: 'dirty',
      branch: null,
      recipeContext: ctx,
    })
    expect(r1.created).toBe(true)
    expect(r2.created).toBe(false)
    expect(r2.fixTaskId).toBe(r1.fixTaskId)

    // Both sources are blocked on the same fix-task.
    const blockers = await q.getClient().execute({
      sql: `SELECT task_id FROM task_blockers WHERE blocker_task_id = ? ORDER BY task_id`,
      args: [r1.fixTaskId],
    })
    expect(blockers.rows).toHaveLength(2)

    // Fix task runs at max priority so it preempts other queued work.
    const fix = await q.getTask(r1.fixTaskId)
    expect(fix?.priority).toBe(3)

    // Completing the shared fix flips both sources back to queued.
    await q.updateTask(r1.fixTaskId, { status: 'done' })
    const result = await br.onBlockerTaskCompleted(r1.fixTaskId)
    const queuedIds = result.outcomes
      .filter((o) => o.outcome === 'queued')
      .map((o) => o.taskId)
      .sort()
    expect(queuedIds).toEqual([t1.id, t2.id].sort())
    delete rc.recipes['shared-sig']
  })

  it('fails dependent task at unblock time when retry budget already exhausted', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '1'
    const { q, ft, br, rc } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'verify:typecheck/unclassified')
    const t = await q.enqueueTask('a', undefined, { skipTriage: true })
    const f = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'err',
    })
    expect(f.outcome).toBe('blocked')
    expect(f.retryCount).toBe(1)

    await q.updateTask(f.fixTaskId!, { status: 'done' })
    const result = await br.onBlockerTaskCompleted(f.fixTaskId!)
    expect(result.outcomes).toHaveLength(1)
    expect(result.outcomes[0].outcome).toBe('failed')

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failureReason).toBe('retry_budget_exhausted_at_unblock')
    cleanup()
  })

  it('drop on retry-budget exhausted removes all task_blockers rows for the task', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '1'
    const { q, ft } = await loadModules(repo)
    const t = await q.enqueueTask('merge into dirty target', undefined, {
      skipTriage: true,
    })

    // First failure: classifier maps "merge target ... has uncommitted
    // changes" to merge:preflight/uncommitted-changes (a registered
    // recipe). Bumps retry_count to 1, transitions to blocked, inserts
    // a task_blockers row pointing at the new fix-task.
    const errorLine =
      'merge target /repo has uncommitted changes blocking fast-forward'
    const first = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'merge:preflight',
      errorOutput: errorLine,
      branch: 'task/x',
      recipeContext: {
        targetPath: '/repo',
        statusOutput: '?? leftover.txt',
        targetBranch: 'main',
        originalPrompt: '',
      },
    })
    expect(first.outcome).toBe('blocked')
    let reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('blocked')

    // Second failure: retry_count=1 >= budget=1 -> dropped. The drop must
    // remove every task_blockers row pointing from this task.
    const second = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'merge:preflight',
      errorOutput: errorLine,
      branch: 'task/x',
      recipeContext: {
        targetPath: '/repo',
        statusOutput: '?? leftover.txt',
        targetBranch: 'main',
        originalPrompt: '',
      },
    })
    expect(second.outcome).toBe('failed')

    reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failureReason).toBe(
      'retry_budget_exhausted:merge:preflight/uncommitted-changes',
    )
    expect(reloaded?.dropReason).toBeNull()

    const remainingBlockers = await q.getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ?`,
      args: [t.id],
    })
    expect(
      Number((remainingBlockers.rows[0] as unknown as { n: number }).n),
    ).toBe(0)
  })

  it('raises a task-blocked(<id>) inbox row when retry budget is exhausted, deduped by task id', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '1'
    const { q, ft } = await loadModules(repo)
    const inbox = (await import('../inbox')) as unknown as {
      listInboxItems: typeof import('../inbox').listInboxItems
    }
    const t = await q.enqueueTask('merge into dirty target', undefined, {
      skipTriage: true,
    })

    const errorLine =
      'merge target /repo has uncommitted changes blocking fast-forward'

    // First failure: blocked + recovery enqueued. No inbox row yet.
    const first = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'merge:preflight',
      errorOutput: errorLine,
      branch: 'task/x',
      recipeContext: {
        targetPath: '/repo',
        statusOutput: '?? leftover.txt',
        targetBranch: 'main',
        originalPrompt: '',
      },
    })
    expect(first.outcome).toBe('blocked')
    let openItems = await inbox.listInboxItems('open')
    expect(
      openItems.filter((i) => i.kind.startsWith('task-blocked(')),
    ).toHaveLength(0)

    // Second failure: retry budget exhausted -> dropped + inbox raised.
    const second = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'merge:preflight',
      errorOutput: errorLine,
      branch: 'task/x',
      recipeContext: {
        targetPath: '/repo',
        statusOutput: '?? leftover.txt',
        targetBranch: 'main',
        originalPrompt: '',
      },
    })
    expect(second.outcome).toBe('failed')

    openItems = await inbox.listInboxItems('open')
    const taskBlocked = openItems.filter((i) =>
      i.kind.startsWith('task-blocked('),
    )
    expect(taskBlocked).toHaveLength(1)
    expect(taskBlocked[0].kind).toBe(`task-blocked(${t.id})`)
    expect(taskBlocked[0].signature).toBe(t.id)
    expect(taskBlocked[0].priority).toBe('high')
    expect(taskBlocked[0].raisedBy).toBe('orchestrator:retry-budget')
    expect(taskBlocked[0].seenCount).toBe(1)
    expect(taskBlocked[0].payload.taskId).toBe(t.id)
    expect(taskBlocked[0].payload.lastStep).toBe('merge:preflight')
    expect(taskBlocked[0].payload.lastErrorSignature).toBe(
      'merge:preflight/uncommitted-changes',
    )

    // Re-trigger the exhaustion path on the same task: row must dedup
    // (seen_count bumps, NOT a second row).
    // markTaskFailed already removed the task_blockers; re-call the
    // helper directly to simulate the same exhaustion firing again.
    const retry = (await import('../../queue-retry')) as unknown as {
      raiseRetryBudgetExhaustedInbox: typeof import('../../queue-retry').raiseRetryBudgetExhaustedInbox
    }
    await retry.raiseRetryBudgetExhaustedInbox({
      taskId: t.id,
      lastStep: 'merge:preflight',
      retryCount: 1,
      lastErrorSignature: 'merge:preflight/uncommitted-changes',
      lastErrorSummary: errorLine,
      branch: 'task/x',
      worktreePath: null,
    })

    const openAfter = await inbox.listInboxItems('open')
    const taskBlockedAfter = openAfter.filter((i) =>
      i.kind.startsWith('task-blocked('),
    )
    expect(taskBlockedAfter).toHaveLength(1)
    expect(taskBlockedAfter[0].seenCount).toBe(2)
  })

  it('unblockTask flips a blocked task to failed and clears task_blockers rows', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, rc } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'verify/unclassified')
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    const f = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify',
      errorOutput: 'err',
    })
    expect(f.outcome).toBe('blocked')

    const r = await q.unblockTask(t.id)
    expect(r.outcome).toBe('unblocked')
    expect(r.previousStatus).toBe('blocked')

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')

    const remaining = await q.getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ?`,
      args: [t.id],
    })
    expect(Number((remaining.rows[0] as unknown as { n: number }).n)).toBe(0)
    cleanup()
  })

  it('unblockTask flips a queued task to failed (so it can be purged before dispatch)', async () => {
    const { q } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    expect(t.status).toBe('queued')

    const r = await q.unblockTask(t.id)
    expect(r.outcome).toBe('unblocked')
    expect(r.previousStatus).toBe('queued')

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')
  })

  it('unblockTask is a no-op for tasks that are not queued or blocked', async () => {
    const { q } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    // Force a terminal status that unblock should refuse to touch.
    await q.updateTask(t.id, { status: 'done' })

    const r = await q.unblockTask(t.id)
    expect(r.outcome).toBe('noop')
    expect(r.previousStatus).toBe('done')

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('done')
  })

  it('escalates to inbox when a recovery (fix-task) itself fails — does NOT enqueue another recovery', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, rc } = await loadModules(repo)
    // Register a recipe so the FIRST failure produces a recovery row.
    const cleanup = registerTestRecipe(rc, 'verify:typecheck/unclassified')
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    const first = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'err',
    })
    expect(first.outcome).toBe('blocked')
    const recoveryId = first.fixTaskId!
    expect(recoveryId).toBeTruthy()

    // Now simulate the recovery itself failing. Without the
    // recovery-escalation branch this would enqueue a fix-of-fix
    // (the cascade pattern).
    const second = await ft.handleTaskFailureWithFixTask({
      taskId: recoveryId,
      failingStep: 'verify:typecheck',
      errorOutput: 'err',
    })
    expect(second.outcome).toBe('escalated')
    expect(second.fixTaskId).toBeUndefined()
    expect(second.inboxItemId).toBeTruthy()

    const recoveryRow = await q.getTask(recoveryId)
    expect(recoveryRow?.status).toBe('failed')

    // The original task stays blocked — the human resolves via
    // mars retry / mars unblock.
    const origin = await q.getTask(t.id)
    expect(origin?.status).toBe('blocked')

    // No new fix-task was enqueued for the failed recovery.
    const descendants = await q.getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [recoveryId],
    })
    expect(Number((descendants.rows[0] as unknown as { n: number }).n)).toBe(
      0,
    )
    cleanup()
  })

  it('no-recipe path: spawns an investigator task and raises a no-recipe inbox item; original stays blocked', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    // 'verify:test/unclassified' is NOT in the registered recipe set;
    // the failure handler should NOT enqueue a recovery.
    const r = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:test',
      errorOutput: 'something nobody has classified yet',
      branch: 'task/x',
    })
    expect(r.outcome).toBe('no-recipe')
    expect(r.failureSignature).toBe('verify:test/unclassified')
    expect(r.investigatorTaskId).toBeTruthy()
    expect(r.inboxItemId).toBeTruthy()
    expect(r.fixTaskId).toBeUndefined()

    // Original task is blocked but has NO task_blockers row pointing
    // at the investigator (investigator does not unblock the source).
    const origin = await q.getTask(t.id)
    expect(origin?.status).toBe('blocked')
    const blockers = await q.getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ?`,
      args: [t.id],
    })
    expect(Number((blockers.rows[0] as unknown as { n: number }).n)).toBe(0)

    // Investigator exists, is queued, and references the same origin.
    const inv = await q.getTask(r.investigatorTaskId!)
    expect(inv?.status).toBe('queued')
    expect(inv?.fixForTaskId).toBeNull()
    expect(inv?.originId).toBe(origin?.originId)
    expect(inv?.author?.name).toBe('agent:investigator')
    expect(inv?.prompt).toContain('Investigator task')
    expect(inv?.prompt).toContain('verify:test/unclassified')
  })

  it('investigator prompt follows the diagnose discipline (feedback-loop first, ranked falsifiable hypotheses, [DEBUG-] tags, "no recipe is the right answer" framing)', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    const r = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:test',
      errorOutput: 'something nobody has classified yet',
      branch: 'task/x',
    })
    expect(r.outcome).toBe('no-recipe')
    expect(r.investigatorTaskId).toBeTruthy()

    const inv = await q.getTask(r.investigatorTaskId!)
    expect(inv).not.toBeNull()
    const prompt = inv!.prompt

    // Feedback-loop-first discipline.
    expect(prompt.toLowerCase()).toContain('feedback loop')
    // Ranked hypotheses (covers "ranked" + "hypothes" stems).
    expect(prompt).toMatch(/ranked/i)
    expect(prompt).toMatch(/hypothes/i)
    // Falsifiable framing.
    expect(prompt).toMatch(/falsifiab/i)
    // Tagged debug logs with the specific prefix shape.
    expect(prompt).toContain('[DEBUG-')
    // "No recipe is the right answer" is named as a first-class outcome.
    expect(prompt).toContain('no recipe is the right answer')
    // Concrete examples for outcome (b).
    expect(prompt.toLowerCase()).toMatch(/flaky|credential|api key|underspecified/)
    // Phase-6 grep-and-remove step + verify-gate forward reference.
    expect(prompt.toLowerCase()).toContain('grep')
    expect(prompt.toLowerCase()).toMatch(/verify step.*reject|reject.*\[debug-/i)
    // Commit-message-carries-the-hypothesis requirement.
    expect(prompt.toLowerCase()).toMatch(/commit message/)
    // Existing boundaries / ADR reference / save-your-work closing preserved.
    expect(prompt).toContain('docs/adr/0002-recipe-per-failure-signature.md')
    expect(prompt).toContain('Save your work')
    expect(prompt).toMatch(/vitest test/i)
    expect(prompt).toMatch(/catch-all/i)
  })

  it('recoverBlockedTasks unblocks tasks whose blocker task was already done', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, br, rc } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'verify/unclassified')
    const t = await q.enqueueTask('a', undefined, { skipTriage: true })
    const f = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify',
      errorOutput: 'err',
    })

    // Fix task lands done while daemon was down (no unblock event ran).
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?`,
      args: [new Date().toISOString(), f.fixTaskId!],
    })

    const recovered = await br.recoverBlockedTasks()
    expect(recovered).toHaveLength(1)
    expect(recovered[0].outcomes[0].outcome).toBe('queued')

    expect((await q.getTask(t.id))?.status).toBe('queued')
    cleanup()
  })
})
