import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
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
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-fix-tasks-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * Pre-migrated database snapshots, captured once in `beforeAll` and
 * cloned into each test's repo via `copyFileSync`. Running the full
 * `initQueue` (and actionQueue) migration set from scratch on every `it`
 * (24+ tests) used to push individual tests close to or past vitest's
 * default 5s `testTimeout` — observed as `'upsertFixTask creates a
 * queued task' timed out at 5000ms` in isolation. Hoisting the
 * migrations into a single `beforeAll` keeps the per-test cost to:
 *   - copy two small SQLite files,
 *   - vi.resetModules() (still required: the queue module holds a
 *     singleton DB client we want a fresh handle for each test),
 *   - re-enter initQueue/initActionQueue, which now short-circuits every
 *     ALTER guard and only runs idempotent CREATE INDEX IF NOT EXISTS
 *     against pre-migrated tables.
 */
let templateRepo: string

const TEMPLATE_DB_FILES = ['queue.db', 'state.db'] as const

const cloneTemplateDbs = (destRepo: string): void => {
  for (const file of TEMPLATE_DB_FILES) {
    const src = resolve(templateRepo, '.mars', file)
    if (!existsSync(src)) continue
    copyFileSync(src, resolve(destRepo, '.mars', file))
  }
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

  beforeAll(async () => {
    // Build a fully-migrated template repo once. Every per-test repo
    // copies these files instead of re-running `initQueue` and
    // `initActionQueue` from a blank DB.
    templateRepo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = templateRepo
    const q = (await import('../../queue')) as unknown as QueueModule
    await q.initQueue()
    // initActionQueue lazily seeds state.db; touch it now so the template
    // also carries the actionQueue schema for tests that exercise it.
    const actionQueue = (await import('../action-queue')) as unknown as {
      initActionQueue: typeof import('../action-queue').initActionQueue
    }
    await actionQueue.initActionQueue()
    delete process.env.MARS_REPO
    vi.resetModules()
  })

  afterAll(() => {
    rmSync(templateRepo, { recursive: true, force: true })
  })

  beforeEach(() => {
    repo = setupRepo()
    cloneTemplateDbs(repo)
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    delete process.env.MARS_MAX_FIX_ATTEMPTS
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

  it('fails source task and creates no fix task when retry_count > MARS_FIX_RETRY_BUDGET (post-recovery failure)', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '0'
    const { q, ft } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    // Simulate a prior recovery attempt having already incremented retryCount to 1.
    // With budget=0, retryCount=1 → 1 > 0 = true → mark failed (budget reached).
    const now = new Date().toISOString()
    await q.getClient().execute({
      sql: `UPDATE tasks SET retry_count = 1, updated_at = ? WHERE id = ?`,
      args: [now, t.id],
    })

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

  it('first failure with default budget (env unset) and a registered recipe spawns a fix-task, not a failed outcome', async () => {
    delete process.env.MARS_FIX_RETRY_BUDGET
    const { q, ft } = await loadModules(repo)
    // merge:preflight/uncommitted-changes is a real shared recipe built into fix-recipes.ts.
    // The classifier maps "has uncommitted changes" → merge:preflight/uncommitted-changes.
    const sig = 'merge:preflight/uncommitted-changes'
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })

    // First failure: retry_count=0, budget=0 (default). With ">": 0 > 0 = false → recipe path.
    // Regression guard for the 20-task pile-up where >= short-circuited to 'failed' on first try.
    const r = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'merge:preflight',
      errorOutput: 'merge target /repo has uncommitted changes blocking fast-forward',
    })
    expect(r.outcome).toBe('blocked')
    expect(r.fixTaskId).toBeTruthy()

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('blocked')

    const fixTasks = await q.getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ? AND failure_signature = ?`,
      args: [t.id, sig],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(1)
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
    process.env.MARS_FIX_RETRY_BUDGET = '0'
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

    // Second failure: retry_count=1 > budget=0 -> failed. The failure must
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

  it('raises a task-blocked(<id>) actionQueue row when retry budget is exhausted, deduped by task id', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '0'
    const { q, ft } = await loadModules(repo)
    const actionQueue = (await import('../action-queue')) as unknown as {
      listActionQueueItems: typeof import('../action-queue').listActionQueueItems
    }
    const t = await q.enqueueTask('merge into dirty target', undefined, {
      skipTriage: true,
    })

    const errorLine =
      'merge target /repo has uncommitted changes blocking fast-forward'

    // First failure: blocked + recovery enqueued. No actionQueue row yet.
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
    let openItems = await actionQueue.listActionQueueItems('open')
    expect(
      openItems.filter((i) => i.kind === 'failed'),
    ).toHaveLength(0)

    // Second failure: retry budget exhausted -> dropped + actionQueue raised.
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

    openItems = await actionQueue.listActionQueueItems('open')
    const taskBlocked = openItems.filter((i) =>
      i.kind === 'failed' && i.payload.taskId === t.id,
    )
    expect(taskBlocked).toHaveLength(1)
    expect(taskBlocked[0].kind).toBe('failed')
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
      raiseRetryBudgetExhaustedActionQueue: typeof import('../../queue-retry').raiseRetryBudgetExhaustedActionQueue
    }
    await retry.raiseRetryBudgetExhaustedActionQueue({
      taskId: t.id,
      lastStep: 'merge:preflight',
      retryCount: 1,
      lastErrorSignature: 'merge:preflight/uncommitted-changes',
      lastErrorSummary: errorLine,
      branch: 'task/x',
      worktreePath: null,
    })

    const openAfter = await actionQueue.listActionQueueItems('open')
    const taskBlockedAfter = openAfter.filter((i) =>
      i.kind === 'failed' && i.payload.taskId === t.id,
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

  it('escalates to actionQueue when a recovery (fix-task) itself fails — does NOT enqueue another recovery', async () => {
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
    expect(second.actionQueueItemId).toBeTruthy()

    const recoveryRow = await q.getTask(recoveryId)
    expect(recoveryRow?.status).toBe('failed')

    // The original task stays blocked — the human resolves via
    // mars continue / mars restart / mars unblock.
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

  it('no-recipe path: marks the source failed and raises an actionQueue item, WITHOUT spawning an investigator task', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    // 'verify:test/unclassified' is NOT in the registered recipe set;
    // the failure handler should NOT enqueue a recovery and should NOT
    // auto-spawn a recipe-proposing investigator.
    const r = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:test',
      errorOutput: 'something nobody has classified yet',
      branch: 'task/x',
    })
    expect(r.outcome).toBe('no-recipe')
    expect(r.failureSignature).toBe('verify:test/unclassified')
    expect(
      (r as { investigatorTaskId?: string }).investigatorTaskId,
    ).toBeUndefined()
    expect(r.actionQueueItemId).toBeTruthy()
    expect(r.fixTaskId).toBeUndefined()

    // Original task is marked failed with no task_blockers edge.
    const origin = await q.getTask(t.id)
    expect(origin?.status).toBe('failed')
    const blockers = await q.getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ?`,
      args: [t.id],
    })
    expect(Number((blockers.rows[0] as unknown as { n: number }).n)).toBe(0)

    // No investigator (or any other) task was created beyond the source.
    const all = await q.getClient().execute({
      sql: `SELECT id FROM tasks`,
      args: [],
    })
    expect(all.rows.length).toBe(1)
  })

  it('fix-fail loop: caps fix-task inserts per (sourceTaskId, failureSignature) at MARS_MAX_FIX_ATTEMPTS (default 2) and escalates to a fix-fail-loop actionQueue item', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '10'
    delete process.env.MARS_MAX_FIX_ATTEMPTS
    const { q, ft, rc } = await loadModules(repo)
    const sig = 'verify:typecheck/typecheck-cannot-find-name'
    const cleanup = registerTestRecipe(rc, sig)
    const actionQueue = (await import('../action-queue')) as unknown as {
      listActionQueueItems: typeof import('../action-queue').listActionQueueItems
      getActionQueueItem: typeof import('../action-queue').getActionQueueItem
    }
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })

    // 1st dispatch on a fresh pair: blocked + new fix task inserted.
    const r1 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    expect(r1.outcome).toBe('blocked')
    expect(r1.fixTaskId).toBeTruthy()
    // Finish the first fix task so the second dispatch is not deduped by
    // the existing-open-fix-task short-circuit.
    await q.updateTask(r1.fixTaskId!, { status: 'done' })

    // 2nd dispatch (prior attempt finished): still inserts a fix task.
    const r2 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    expect(r2.outcome).toBe('blocked')
    expect(r2.fixTaskId).toBeTruthy()
    expect(r2.fixTaskId).not.toBe(r1.fixTaskId)
    await q.updateTask(r2.fixTaskId!, { status: 'done' })

    const fixCountBefore = await q.getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ? AND failure_signature = ?`,
      args: [t.id, sig],
    })
    expect(
      Number((fixCountBefore.rows[0] as unknown as { n: number }).n),
    ).toBe(2)

    // 3rd dispatch hits the cap: no new task row, raises a fix-fail-loop
    // actionQueue item with the failure signature as its dedupe signature.
    const r3 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    expect(r3.outcome).toBe('fix-fail-loop')
    expect(r3.fixTaskId).toBeUndefined()
    expect(r3.failureSignature).toBe(sig)
    expect(r3.actionQueueItemId).toBeTruthy()

    const fixCountAfter = await q.getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ? AND failure_signature = ?`,
      args: [t.id, sig],
    })
    expect(
      Number((fixCountAfter.rows[0] as unknown as { n: number }).n),
    ).toBe(2)

    const item3 = await actionQueue.getActionQueueItem(r3.actionQueueItemId!)
    expect(item3?.kind).toBe('failed')
    expect(item3?.category).toBe('orchestrator')
    expect(item3?.priority).toBe('high')
    expect(item3?.signature).toBe(sig)
    expect(item3?.seenCount).toBe(1)
    cleanup()
  })

  it('fix-fail loop: source task remains blocked with its prior error summary on escalation; not flipped back to queued', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '10'
    delete process.env.MARS_MAX_FIX_ATTEMPTS
    const { q, ft, rc } = await loadModules(repo)
    const sig = 'verify:typecheck/typecheck-cannot-find-name'
    const cleanup = registerTestRecipe(rc, sig)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })

    const r1 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    await q.updateTask(r1.fixTaskId!, { status: 'done' })

    const r2 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    await q.updateTask(r2.fixTaskId!, { status: 'done' })

    // Capture the source task's error summary right before escalation —
    // it must survive the escalation untouched.
    const beforeEscalation = await q.getTask(t.id)
    expect(beforeEscalation?.status).toBe('blocked')
    const priorError = beforeEscalation?.error
    expect(priorError).toBeTruthy()

    // Use a different message body but still classified to the same
    // typecheck-cannot-find-name signature, so the cap check fires.
    const r3 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name BAR (later, different output)',
    })
    expect(r3.outcome).toBe('fix-fail-loop')

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('blocked')
    // The earlier error survives — the escalation must not overwrite it
    // with the latest dispatch's error summary.
    expect(reloaded?.error).toBe(priorError)
    cleanup()
  })

  it('fix-fail loop: 4th and subsequent dispatches dedupe onto the same actionQueue row and bump seenCount, no new task or actionQueue row', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '10'
    delete process.env.MARS_MAX_FIX_ATTEMPTS
    const { q, ft, rc } = await loadModules(repo)
    const sig = 'verify:typecheck/typecheck-cannot-find-name'
    const cleanup = registerTestRecipe(rc, sig)
    const actionQueue = (await import('../action-queue')) as unknown as {
      listActionQueueItems: typeof import('../action-queue').listActionQueueItems
      getActionQueueItem: typeof import('../action-queue').getActionQueueItem
    }
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })

    const r1 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    await q.updateTask(r1.fixTaskId!, { status: 'done' })
    const r2 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    await q.updateTask(r2.fixTaskId!, { status: 'done' })
    const r3 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    expect(r3.outcome).toBe('fix-fail-loop')

    const r4 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    expect(r4.outcome).toBe('fix-fail-loop')
    // Same actionQueue row, no new fix-task row.
    expect(r4.actionQueueItemId).toBe(r3.actionQueueItemId)
    expect(r4.fixTaskId).toBeUndefined()

    const r5 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    expect(r5.outcome).toBe('fix-fail-loop')
    expect(r5.actionQueueItemId).toBe(r3.actionQueueItemId)

    // No new task rows beyond the original two fix-tasks.
    const fixCount = await q.getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ? AND failure_signature = ?`,
      args: [t.id, sig],
    })
    expect(Number((fixCount.rows[0] as unknown as { n: number }).n)).toBe(2)

    // Exactly one fix-fail-loop actionQueue row exists; seenCount tracks
    // every escalation after the first (3 escalations -> seenCount 3).
    const loopItems = (await actionQueue.listActionQueueItems('open')).filter(
      (i) => i.kind === 'failed',
    )
    expect(loopItems).toHaveLength(1)
    expect(loopItems[0].id).toBe(r3.actionQueueItemId)
    expect(loopItems[0].seenCount).toBe(3)
    cleanup()
  })

  it('fix-fail loop: MARS_MAX_FIX_ATTEMPTS overrides the default cap and the helper counts attempts across all task statuses', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '10'
    process.env.MARS_MAX_FIX_ATTEMPTS = '1'
    const { q, ft, rc } = await loadModules(repo)
    const sig = 'verify:typecheck/typecheck-cannot-find-name'
    const cleanup = registerTestRecipe(rc, sig)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })

    const r1 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    expect(r1.outcome).toBe('blocked')
    expect(r1.fixTaskId).toBeTruthy()

    // Drive the fix-task into a terminal-but-non-open status. The cap
    // counter MUST still see it — it counts every historical row
    // regardless of status, not just open ones.
    await q.updateTask(r1.fixTaskId!, { status: 'failed' })

    // Helper-level check: counts across all statuses without a schema
    // change.
    const ftMod = (await import(
      '../../queue-fix-tasks'
    )) as unknown as {
      countFixTaskAttempts: typeof import('../../queue-fix-tasks').countFixTaskAttempts
      getMaxFixAttempts: typeof import('../../queue-fix-tasks').getMaxFixAttempts
    }
    expect(await ftMod.countFixTaskAttempts(t.id, sig)).toBe(1)
    expect(ftMod.getMaxFixAttempts()).toBe(1)

    const r2 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    expect(r2.outcome).toBe('fix-fail-loop')
    expect(r2.fixTaskId).toBeUndefined()
    expect(r2.actionQueueItemId).toBeTruthy()

    // The override took effect: cap=1 means the 2nd dispatch already
    // escalates, even though only one fix-task was ever inserted.
    delete process.env.MARS_MAX_FIX_ATTEMPTS
    cleanup()
  })

  it('records a self_heal_attempts row on successful fix-task enqueue with parent id, signature, fix-task id, and fresh timestamp', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, rc } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'sig-attempt')
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })

    const before = new Date().toISOString()
    const r = await ft.upsertFixTask({
      sourceTaskId: t.id,
      failureSignature: 'sig-attempt',
      failingStep: 'verify:typecheck',
      truncatedError: 'errA',
      branch: null,
      recipeContext: {
        targetPath: '/tmp/x',
        statusOutput: 'errA',
        targetBranch: '',
        originalPrompt: '',
      },
    })
    expect(r.created).toBe(true)

    const rows = await q.getClient().execute({
      sql: `SELECT parent_task_id, failure_signature, fix_task_id, created_at
              FROM self_heal_attempts
             WHERE parent_task_id = ?
               AND failure_signature = ?`,
      args: [t.id, 'sig-attempt'],
    })
    expect(rows.rows).toHaveLength(1)
    const row = rows.rows[0] as unknown as {
      parent_task_id: string
      failure_signature: string
      fix_task_id: string
      created_at: string
    }
    expect(row.parent_task_id).toBe(t.id)
    expect(row.failure_signature).toBe('sig-attempt')
    expect(row.fix_task_id).toBe(r.fixTaskId)
    expect(row.created_at >= before).toBe(true)
    cleanup()
  })

  it('does not leave a self_heal_attempts row when fix-task enqueue fails', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, rc } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'sig-fail')

    // upsertFixTask requires the source task row to exist; passing a
    // bogus id makes it throw before any row is written. Any attempt
    // row left behind would be a leak.
    await expect(
      ft.upsertFixTask({
        sourceTaskId: 'no-such-task',
        failureSignature: 'sig-fail',
        failingStep: 'verify:typecheck',
        truncatedError: 'errA',
        branch: null,
        recipeContext: {
          targetPath: '/tmp/x',
          statusOutput: 'errA',
          targetBranch: '',
          originalPrompt: '',
        },
      }),
    ).rejects.toThrow(/no-such-task/)

    const rows = await q.getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM self_heal_attempts
             WHERE failure_signature = ?`,
      args: ['sig-fail'],
    })
    expect(Number((rows.rows[0] as unknown as { n: number }).n)).toBe(0)
    cleanup()
  })

})
