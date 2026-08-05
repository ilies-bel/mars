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
  listTasks: typeof import('../../queue').listTasks
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
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
  onBlockerTaskCompleted: typeof import('../../arc').Arc['unblockByCompletion']
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
 * `migrateQueueSchema` (and actionQueue) migration set from scratch on every `it`
 * (24+ tests) used to push individual tests close to or past vitest's
 * default 5s `testTimeout` — observed as `'upsertFixTask creates a
 * queued task' timed out at 5000ms` in isolation. Hoisting the
 * migrations into a single `beforeAll` keeps the per-test cost to:
 *   - copy two small SQLite files,
 *   - vi.resetModules() (still required: the queue module holds a
 *     singleton DB client we want a fresh handle for each test),
 *   - re-enter migrateQueueSchema/initActionQueue, which now short-circuits every
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
  // Close all open PGlite connections before resetting modules so WASM memory
  // is freed rather than orphaned. Without this, 34+ in-memory PGlite instances
  // accumulate across the suite and exhaust the WASM heap (RuntimeError: Aborted).
  try {
    const { closeAllDbs } = await import('../db')
    await closeAllDbs()
  } catch {
    // Non-fatal: first invocation or already-crashed instance.
  }
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const ft = (await import('../../queue-fix-tasks')) as unknown as FixTasksModule
  const { Arc } = await import('../../arc')
  const br: BlockerModule = {
    onBlockerTaskCompleted: (id) => Arc.unblockByCompletion(id),
  }
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
    // copies these files instead of re-running `migrateQueueSchema` and
    // `initActionQueue` from a blank DB.
    templateRepo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = templateRepo
    const q = (await import('../../queue')) as unknown as QueueModule
    await q.migrateQueueSchema()
    // initActionQueue lazily seeds state.db; touch it now so the template
    // also carries the actionQueue schema for tests that exercise it.
    const actionQueue = (await import('../action-queue')) as unknown as {
      initActionQueue: typeof import('../action-queue').initActionQueue
    }
    await actionQueue.initActionQueue()
    delete process.env.MARS_REPO
    // Free the template PGlite WASM memory before resetting modules so it
    // does not become an orphaned allocation that adds to suite-wide pressure.
    const { closeAllDbs } = await import('../db')
    await closeAllDbs()
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
    delete process.env.MARS_SIGNATURE_STORM_THRESHOLD
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
    expect(r.fixTaskId).toMatch(/^fix-[0-9a-f]{8}$/)
    expect(r.fixTaskId).toBeTruthy()

    const fix = await q.getTask(r.fixTaskId)
    expect(fix?.status).toBe('queued')
    // Non-shared recovery tasks run at MAX_PRIORITY (3) so they preempt fresh
    // queued tasks and resume already-started work ahead of new work.
    expect(fix?.priority).toBe(3)
    expect(fix?.fixForTaskId).toBe(t.id)
    expect(fix?.failureSignature).toBe('sig1')
    expect(fix?.author?.kind).toBe('agent')

    const blockers = await q.resolveQueueClient().execute({
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

    const r = await q.resolveQueueClient().execute({
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

  it('dispatches exactly one recovery when an origin has already failed verification', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, rc } = await loadModules(repo)
    const sig = 'verify:typecheck/typecheck-cannot-find-name'
    const cleanup = registerTestRecipe(rc, sig)
    const origin = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    const worktreePath = resolve(repo, '.mars', 'worktrees', origin.id)
    mkdirSync(worktreePath, { recursive: true })

    await q.updateTask(origin.id, {
      status: 'failed',
      branch: 'task/failed-origin',
      worktreePath,
      failedPhase: 'verify',
      failureReason: 'verify:typecheck',
      failureSignature: sig,
      failureReasonCode: sig,
      error: 'TS2304: cannot find name foo',
    })

    const first = await ft.handleTaskFailureWithFixTask({
      taskId: origin.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
      branch: 'task/failed-origin',
    })
    const second = await ft.handleTaskFailureWithFixTask({
      taskId: origin.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
      branch: 'task/failed-origin',
    })

    expect(first.outcome).toBe('blocked')
    expect(second.outcome).toBe('noop')
    expect((await q.getTask(origin.id))?.status).toBe('blocked')
    expect(
      (await q.listTasks()).filter((task) => task.fixForTaskId === origin.id),
    ).toHaveLength(1)
    cleanup()
  })

  it('fails source task and creates no fix task when retry_count > MARS_FIX_RETRY_BUDGET (post-recovery failure)', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '0'
    const { q, ft } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    // Simulate a prior recovery attempt having already incremented retryCount to 1.
    // With budget=0, retryCount=1 → 1 > 0 = true → mark failed (budget reached).
    const now = new Date().toISOString()
    await q.resolveQueueClient().execute({
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

    const fixTasks = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [t.id],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  it('duplicate task.failed for a blocked origin does not mark origin failed or raise a recovery-exhausted alert', async () => {
    // Regression for incident mars-c37f2cbb (2026-07-19): a second task.failed
    // event for the same origin while its fix task was still queued triggered
    // the retryCount > budget exhaustion branch, marked the origin terminal
    // `failed`, and raised a false recovery-exhausted action-queue row —
    // all while the fix task was still pending and had never run.
    process.env.MARS_FIX_RETRY_BUDGET = '0' // budget=0; retryCount=1 after first fix → 1>0 = true (exhaustion) without the guard
    const { q, ft, rc } = await loadModules(repo)
    const sig = 'verify:typecheck/typecheck-cannot-find-name'
    const cleanup = registerTestRecipe(rc, sig)
    const actionQueue = (await import('../action-queue')) as unknown as {
      listActionQueueItems: typeof import('../action-queue').listActionQueueItems
    }
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })

    // First failure: spawns fix task, transitions origin to blocked, retryCount→1.
    const r1 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
      branch: 'task/x',
    })
    expect(r1.outcome).toBe('blocked')
    expect(r1.fixTaskId).toBeTruthy()

    const afterFirst = await q.getTask(t.id)
    expect(afterFirst?.status).toBe('blocked')
    expect(afterFirst?.retryCount).toBe(1)

    // Second (duplicate) task.failed for the SAME origin while fix is still
    // queued. Without the guard, retryCount=1 > budget=0 fires exhaustion.
    const r2 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
      branch: 'task/x',
    })
    expect(r2.outcome).toBe('noop')

    // Origin must remain blocked — NOT failed.
    const afterDuplicate = await q.getTask(t.id)
    expect(afterDuplicate?.status).toBe('blocked')
    expect(afterDuplicate?.retryCount).toBe(1)

    // No additional fix task was spawned for the duplicate event.
    const fixTasks = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ? AND failure_signature = ?`,
      args: [t.id, sig],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(1)

    // No recovery-exhausted (kind='failed') action-queue row raised.
    const open = await actionQueue.listActionQueueItems('open')
    const exhaustedRows = open.filter(
      (i) => i.kind === 'failed' && i.signature === t.id,
    )
    expect(exhaustedRows).toHaveLength(0)

    cleanup()
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

    const fixTasks = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ? AND failure_signature = ?`,
      args: [t.id, sig],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(1)
  })

  it('daemon trigger: when a fix task lands done, the source task it blocks transitions to done via propagateRecoveryDone', async () => {
    // mars-f2034bb9: a recovery completing its origin's work must flip the
    // origin to 'done' (not re-queue it). unblockByCompletion now detects the
    // own-recovery edge and routes through propagateRecoveryDone.
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

    // Fix task lands done (recovery succeeded — it ran and merged the work).
    await q.updateTask(f.fixTaskId!, { status: 'done' })

    const result = await br.onBlockerTaskCompleted(f.fixTaskId!)
    expect(result.outcomes).toHaveLength(1)
    // Own-recovery path: outcome is 'done-via-recovery', not 'queued'.
    expect(result.outcomes[0].outcome).toBe('done-via-recovery')

    const reloaded = await q.getTask(t.id)
    // Origin is done — the recovery delivered its work.
    expect(reloaded?.status).toBe('done')
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
    // Two different time encodings are in play: `task_blockers.created_at` is
    // a bigint of epoch millis, while `tasks.updated_at` is a timestamptz that
    // takes the ISO form. One `now` cannot serve both.
    const now = new Date().toISOString()
    const nowMs = Date.now()
    await q.resolveQueueClient().execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)`,
      args: [t2.id, f1.fixTaskId, nowMs],
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked', retry_count = 1, updated_at = ? WHERE id = ?`,
      args: [now, t2.id],
    })

    await q.updateTask(f1.fixTaskId, { status: 'done' })
    const result = await br.onBlockerTaskCompleted(f1.fixTaskId)

    // mars-f2034bb9: t1 is the fix task's own origin (fixForTaskId=t1.id) →
    // propagateRecoveryDone flips it to 'done', not 'queued'.
    // t2 is a piggybacking dependent (fixForTaskId≠t2.id) → normal re-queue.
    const doneViaRecovery = result.outcomes.filter((o) => o.outcome === 'done-via-recovery')
    const queued = result.outcomes.filter((o) => o.outcome === 'queued')
    expect(doneViaRecovery.map((o) => o.taskId)).toEqual([t1.id])
    expect(queued.map((o) => o.taskId)).toEqual([t2.id])

    expect((await q.getTask(t1.id))?.status).toBe('done')
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
    const blockers = await q.resolveQueueClient().execute({
      sql: `SELECT task_id FROM task_blockers WHERE blocker_task_id = ? ORDER BY task_id`,
      args: [r1.fixTaskId],
    })
    expect(blockers.rows).toHaveLength(2)

    // Fix task runs at max priority so it preempts other queued work.
    const fix = await q.getTask(r1.fixTaskId)
    expect(fix?.priority).toBe(3)

    // Completing the shared fix: t1 is the fix's own origin → done via recovery;
    // t2 is a piggybacker → re-queued to retry on the fixed codebase.
    // (mars-f2034bb9: unblockByCompletion now detects own-recovery edges.)
    await q.updateTask(r1.fixTaskId, { status: 'done' })
    const result = await br.onBlockerTaskCompleted(r1.fixTaskId)
    const doneViaRecovery = result.outcomes.filter((o) => o.outcome === 'done-via-recovery')
    const queued = result.outcomes.filter((o) => o.outcome === 'queued')
    expect(doneViaRecovery.map((o) => o.taskId)).toEqual([t1.id])
    expect(queued.map((o) => o.taskId)).toEqual([t2.id])
    delete rc.recipes['shared-sig']
  })

  it('reconciles origin to done when its recovery task reaches done (propagateRecoveryDone)', async () => {
    // The retry-budget silent-fail gate was removed (mars-3d63fe52), so a
    // retry_count=1 origin is never failed at unblock. A successful recovery
    // counts as its origin reaching done (CLAUDE.md one-recovery contract);
    // reconciliation is driven by propagateRecoveryDone, exactly as the daemon
    // does when a fix task lands done.
    const { q, ft, rc } = await loadModules(repo)
    const { Arc } = await import('../../arc')
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
    const propagation = await Arc.load(t.id).propagateRecoveryDone()
    expect(propagation.originFlipped).toBe(true)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('done')
    expect(reloaded?.failureReason).toBeFalsy()
    cleanup()
  })

  it('reconciles origin to done and unblocks dependents when its recovery reaches done (default budget path)', async () => {
    // Reproduces the observed incident shape (mars-63196f8e) under the NEW
    // contract: one failure → retryCount=1, but the retry-budget silent-fail
    // gate is gone (mars-3d63fe52), so the origin is never failed with
    // recovery_exhausted_at_unblock. When its recovery reaches done, the origin
    // is reconciled to done via propagateRecoveryDone and downstream tasks
    // blocked on the origin are released to queued via the cascade.
    const { q, ft, rc } = await loadModules(repo)
    const { Arc } = await import('../../arc')
    const cleanup = registerTestRecipe(rc, 'verify:typecheck/unclassified')

    const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })

    // A downstream task blocked on the origin — should be unblocked when the
    // origin reaches done through propagateRecoveryDone.
    const downstream = await q.enqueueTask('downstream', undefined, { skipTriage: true })
    // `task_blockers.created_at` is a bigint of epoch millis, not a timestamp.
    await q.resolveQueueClient().execute({
      sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', ?)`,
      args: [downstream.id, origin.id, Date.now()],
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [downstream.id],
    })

    // Fail origin once — retryCount becomes 1, fix task spawned.
    const f = await ft.handleTaskFailureWithFixTask({
      taskId: origin.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'err',
    })
    expect(f.outcome).toBe('blocked')
    expect(f.retryCount).toBe(1)

    // Recovery fix task completes; the daemon calls propagateRecoveryDone.
    await q.updateTask(f.fixTaskId!, { status: 'done' })
    const propagation = await Arc.load(origin.id).propagateRecoveryDone()
    expect(propagation.originFlipped).toBe(true)

    // Origin is reconciled to done (NOT failed with recovery_exhausted_at_unblock).
    const reloadedOrigin = await q.getTask(origin.id)
    expect(reloadedOrigin?.status).toBe('done')
    expect(reloadedOrigin?.failureReason).toBeFalsy()

    // Downstream task is unblocked because origin reached done.
    const reloadedDownstream = await q.getTask(downstream.id)
    expect(reloadedDownstream?.status).toBe('queued')

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

    // Simulate the fix task completing (terminal = not outstanding).
    // Without this, a second task.failed for the same origin would be treated
    // as a duplicate in-flight event and return 'noop' (the bug-fix guard).
    // Here we specifically test the post-recovery-completion exhaustion path.
    await q.updateTask(first.fixTaskId!, { status: 'done' })

    // Second failure: no outstanding fix, retry_count=1 > budget=0 -> failed.
    // The failure must remove every task_blockers row pointing from this task.
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
      'recovery_exhausted:merge:preflight/uncommitted-changes',
    )
    expect(reloaded?.dropReason).toBeNull()

    const remainingBlockers = await q.resolveQueueClient().execute({
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

    // Simulate the fix task completing (terminal = not outstanding) so the
    // second call is treated as a post-recovery re-failure, not a duplicate
    // in-flight event.
    await q.updateTask(first.fixTaskId!, { status: 'done' })

    // Second failure: no outstanding fix, retry budget exhausted -> failed + actionQueue raised.
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
    expect(taskBlocked[0].raisedBy).toBe('orchestrator:recovery-exhausted')
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
      raiseRecoveryExhaustedActionQueue: typeof import('../../queue-retry').raiseRecoveryExhaustedActionQueue
    }
    await retry.raiseRecoveryExhaustedActionQueue({
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

    const remaining = await q.resolveQueueClient().execute({
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
    const descendants = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [recoveryId],
    })
    expect(Number((descendants.rows[0] as unknown as { n: number }).n)).toBe(
      0,
    )
    cleanup()
  })

  it('re-driving an already-escalated recovery task is a no-op: the recovery_failed: prefix is never nested', async () => {
    // Regression (fix-139f327c, 2026-07-31): the recovery-spawner drain re-drove
    // already-terminal recovery rows every 30 s. Each pass re-entered this
    // handler with the PREVIOUS composed reason (the escalation wrote it to
    // `error`, and the `task.failed` event carries `error`) and prepended
    // another `recovery_failed:<sig>: `. Ten passes later `failure_reason` was
    // ten prefixes deep, and — worse — `error` had been overwritten with the
    // same padding, destroying the captured process output the storm Steward
    // brief reads. A recovery Chore is a leaf (ADR-0040): its failure escalates
    // exactly once, the row is terminal, and `error` is never a derived string.
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, rc } = await loadModules(repo)
    const actionQueue = (await import('../action-queue')) as unknown as {
      listActionQueueItems: typeof import('../action-queue').listActionQueueItems
    }
    const signature = 'verify:typecheck/test-assertion-error'
    const cleanup = registerTestRecipe(rc, signature)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })

    // Captured process output, the way a real verify failure arrives.
    const capturedOutput = [
      'FAIL src/thing.test.ts > does the thing',
      'AssertionError: expected 2 to be 1',
      ' ❯ src/thing.test.ts:41:7',
    ].join('\n')

    const first = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: capturedOutput,
    })
    const recoveryId = first.fixTaskId!
    expect(recoveryId).toBeTruthy()

    // The recovery itself fails: one escalation, one prefix.
    const escalated = await ft.handleTaskFailureWithFixTask({
      taskId: recoveryId,
      failingStep: 'verify:typecheck',
      errorOutput: capturedOutput,
    })
    expect(escalated.outcome).toBe('escalated')

    const afterFirst = await q.getTask(recoveryId)
    expect(afterFirst?.failureReason).toBe(
      `recovery_failed:${signature}: ${capturedOutput}`,
    )
    // `error` keeps the captured output verbatim — it is NOT the derived string.
    expect(afterFirst?.error).toBe(capturedOutput)

    // The sweep re-drives the terminal row, feeding the composed reason back in
    // exactly as the `task.failed` event did.
    const redriven = await ft.handleTaskFailureWithFixTask({
      taskId: recoveryId,
      failingStep: 'verify:typecheck',
      errorOutput: afterFirst!.failureReason!,
    })
    expect(redriven.outcome).toBe('escalated')

    const afterRedrive = await q.getTask(recoveryId)
    // Exactly one prefix, and the original error survives verbatim.
    expect(
      afterRedrive?.failureReason?.match(/recovery_failed:/g)?.length,
    ).toBe(1)
    expect(afterRedrive?.failureReason).toBe(afterFirst?.failureReason)
    expect(afterRedrive?.failureReason).toContain('AssertionError')
    expect(afterRedrive?.error).toBe(capturedOutput)
    expect(afterRedrive?.status).toBe('failed')

    // The re-drive raised no second escalation and did not re-stamp the
    // existing row (seenCount stays at its first-raise value).
    const openItems = await actionQueue.listActionQueueItems('open')
    const escalations = openItems.filter(
      (item) =>
        item.kind === 'failed' &&
        (item.payload as { recoveryTaskId?: string }).recoveryTaskId ===
          recoveryId,
    )
    expect(escalations).toHaveLength(1)
    expect(escalations[0]?.seenCount).toBe(1)

    // And still no fix-of-fix.
    const descendants = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [recoveryId],
    })
    expect(Number((descendants.rows[0] as unknown as { n: number }).n)).toBe(0)
    cleanup()
  })

  it('trips the signature storm breaker for repeated recovery failures and replaces later per-origin escalations with one storm', async () => {
    process.env.MARS_SIGNATURE_STORM_THRESHOLD = '3'
    const { q, ft, rc } = await loadModules(repo)
    const actionQueue = (await import('../action-queue')) as unknown as {
      listActionQueueItems: typeof import('../action-queue').listActionQueueItems
    }
    const cleanup = registerTestRecipe(rc, 'recovery-seed')
    const signature = 'setup:origin-worktree-missing/unclassified'
    const errorOutput = 'origin worktree is missing before setup can run'

    const failRecovery = async (index: number) => {
      const origin = await q.enqueueTask(`origin ${index}`, undefined, { skipTriage: true })
      const recovery = await ft.upsertFixTask({
        sourceTaskId: origin.id,
        failureSignature: 'recovery-seed',
        failingStep: 'setup',
        truncatedError: errorOutput,
        branch: `task/${origin.id}`,
        recipeContext: {
          targetPath: '/tmp/mars-storm',
          statusOutput: errorOutput,
          targetBranch: `task/${origin.id}`,
          originalPrompt: origin.prompt,
        },
      })
      return ft.handleTaskFailureWithFixTask({
        taskId: recovery.fixTaskId,
        failingStep: 'setup:origin-worktree-missing',
        errorOutput,
      })
    }

    expect((await failRecovery(1)).outcome).toBe('escalated')
    expect((await failRecovery(2)).outcome).toBe('escalated')

    const tripping = await failRecovery(3)
    expect(tripping.outcome).toBe('signature-storm-tripped')
    expect(tripping.failureSignature).toBe(signature)
    expect(tripping.stormStreak).toBe(3)

    expect((await failRecovery(4)).outcome).toBe('escalated')

    const openItems = await actionQueue.listActionQueueItems('open')
    const stormItems = openItems.filter((item) => item.kind === 'signature-storm')
    const recoveryEscalations = openItems.filter(
      (item) =>
        item.kind === 'failed' &&
        (item.payload as { failureSignature?: string }).failureSignature === signature,
    )
    expect(stormItems).toHaveLength(1)
    expect(recoveryEscalations).toHaveLength(2)
    cleanup()
  })

  it('recovery escalation title is single-line and under 100 chars when failingStep is a multi-line error with an absolute path', async () => {
    // Regression for the live DB pattern where 53 chat threads had a 300+
    // character title containing the full workflow file error and an absolute
    // filesystem path. The fix: (1) replace raw failingStep with a step-family
    // label (failure-kinds.ts invariant), (2) enforce a hard 100-char cap.
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, rc } = await loadModules(repo)
    const actionQueue = (await import('../action-queue')) as unknown as {
      getActionQueueItem: typeof import('../action-queue').getActionQueueItem
    }
    const cleanup = registerTestRecipe(rc, 'verify:typecheck/unclassified')
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    const first = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'err',
    })
    const recoveryId = first.fixTaskId!

    // The multi-line, path-carrying failingStep that produced 300+ char titles
    // in the live DB (verbatim from the incident).
    const multiLineFailingStep = [
      'workflow file /Users/ib472e5l/project/perso/mars-framework/.mars/workflows/fix-workflow.js',
      'failed to load: No "exports" main defined in',
      '/Users/ib472e5l/project/perso/mars-framework/orchestrator/node_modules/@mars/workflow/package.json.',
      'No fallback pipeline is substituted — fix the file and re-dispatch',
      "(check it with 'mars workflow validate fix').",
    ].join('\n')

    const second = await ft.handleTaskFailureWithFixTask({
      taskId: recoveryId,
      failingStep: multiLineFailingStep,
      errorOutput: 'workflow file failed to load',
    })
    expect(second.outcome).toBe('escalated')
    expect(second.actionQueueItemId).toBeTruthy()

    const item = await actionQueue.getActionQueueItem(second.actionQueueItemId!)
    expect(item).not.toBeNull()

    // Title must be single-line (no newlines).
    expect(item!.title).not.toContain('\n')

    // Title must be under the 100-char cap.
    expect(item!.title.length).toBeLessThanOrEqual(100)

    // Title must not contain absolute filesystem paths.
    expect(item!.title).not.toContain('/Users/')

    // The raw failingStep must still reach the body (where technical detail
    // belongs) so the operator can investigate.
    expect(item!.body).toContain('fix-workflow.js')

    cleanup()
  })

  it('recovery escalation title uses a plain-English step-family label, not the raw failingStep id', async () => {
    // The title should say "recovery failed during a verification check"
    // not "recovery failed at verify:typecheck" (raw step id in user-facing title
    // violates the failure-kinds.ts invariant documented at line 611-613).
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, rc } = await loadModules(repo)
    const actionQueue = (await import('../action-queue')) as unknown as {
      getActionQueueItem: typeof import('../action-queue').getActionQueueItem
    }
    const cleanup = registerTestRecipe(rc, 'verify:typecheck/unclassified')
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    const first = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'err',
    })
    const recoveryId = first.fixTaskId!

    const second = await ft.handleTaskFailureWithFixTask({
      taskId: recoveryId,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    expect(second.outcome).toBe('escalated')

    const item = await actionQueue.getActionQueueItem(second.actionQueueItemId!)
    expect(item).not.toBeNull()

    // Raw step id must NOT appear in the title.
    expect(item!.title).not.toContain('verify:typecheck')

    // Title must use a plain-English description of the step family.
    expect(item!.title).toMatch(/verification|check/i)

    // The raw step id still reaches the body.
    expect(item!.body).toContain('verify:typecheck')

    cleanup()
  })

  it('no-recipe path: spawns a generic-recipe recovery fix and blocks the source (ADR: uniform failure→fix spawn)', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    // 'verify:test/unclassified' is NOT in the registered recipe set. Every
    // regular-task failure still spawns a fix — the recovery-spawn path falls
    // back to the generic, first-principles recovery recipe instead of
    // dead-ending the task with an "unknown signature" action-queue row.
    const r = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:test',
      errorOutput: 'something nobody has classified yet',
      branch: 'task/x',
    })
    expect(r.outcome).toBe('blocked')
    expect(r.failureSignature).toBe('verify:test/unclassified')
    expect(r.fixTaskId).toBeTruthy()

    // Source task is blocked (not failed) with a task_blockers edge to the fix.
    const origin = await q.getTask(t.id)
    expect(origin?.status).toBe('blocked')
    const blockers = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ?`,
      args: [t.id],
    })
    expect(Number((blockers.rows[0] as unknown as { n: number }).n)).toBe(1)

    // A kind='fix' recovery was created, linked to the source by construction.
    const fix = await q.getTask(r.fixTaskId as string)
    expect(fix?.kind).toBe('fix')
    expect(fix?.fixForTaskId).toBe(t.id)
    const all = await q.resolveQueueClient().execute({
      sql: `SELECT id, tags_json FROM tasks`,
      args: [],
    })
    // Origin + fix + exactly one detached gate-enrichment Writer draft task +
    // one rescue-operator task (spawned because 'verify:test/unclassified' has
    // no registered recipe, triggering maybeSpawnRescueOperator in parallel
    // with the generic fix task).
    // (PRD 745f33e0: 'verify:test/unclassified' is statically encodable and
    // unclaimed, so the failure chokepoint claims the signature and spawns
    // ONE writer-tagged candidate-drafting task — never a second one).
    expect(all.rows.length).toBe(4)
    const writerRows = all.rows.filter((row) =>
      String(
        (row as unknown as { tags_json: string | null }).tags_json ?? '',
      ).includes('writer'),
    )
    expect(writerRows).toHaveLength(1)
    // The rescue-operator task was spawned alongside the generic fix task
    // because no recipe is registered for this signature.
    const rescueRows = all.rows.filter((row) =>
      String(
        (row as unknown as { tags_json: string | null }).tags_json ?? '',
      ).includes('rescue-operator'),
    )
    expect(rescueRows).toHaveLength(1)
  })

  // The Steward guard (core/steward-guard.ts) allows exactly ONE intervention
  // per (target, version) — here (task, failureSignature). That is the
  // documented contract: exactly one recovery attempt per origin failure, no
  // retry budget and no tunable knob. These tests assert no second fix task,
  // source stays blocked with its original error, and repeats dedupe onto one
  // action-queue row.
  it('steward guard: allows exactly one fix task per (sourceTaskId, failureSignature) and refuses the second dispatch', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '10'
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

    // Use self_heal_attempts (not tasks) to count prior fix attempts: updating
    // a fix task to 'done' clears its failure_signature column (updateTask
    // scrubs stale failure metadata on done transitions), so a tasks-table
    // COUNT with failure_signature = sig would incorrectly return 0. The
    // self_heal_attempts ledger is append-only and survives the fix-task
    // lifecycle through all terminal statuses.
    const fixCountBefore = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM self_heal_attempts WHERE parent_task_id = ? AND failure_signature = ?`,
      args: [t.id, sig],
    })
    expect(
      Number((fixCountBefore.rows[0] as unknown as { n: number }).n),
    ).toBe(1)

    // 2nd dispatch for the same signature: the Steward already intervened for
    // this (task, signature), so no second fix task is inserted and the repeat
    // is surfaced to the operator instead.
    const r2 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    expect(r2.outcome).toBe('steward-repeat')
    expect(r2.fixTaskId).toBeUndefined()
    expect(r2.failureSignature).toBe(sig)
    expect(r2.actionQueueItemId).toBeTruthy()

    // No new attempt was recorded — the ledger still shows the single fix task.
    const fixCountAfter = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM self_heal_attempts WHERE parent_task_id = ? AND failure_signature = ?`,
      args: [t.id, sig],
    })
    expect(
      Number((fixCountAfter.rows[0] as unknown as { n: number }).n),
    ).toBe(1)

    const item2 = await actionQueue.getActionQueueItem(r2.actionQueueItemId!)
    expect(item2?.kind).toBe('steward-repeat')
    expect(item2?.category).toBe('orchestrator')
    expect(item2?.priority).toBe('high')
    expect(item2?.seenCount).toBe(1)
    cleanup()
  })

  it('steward guard: source task remains blocked with its prior error summary on a refused repeat; not flipped back to queued', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '10'
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

    // Capture the source task's error summary right before the refusal —
    // it must survive untouched.
    const beforeEscalation = await q.getTask(t.id)
    expect(beforeEscalation?.status).toBe('blocked')
    const priorError = beforeEscalation?.error
    expect(priorError).toBeTruthy()

    // A different message body that still classifies to the same
    // typecheck-cannot-find-name signature, so the Steward guard sees the
    // same (task, version) target and refuses.
    const r2 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name BAR (later, different output)',
    })
    expect(r2.outcome).toBe('steward-repeat')

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('blocked')
    // The earlier error survives — the refusal must not overwrite it
    // with the latest dispatch's error summary.
    expect(reloaded?.error).toBe(priorError)
    cleanup()
  })

  it('steward guard: 3rd and subsequent dispatches dedupe onto the same actionQueue row and bump seenCount, no new task or actionQueue row', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '10'
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

    // 2nd dispatch: Steward refuses and opens the repeat row.
    const r2 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    expect(r2.outcome).toBe('steward-repeat')
    expect(r2.fixTaskId).toBeUndefined()

    // 3rd and 4th dedupe onto that same row rather than opening siblings.
    const r3 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    expect(r3.outcome).toBe('steward-repeat')
    expect(r3.actionQueueItemId).toBe(r2.actionQueueItemId)
    expect(r3.fixTaskId).toBeUndefined()

    const r4 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    expect(r4.outcome).toBe('steward-repeat')
    expect(r4.actionQueueItemId).toBe(r2.actionQueueItemId)

    // No new self_heal_attempts rows beyond the original one — the guard
    // blocked the 2nd, 3rd and 4th from creating fix-task rows. Use
    // self_heal_attempts (not tasks): updating a fix-task to 'done' clears
    // its failure_signature on that row; the ledger is append-only and reliable.
    const fixCount = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM self_heal_attempts WHERE parent_task_id = ? AND failure_signature = ?`,
      args: [t.id, sig],
    })
    expect(Number((fixCount.rows[0] as unknown as { n: number }).n)).toBe(1)

    // Exactly one steward-repeat actionQueue row exists; seenCount tracks
    // every refusal after the first (3 refusals -> seenCount 3).
    const loopItems = (await actionQueue.listActionQueueItems('open')).filter(
      (i) => i.kind === 'steward-repeat',
    )
    expect(loopItems).toHaveLength(1)
    expect(loopItems[0].id).toBe(r2.actionQueueItemId)
    expect(loopItems[0].seenCount).toBe(3)
    cleanup()
  })

  it('records a self_heal_attempts row on successful fix-task enqueue with parent id, signature, fix-task id, and fresh timestamp', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, rc } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'sig-attempt')
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })

    // `self_heal_attempts.created_at` is a bigint of epoch millis, so the
    // lower bound has to be a number too. Comparing it against an ISO string
    // coerces the string to NaN and every `>=` silently returns false.
    const before = Date.now()
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

    const rows = await q.resolveQueueClient().execute({
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
      created_at: number | bigint
    }
    expect(row.parent_task_id).toBe(t.id)
    expect(row.failure_signature).toBe('sig-attempt')
    expect(row.fix_task_id).toBe(r.fixTaskId)
    expect(Number(row.created_at) >= before).toBe(true)
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

    const rows = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM self_heal_attempts
             WHERE failure_signature = ?`,
      args: ['sig-fail'],
    })
    expect(Number((rows.rows[0] as unknown as { n: number }).n)).toBe(0)
    cleanup()
  })

})

// ── Phantom-kill routing ─────────────────────────────────────────────────────
//
// A phantom-killed task that never ran setup has no branch/worktree for a
// worktree-scoped fix to operate on. The failure handler must re-queue the
// origin instead of spawning a fix task (restart-style recovery). The requeue
// counts as the origin's one recovery slot; a second phantom kill escalates.

describe('phantom-kill routing', () => {
  let repo: string

  beforeAll(async () => {
    // Re-use the outer templateRepo if it exists; if not, build one.
    // The outer beforeAll runs first because describe blocks are parsed in
    // order, so templateRepo is always initialised before we get here.
  })

  beforeEach(() => {
    repo = setupRepo()
    cloneTemplateDbs(repo)
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  it('re-queues the origin WITHOUT consuming retryCount when phantom-killed with no worktree (first kill)', async () => {
    const { q, ft } = await loadModules(repo)
    const t = await q.enqueueTask('do some work', undefined, { skipTriage: true })

    // Simulate the phantom watchdog: stamp failure reason, no branch/worktree.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed',
              failure_reason = ?, failure_reason_code = ?,
              failed_phase = 'code',
              error = 'Task auto-failed by phantom-task watchdog (reason: ceiling, age: 31 min)',
              branch = NULL, worktree_path = NULL
            WHERE id = ?`,
      args: ['phantom-task watchdog: ceiling', 'phantom-task:ceiling', t.id],
    })

    const r = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      // The recovery spawner passes task.failureReason as the failingStep.
      failingStep: 'phantom-task watchdog: ceiling',
      errorOutput: 'Task auto-failed by phantom-task watchdog (reason: ceiling, age: 31 min)',
    })

    expect(r.outcome).toBe('requeued')
    // retryCount must stay 0 — phantom kills use the non-code retry counter,
    // so the code recovery slot is preserved for a real code failure.
    expect(r.retryCount).toBe(0)
    expect(r.fixTaskId).toBeUndefined()

    // Origin is back to queued; retryCount unchanged.
    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
    expect(reloaded?.retryCount).toBe(0)
    // Failure markers cleared.
    expect(reloaded?.failureSignature).toBeNull()
    expect(reloaded?.failedPhase).toBeNull()

    // No fix-task rows were inserted.
    const fixTasks = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [t.id],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  it('escalates to the action queue after MAX_NON_CODE_RETRIES phantom kills with no worktree', async () => {
    // cap=1: 1 re-queue allowed, escalate when count > 1 (i.e. on the 2nd kill)
    process.env.MARS_MAX_NON_CODE_RETRIES = '1'
    const { q, ft } = await loadModules(repo)
    const actionQueue = (await import('../action-queue')) as unknown as {
      listActionQueueItems: typeof import('../action-queue').listActionQueueItems
    }
    const t = await q.enqueueTask('do some work', undefined, { skipTriage: true })

    const stamp = async () => {
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'failed',
                failure_reason = ?, failure_reason_code = ?,
                failed_phase = 'code',
                error = 'Task auto-failed by phantom-task watchdog (reason: ceiling, age: 31 min)',
                branch = NULL, worktree_path = NULL
              WHERE id = ?`,
        args: ['phantom-task watchdog: ceiling', 'phantom-task:ceiling', t.id],
      })
    }

    // Kill 1: count=1, 1 > cap=1 is false → re-queue
    await stamp()
    const r1 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'phantom-task watchdog: ceiling',
      errorOutput: 'Task auto-failed by phantom-task watchdog (reason: ceiling, age: 31 min)',
    })
    expect(r1.outcome).toBe('requeued')
    expect(r1.retryCount).toBe(0)

    // Kill 2: count=2, 2 > cap=1 is true → escalate
    await stamp()
    const r2 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'phantom-task watchdog: ceiling',
      errorOutput: 'Task auto-failed by phantom-task watchdog (reason: ceiling, age: 31 min)',
    })
    expect(r2.outcome).toBe('non-code-retry-exhausted')
    expect(r2.fixTaskId).toBeUndefined()
    // retryCount never changed — code recovery slot intact
    expect(r2.retryCount).toBe(0)

    // Task is marked failed (escalated, not re-queued).
    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failureReason).toMatch(/^non-code-retry-exhausted:/)

    // An action-queue item was raised for operator attention.
    const items = await actionQueue.listActionQueueItems('open')
    expect(items.filter((i) => i.kind === 'failed')).toHaveLength(1)

    // Still no fix-task rows (code recovery slot was never consumed).
    const fixTasks = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [t.id],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(0)
    delete process.env.MARS_MAX_NON_CODE_RETRIES
  })

  it('takes the normal fix-task path when phantom-killed AFTER setup ran (branch/worktree exist)', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft } = await loadModules(repo)

    const t = await q.enqueueTask('do some work', undefined, { skipTriage: true })

    // Phantom kill AFTER setup: branch and worktree_path are populated AND the
    // worktree really exists on disk. `hasUsableWorktree` stats the recorded
    // path before allowing a recovery spawn, so a path that was never created
    // would route to the worktree-missing escalation instead of the fix-task
    // path this test is about.
    //
    // The row is deliberately left NON-terminal. A `failed` task cannot move to
    // `blocked` — the tasks trigger rejects it — so every caller that reaches
    // the spawn path enters non-terminal: the workflow primitives call the
    // handler mid-run, and the recovery spawner reopens the origin through the
    // audited seam first. Only the pre-setup escalation runs against a `failed`
    // row, and that path is covered by the two tests above.
    const worktreePath = resolve(repo, '.mars', 'worktrees', t.id)
    mkdirSync(worktreePath, { recursive: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET failure_reason = ?, failure_reason_code = ?,
              failed_phase = 'code',
              error = 'Task auto-failed by phantom-task watchdog (reason: dead-pid, age: 5 min)',
              branch = 'task/some-branch', worktree_path = ?
            WHERE id = ?`,
      args: ['phantom-task watchdog: dead-pid', 'phantom-task:dead-pid', worktreePath, t.id],
    })

    const r = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'phantom-task watchdog: dead-pid',
      errorOutput: 'Task auto-failed by phantom-task watchdog (reason: dead-pid, age: 5 min)',
    })

    // Must NOT requeue — a worktree exists so the normal fix-task path applies.
    expect(r.outcome).toBe('blocked')
    expect(r.fixTaskId).toBeTruthy()

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('blocked')

    const fixTasks = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [t.id],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(1)
  })
})

// Non-code failure re-queue routing: orchestration and connectivity failures
// classified by classifyFailure() as non-code must be re-queued instead of
// spawning a recovery fix-task that cannot fix them by editing code.
describe('non-code failure re-queue routing', () => {
  let repo: string

  beforeAll(async () => {
    // templateRepo is set by the outer describe('queue-fix-tasks') beforeAll
    // when the full suite runs. When this describe block runs in isolation
    // (e.g. with a -t filter), we need to initialise it ourselves.
    if (!templateRepo) {
      templateRepo = setupRepo()
      vi.resetModules()
      process.env.MARS_REPO = templateRepo
      const q = (await import('../../queue')) as unknown as QueueModule
      await q.migrateQueueSchema()
      const actionQueue = (await import('../action-queue')) as unknown as {
        initActionQueue: typeof import('../action-queue').initActionQueue
      }
      await actionQueue.initActionQueue()
      delete process.env.MARS_REPO
      vi.resetModules()
    }
  })

  beforeEach(() => {
    repo = setupRepo()
    cloneTemplateDbs(repo)
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('rebase-no-in-progress-state (orchestration) re-queues the origin and inserts no fix-task row', async () => {
    const { q, ft } = await loadModules(repo)
    const t = await q.enqueueTask('do some work', undefined, { skipTriage: true })

    // Simulate a merge step aborted because git rebase could not start.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed',
              failure_reason = 'merge step aborted: rebase could not start',
              failed_phase = 'merge',
              error = 'rebase produced no in-progress state'
            WHERE id = ?`,
      args: [t.id],
    })

    const r = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'merge:vcs-supervisor-aborted',
      errorOutput: 'rebase produced no in-progress state',
    })

    // Signature = merge:vcs-supervisor-aborted/rebase-no-in-progress-state
    // classifyFailure → 'orchestration' → not 'code' → re-queue
    expect(r.outcome).toBe('requeued')
    expect(r.failureSignature).toBe(
      'merge:vcs-supervisor-aborted/rebase-no-in-progress-state',
    )
    // retryCount must stay 0 — non-code re-queues no longer consume the code recovery slot
    expect(r.retryCount).toBe(0)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
    expect(reloaded?.retryCount).toBe(0)
    expect(reloaded?.failureSignature).toBeNull()
    expect(reloaded?.failedPhase).toBeNull()

    // No fix-task rows were inserted.
    const fixTasks = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [t.id],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  it('test-pg-connection-refused (connectivity) re-queues the origin and inserts no fix-task row', async () => {
    const { q, ft } = await loadModules(repo)
    const t = await q.enqueueTask('do some work', undefined, { skipTriage: true })

    // Simulate a verify step that could not reach the PostgreSQL server.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed',
              failure_reason = 'verify step failed: pg connection refused',
              failed_phase = 'verify',
              error = 'ECONNREFUSED 127.0.0.1:5432'
            WHERE id = ?`,
      args: [t.id],
    })

    const r = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:test',
      errorOutput: 'ECONNREFUSED 127.0.0.1:5432',
    })

    // Signature = verify:test/test-pg-connection-refused
    // classifyFailure → 'connectivity' → not 'code' → re-queue
    expect(r.outcome).toBe('requeued')
    expect(r.failureSignature).toBe('verify:test/test-pg-connection-refused')
    // retryCount must stay 0 — non-code re-queues no longer consume the code recovery slot
    expect(r.retryCount).toBe(0)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
    expect(reloaded?.retryCount).toBe(0)
    expect(reloaded?.failureSignature).toBeNull()
    expect(reloaded?.failedPhase).toBeNull()

    // No fix-task rows were inserted.
    const fixTasks = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [t.id],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  it('api-unreachable-class failure (connectivity) is re-queued by the generalised non-code branch', async () => {
    // Uses failingStep 'code:api-proxy' (NOT 'code:coder-exit-nonzero') so the
    // produced signature 'code:api-proxy/api-unreachable' is NOT in the FAILURE_KINDS
    // registry as environmental — isEnvironmentalSignature returns false and the
    // handler falls through to the new classifyFailure-based non-code branch.
    const { q, ft } = await loadModules(repo)
    const t = await q.enqueueTask('do some work', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed',
              failure_reason = 'api proxy could not connect',
              failed_phase = 'code',
              error = 'Unable to connect to API (ECONNREFUSED)'
            WHERE id = ?`,
      args: [t.id],
    })

    const r = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'code:api-proxy',
      errorOutput: 'Unable to connect to API (ECONNREFUSED)',
    })

    // Signature = code:api-proxy/api-unreachable
    // classifyFailure → 'connectivity' → not 'code' → re-queue (generalised path)
    expect(r.outcome).toBe('requeued')
    expect(r.failureSignature).toBe('code:api-proxy/api-unreachable')
    // retryCount must stay 0 — non-code re-queues no longer consume the code recovery slot
    expect(r.retryCount).toBe(0)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
    expect(reloaded?.retryCount).toBe(0)
    expect(reloaded?.failureSignature).toBeNull()

    // No fix-task rows were inserted.
    const fixTasks = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [t.id],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  it('preflight:no-gates-configured marks task failed without spawning a fix-task', async () => {
    // A preflight failure is a configuration error — no verify gates are
    // registered for the changed files. The handler must NOT spawn a recovery
    // fix-task (that would burn the one recovery slot on a doomed repair).
    // Instead it marks the task failed and raises an operator-notice.
    const { q, ft } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })

    const r = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'preflight:no-gates-configured',
      errorOutput:
        'No verify gates are configured for the changed files. ' +
        'Run `mars verify-gate check` to see manifest drift.',
    })

    expect(r.outcome).toBe('failed')
    expect(r.failureSignature).toMatch(/^config-failure:preflight:/)
    expect(r.retryCount).toBe(0)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failedPhase).toBe('verify')
    expect(reloaded?.failureReason).toMatch(/^config-failure:preflight:/)

    // No fix-task must be spawned — this is a configuration error, not a code defect.
    const fixTasks = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [t.id],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(0)
  })
})

// ── Non-code retry cap (Slice 3 of PRD d7835017) ─────────────────────────────
//
// Non-code re-queues (connectivity, orchestration, infra) must NOT consume the
// code recovery slot. A per-(taskId, failureSignature) counter gates further
// re-queues; after MAX_NON_CODE_RETRIES (default 3) the task escalates to the
// action queue without ever touching retryCount.

describe('non-code retry cap', () => {
  let repo: string

  beforeAll(async () => {
    if (!templateRepo) {
      templateRepo = setupRepo()
      vi.resetModules()
      process.env.MARS_REPO = templateRepo
      const q = (await import('../../queue')) as unknown as QueueModule
      await q.migrateQueueSchema()
      const actionQueue = (await import('../action-queue')) as unknown as {
        initActionQueue: typeof import('../action-queue').initActionQueue
      }
      await actionQueue.initActionQueue()
      delete process.env.MARS_REPO
      vi.resetModules()
    }
  })

  beforeEach(() => {
    repo = setupRepo()
    cloneTemplateDbs(repo)
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_MAX_NON_CODE_RETRIES
    rmSync(repo, { recursive: true, force: true })
  })

  // (a) Three consecutive rebase-no-in-progress-state failures re-queue with retryCount staying at 0.
  it('(a) three consecutive non-code failures re-queue without incrementing retryCount', async () => {
    process.env.MARS_MAX_NON_CODE_RETRIES = '3'
    const { q, ft } = await loadModules(repo)
    const t = await q.enqueueTask('do some work', undefined, { skipTriage: true })

    const stamp = async () => {
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'failed',
                failure_reason = 'merge step aborted: rebase could not start',
                failed_phase = 'merge',
                error = 'rebase produced no in-progress state'
              WHERE id = ?`,
        args: [t.id],
      })
    }

    for (let i = 1; i <= 3; i++) {
      await stamp()
      const r = await ft.handleTaskFailureWithFixTask({
        taskId: t.id,
        failingStep: 'merge:vcs-supervisor-aborted',
        errorOutput: 'rebase produced no in-progress state',
      })
      expect(r.outcome).toBe('requeued')
      expect(r.retryCount).toBe(0)

      const task = await q.getTask(t.id)
      expect(task?.status).toBe('queued')
      expect(task?.retryCount).toBe(0)
    }

    // Non-code retry counter is at 3; code recovery slot untouched.
    const nonCodeRows = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM non_code_requeue_attempts WHERE task_id = ?`,
      args: [t.id],
    })
    expect(Number((nonCodeRows.rows[0] as unknown as { n: number }).n)).toBe(3)

    // No fix-task rows were ever inserted.
    const fixTasks = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [t.id],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  // (b) The fourth escalates to an action-queue item and marks the task failed.
  it('(b) fourth non-code failure escalates to action queue and marks task failed', async () => {
    process.env.MARS_MAX_NON_CODE_RETRIES = '3'
    const { q, ft } = await loadModules(repo)
    const actionQueue = (await import('../action-queue')) as unknown as {
      listActionQueueItems: typeof import('../action-queue').listActionQueueItems
    }
    const t = await q.enqueueTask('do some work', undefined, { skipTriage: true })

    const stamp = async () => {
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'failed',
                failure_reason = 'merge step aborted: rebase could not start',
                failed_phase = 'merge',
                error = 'rebase produced no in-progress state'
              WHERE id = ?`,
        args: [t.id],
      })
    }

    // First 3 re-queue
    for (let i = 0; i < 3; i++) {
      await stamp()
      const r = await ft.handleTaskFailureWithFixTask({
        taskId: t.id,
        failingStep: 'merge:vcs-supervisor-aborted',
        errorOutput: 'rebase produced no in-progress state',
      })
      expect(r.outcome).toBe('requeued')
    }

    // 4th: cap reached → escalate
    await stamp()
    const r4 = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'merge:vcs-supervisor-aborted',
      errorOutput: 'rebase produced no in-progress state',
    })
    expect(r4.outcome).toBe('non-code-retry-exhausted')
    expect(r4.fixTaskId).toBeUndefined()
    // retryCount still 0 — code recovery slot was never consumed
    expect(r4.retryCount).toBe(0)

    // Task is now failed
    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failureReason).toMatch(/^non-code-retry-exhausted:/)

    // Action-queue item raised
    const items = await actionQueue.listActionQueueItems('open')
    expect(items.filter((i) => i.kind === 'failed')).toHaveLength(1)

    // Still no fix-task rows
    const fixTasks = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [t.id],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  // (c) After a non-code re-queue, a subsequent CODE failure gets its one recovery fix-task
  //     (retryCount transitions 0→1 exactly once and the fix task is spawned).
  it('(c) code failure after non-code re-queue still gets one code recovery (retryCount 0→1)', async () => {
    process.env.MARS_MAX_NON_CODE_RETRIES = '3'
    const { q, ft, rc } = await loadModules(repo)
    const sig = 'verify:typecheck/typecheck-cannot-find-name'
    const cleanup = registerTestRecipe(rc, sig)
    const t = await q.enqueueTask('do some work', undefined, { skipTriage: true })

    // Step 1: one non-code failure → requeue, retryCount stays 0
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed',
              failure_reason = 'merge step aborted: rebase could not start',
              failed_phase = 'merge',
              error = 'rebase produced no in-progress state'
            WHERE id = ?`,
      args: [t.id],
    })
    const rNonCode = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'merge:vcs-supervisor-aborted',
      errorOutput: 'rebase produced no in-progress state',
    })
    expect(rNonCode.outcome).toBe('requeued')
    expect(rNonCode.retryCount).toBe(0)

    // Step 2: code failure → spawns fix task, retryCount 0→1
    const rCode = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
      branch: 'task/x',
    })
    expect(rCode.outcome).toBe('blocked')
    expect(rCode.fixTaskId).toBeTruthy()
    // retryCount transitions 0→1 exactly once
    expect(rCode.retryCount).toBe(1)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('blocked')
    expect(reloaded?.retryCount).toBe(1)

    // One fix-task was spawned
    const fixTasks = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [t.id],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(1)

    cleanup()
  })
})
