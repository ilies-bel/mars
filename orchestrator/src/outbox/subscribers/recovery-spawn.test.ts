import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DbClient } from '../../core/lib/db.js'
import type { EventName, EventPayload } from '../../bus/events.js'

// ---------------------------------------------------------------------------
// Module type shims (loaded via vi.resetModules() isolation)
// ---------------------------------------------------------------------------

interface QueueModule {
  enqueueTask: typeof import('../../core/queue').enqueueTask
  updateTask: typeof import('../../core/queue').updateTask
  getTask: typeof import('../../core/queue').getTask
  resolveQueueClient: typeof import('../../core/queue').resolveQueueClient
  ensureQueueSchema: typeof import('../../core/queue').ensureQueueSchema
}

interface ActionQueueModule {
  listActionQueueItems: typeof import('../../core/lib/action-queue').listActionQueueItems
}

interface ActionQueueItem {
  id: string
  originTaskId: string | null
  payload: unknown
  state: string
}

interface FixTasksModule {
  upsertFixTask: typeof import('../../core/queue-fix-tasks').upsertFixTask
}

interface RecipesModule {
  recipes: typeof import('../../core/lib/fix-recipes').recipes
}

interface RecoverySpawnModule {
  RECOVERY_SPAWN_SUBSCRIBER: typeof import('./recovery-spawn').RECOVERY_SPAWN_SUBSCRIBER
  ensureRecoverySpawner: typeof import('./recovery-spawn').ensureRecoverySpawner
  drainRecoverySpawner: typeof import('./recovery-spawn').drainRecoverySpawner
}

interface PublisherModule {
  publishWithRetry: typeof import('../../bus/publisher').publishWithRetry
}

interface CircuitBreakerModule {
  apiCircuitBreaker: typeof import('../../core/lib/api-circuit-breaker').apiCircuitBreaker
}

interface SpendControlStoreModule {
  upsertSpendControl: typeof import('../../core/daemon/spend-control/store').upsertSpendControl
}

interface ContinueTaskModule {
  coreContinueTask: typeof import('../../core/daemon/continue-task').coreContinueTask
}

interface Loaded {
  q: QueueModule
  aq: ActionQueueModule
  ft: FixTasksModule
  rc: RecipesModule
  rs: RecoverySpawnModule
  // Legacy skipped tests below retain this inert slot until their historical
  // fixture is removed; the production monitor no longer exposes it.
  gm: any
  pub: PublisherModule
  cb: CircuitBreakerModule
  sc: SpendControlStoreModule
  continueTask: ContinueTaskModule
  client: DbClient
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-recovery-spawn-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  // `git init -b main` leaves `main` UNBORN — the ref does not exist until the
  // first commit. `mars continue` refreshes a worktree with
  // `git merge --no-edit main`, which then fails with "main - not something we
  // can merge". One commit makes the branch real.
  execFileSync('git', ['config', 'user.email', 'test@mars.local'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Mars Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README.md'), 'recovery-spawn fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * Load every needed module with a fresh module registry so each test gets its
 * own singleton DB client. MARS_REPO is set before import so resolveContext()
 * picks up the per-test repo directory.
 */
const loadModules = async (repo: string): Promise<Loaded> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../core/queue')) as unknown as QueueModule
  await q.ensureQueueSchema()
  const aq = (await import(
    '../../core/lib/action-queue'
  )) as unknown as ActionQueueModule
  const ft = (await import(
    '../../core/queue-fix-tasks'
  )) as unknown as FixTasksModule
  const rc = (await import(
    '../../core/lib/fix-recipes'
  )) as unknown as RecipesModule
  const rs = (await import('./recovery-spawn')) as unknown as RecoverySpawnModule
  const pub = (await import(
    '../../bus/publisher'
  )) as unknown as PublisherModule
  const cb = (await import(
    '../../core/lib/api-circuit-breaker'
  )) as unknown as CircuitBreakerModule
  const sc = (await import(
    '../../core/daemon/spend-control/store'
  )) as unknown as SpendControlStoreModule
  const continueTask = (await import(
    '../../core/daemon/continue-task'
  )) as unknown as ContinueTaskModule
  return { q, aq, ft, rc, rs, gm: {}, pub, cb, sc, continueTask, client: q.resolveQueueClient() }
}

/**
 * Add a synthetic recipe for `signature` that survives for the duration of
 * one test. Returns a teardown function that removes the recipe entry.
 *
 * The failure-signature classifier won't naturally produce arbitrary test
 * signatures, so tests that exercise the recovery path with a controlled
 * signature register one here and drive the subscriber with a matching error
 * string.
 */
const registerTestRecipe = (
  rc: RecipesModule,
  signature: string,
): (() => void) => {
  rc.recipes[signature] = {
    signature,
    title: () => `test: ${signature}`,
    buildPrompt: () => `synthetic recovery prompt for ${signature}`,
  }
  return () => {
    delete rc.recipes[signature]
  }
}

const publish = async <T extends EventName>(
  pub: PublisherModule,
  client: DbClient,
  type: T,
  payload: EventPayload<T>,
): Promise<void> => {
  await pub.publishWithRetry(client, type, payload)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recovery-spawn outbox subscriber', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  it('spawns exactly one recovery task for a single task.failed event', async () => {
    const { q, ft, rc, rs, pub, client } = await loadModules(repo)

    // A durable task.failed event is only recoverable while its origin is
    // still terminal. Give the failed task a usable worktree, as production
    // recovery does, so this exercises the failed → recovery-blocked path.
    const t1 = await q.enqueueTask('implement feature X', undefined, {
      skipTriage: true,
    })
    await q.updateTask(t1.id, {
      status: 'failed',
      failedPhase: 'verify',
      branch: `task/${t1.id}`,
      worktreePath: repo,
    })

    const signature = 'verify/no-commits-ahead'
    const cleanup = registerTestRecipe(rc, signature)

    // Register subscriber AFTER task setup so the cursor starts past the
    // setup events and only reacts to the event we publish below.
    await rs.ensureRecoverySpawner(client)

    // Simulate the worker reporting a task failure by publishing a task.failed
    // event with an error string that the classifier maps to 'no-commits-ahead'.
    await publish(pub, client, 'task.failed', {
      taskId: t1.id,
      error: 'no commits ahead of integration branch',
    })

    const { processed } = await rs.drainRecoverySpawner(client)

    // The drain must have processed exactly one event.
    expect(processed).toBe(1)

    // The source task should now be blocked behind exactly one fix task.
    const reloaded = await q.getTask(t1.id)
    expect(reloaded?.status).toBe('blocked')

    const fixRows = await client.execute({
      sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
      args: [t1.id],
    })
    expect(fixRows.rows).toHaveLength(1)

    cleanup()
  })

  it('preserves the row-recorded failure output across the reopen when the event payload is a status echo', async () => {
    // Live regression (mars-76fef59f): the subscriber reopens the origin —
    // `reopenTerminalTask` NULLs `error` AND `failure_signature` — and the
    // recovery-exhausted branch then lands the row terminal again. On the
    // second and later passes of the 30 s re-failure loop the event payload
    // carries nothing but the previous reason, so the real captured output has
    // to come off the row, snapshotted before the reopen.
    process.env.MARS_FIX_RETRY_BUDGET = '0'
    const { q, rs, pub, client } = await loadModules(repo)

    const captured =
      'typecheck:\n\n> @mars/ui@0.1.0 typecheck\n> tsc --noEmit\n\n' +
      "server/actionQueue.test.ts(712,24): error TS2339: Property 'staleQueued' does not exist on type 'ActionQueueRow'."
    const t = await q.enqueueTask('make the UI compile', undefined, {
      skipTriage: true,
    })
    await q.updateTask(t.id, {
      status: 'failed',
      error: captured,
      failedPhase: 'verify',
      failureReason: 'verify:typecheck',
      failureSignature: 'verify:typecheck/typecheck-property-missing',
      branch: `task/${t.id}`,
      worktreePath: repo,
      retryCount: 1,
    })

    await rs.ensureRecoverySpawner(client)
    await publish(pub, client, 'task.failed', {
      taskId: t.id,
      error: 'recovery_exhausted:verify/unclassified',
    })

    const { processed } = await rs.drainRecoverySpawner(client)
    expect(processed).toBe(1)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.error).toContain('TS2339')
    expect(reloaded?.failureSignature).toBeTruthy()
  })

  it('does not block a task continued before its pending failure event drains', async () => {
    const { q, rs, continueTask, client } = await loadModules(repo)
    const task = await q.enqueueTask('resume without stale recovery', undefined, {
      skipTriage: true,
    })

    // Subscribe before the failure so its event remains pending while the
    // operator continues the task.
    await rs.ensureRecoverySpawner(client)
    await q.updateTask(task.id, {
      status: 'failed',
      failedPhase: 'verify',
      branch: `task/${task.id}`,
      worktreePath: repo,
      error: 'no commits ahead of integration branch',
    })

    await continueTask.coreContinueTask(task.id)
    await rs.drainRecoverySpawner(client)

    expect((await q.getTask(task.id))?.status).toBe('queued')
    const recoveries = await client.execute({
      sql: 'SELECT id FROM tasks WHERE fix_for_task_id = ?',
      args: [task.id],
    })
    expect(recoveries.rows).toHaveLength(0)
  })

  it('escalates a pre-setup failure without spawning a recovery task', async () => {
    const { q, aq, rs, client } = await loadModules(repo)
    const origin = await q.enqueueTask('triage this task', undefined, {
      skipTriage: true,
    })

    await rs.ensureRecoverySpawner(client)
    await q.updateTask(origin.id, {
      status: 'failed',
      failedPhase: 'code',
      failureReason: 'triage',
      error: 'triage workflow failed: claude -p exited 1',
    })

    const { processed } = await rs.drainRecoverySpawner(client)
    expect(processed).toBe(1)

    const recoveries = await client.execute({
      sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
      args: [origin.id],
    })
    expect(recoveries.rows).toHaveLength(0)

    const items = await aq.listActionQueueItems('open')
    expect(
      items.filter(
        (item) =>
          item.originTaskId === origin.id &&
          (item.payload as Record<string, unknown>).taskId === origin.id,
      ),
    ).toHaveLength(1)
  })

  it('never reopens a failed recovery task, so the escalation cannot re-drive itself', async () => {
    // Regression (fix-139f327c, 2026-07-31). The drain used to reopen EVERY
    // terminal row through the audited reopen seam, including recovery Chores.
    // For a recovery that closed the loop: reopen → `queued`, escalation writes
    // it back to `failed`, that status change emits a NEW task.failed carrying
    // the composed reason, the next 30 s drain feeds it back in. Ten passes
    // later `failure_reason` was ten `recovery_failed:` prefixes deep with the
    // real error truncated away, and each pass had re-raised the action-queue
    // row and re-spawned the rescue operator. A recovery Chore is a leaf
    // (ADR-0040) and is never re-run, so it must never be reopened.
    const { q, ft, rc, rs, client } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'seed-recovery')
    const origin = await q.enqueueTask('origin work', undefined, {
      skipTriage: true,
    })
    const { fixTaskId } = await ft.upsertFixTask({
      sourceTaskId: origin.id,
      failureSignature: 'seed-recovery',
      failingStep: 'code',
      truncatedError: 'coder left 1 path(s) uncommitted',
      branch: `task/${origin.id}`,
      recipeContext: {
        targetPath: repo,
        statusOutput: 'coder left 1 path(s) uncommitted',
        targetBranch: `task/${origin.id}`,
        originalPrompt: origin.prompt,
      },
    })

    // Subscribe first so the failure written below is the one event we drain.
    await rs.ensureRecoverySpawner(client)
    await q.updateTask(fixTaskId, {
      status: 'failed',
      failedPhase: 'code',
      failureReason: 'code',
      branch: `task/${origin.id}`,
      worktreePath: repo,
      error: 'coder left 1 path(s) uncommitted',
    })

    const { processed } = await rs.drainRecoverySpawner(client)
    expect(processed).toBe(1)

    const recovery = await q.getTask(fixTaskId)
    expect(recovery?.status).toBe('failed')
    expect(recovery?.failureReason?.match(/recovery_failed:/g)).toHaveLength(1)
    // The captured process output survives: `error` is never overwritten with
    // the derived reason (that erased the real output the Steward brief reads).
    expect(recovery?.error).toBe('coder left 1 path(s) uncommitted')

    // The terminal recovery row was never reopened …
    const reopens = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM task_terminal_reopens WHERE task_id = ?`,
      args: [fixTaskId],
    })
    expect(Number((reopens.rows[0] as unknown as { n: number }).n)).toBe(0)

    // … so the escalation emitted no second task.failed to feed the next drain.
    const failedEvents = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM events
             WHERE type = 'task.failed' AND payload LIKE ?`,
      args: [`%${fixTaskId}%`],
    })
    expect(Number((failedEvents.rows[0] as unknown as { n: number }).n)).toBe(1)

    // A second drain has nothing left to do — the loop is broken, not throttled.
    expect((await rs.drainRecoverySpawner(client)).processed).toBe(0)

    cleanup()
  })

  // ── The anti-loop gate, and its inverse ──────────────────────────────────
  //
  // These two run as a pair on purpose. The first pins that a row already
  // holding a terminal verdict is never re-driven; the second pins that the
  // guard doing so has not swallowed the ONE recovery attempt ADR-0040 owes an
  // ordinary first failure. A fix that passes only the first is a regression.

  it('never reopens an ORIGIN already terminal with a recovery_exhausted: verdict', async () => {
    // Live regression (mars-76fef59f, 2026-07-31): 314 action-queue rows in
    // just over an hour, cycling
    //   task.queued → task.failed(recovery_exhausted:verify/unclassified) → …
    // every 30 s. The guard above the reopen recognised only the
    // `origin_recovery_failed:` prefix, while the code-recovery budget gate in
    // queue-fix-tasks.ts writes `recovery_exhausted:`. So the spawner reopened
    // the row, the exhausted branch immediately re-failed it, that write
    // emitted a fresh task.failed, and the next drain fed it straight back in.
    //
    // The fix makes the guard consult the whole `TERMINAL_VERDICT_PREFIXES`
    // vocabulary. Before it, this test fails on the reopen count (1, not 0).
    process.env.MARS_FIX_RETRY_BUDGET = '0'
    const { q, rs, pub, client } = await loadModules(repo)

    const t = await q.enqueueTask('work that already exhausted recovery', undefined, {
      skipTriage: true,
    })
    await q.updateTask(t.id, {
      status: 'failed',
      failedPhase: 'verify',
      error: 'FAIL src/thing.test.ts > expected 2 to be 3',
      failureReason: 'recovery_exhausted:verify/unclassified',
      failureSignature: 'verify/unclassified',
      branch: `task/${t.id}`,
      worktreePath: repo,
      retryCount: 2,
    })

    await rs.ensureRecoverySpawner(client)
    await publish(pub, client, 'task.failed', {
      taskId: t.id,
      error: 'recovery_exhausted:verify/unclassified',
    })

    const countFailedEvents = async (): Promise<number> => {
      const r = await client.execute({
        sql: `SELECT COUNT(*) AS n FROM events
               WHERE type = 'task.failed' AND payload LIKE ?`,
        args: [`%${t.id}%`],
      })
      return Number((r.rows[0] as unknown as { n: number }).n)
    }
    const failedEventsBefore = await countFailedEvents()

    await rs.drainRecoverySpawner(client)

    // The row was never handed to the audited reopen seam.
    const reopens = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM task_terminal_reopens WHERE task_id = ?`,
      args: [t.id],
    })
    expect(Number((reopens.rows[0] as unknown as { n: number }).n)).toBe(0)

    // It stayed terminal, keeping the verdict AND the captured evidence — the
    // reopen is what used to NULL `error` and decay the reason to a status echo.
    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failureReason).toBe('recovery_exhausted:verify/unclassified')
    expect(reloaded?.error).toContain('expected 2 to be 3')

    // No second recovery was spawned on top of the spent slot.
    const recoveries = await client.execute({
      sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
      args: [t.id],
    })
    expect(recoveries.rows).toHaveLength(0)

    // And — THE actual loop condition — the pass emitted no NEW task.failed.
    // That, not the reopen, is what fed the loop: each re-failure wrote
    // `status='failed'` again, which emitted the event the next 30 s drain
    // consumed. No new event means nothing left to drain: the loop is broken,
    // not throttled.
    expect(await countFailedEvents()).toBe(failedEventsBefore)
    expect((await rs.drainRecoverySpawner(client)).processed).toBe(0)
  })

  it('still spawns the one legitimate recovery for a first failure carrying a plain step reason', async () => {
    // The inverse failure the guard above must not cause. `verify:has-diff` is
    // an ordinary failing-step reason, not a terminal verdict, so this origin is
    // owed exactly one recovery attempt (ADR-0040). A guard broad enough to
    // match it would silently disable self-heal for every first failure — the
    // regression that is much worse than the loop, because it is invisible.
    const { q, rc, rs, pub, client } = await loadModules(repo)

    const t = await q.enqueueTask('ordinary first failure', undefined, {
      skipTriage: true,
    })
    await q.updateTask(t.id, {
      status: 'failed',
      failedPhase: 'verify',
      failureReason: 'verify:has-diff',
      error: 'no commits ahead of integration branch',
      branch: `task/${t.id}`,
      worktreePath: repo,
    })

    const cleanup = registerTestRecipe(rc, 'verify:has-diff/no-commits-ahead')

    await rs.ensureRecoverySpawner(client)
    await publish(pub, client, 'task.failed', {
      taskId: t.id,
      error: 'no commits ahead of integration branch',
    })

    const { processed } = await rs.drainRecoverySpawner(client)
    expect(processed).toBe(1)

    // The reopen DID happen — the guard let this one through …
    const reopens = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM task_terminal_reopens WHERE task_id = ?`,
      args: [t.id],
    })
    expect(Number((reopens.rows[0] as unknown as { n: number }).n)).toBe(1)

    // … and produced exactly one recovery, with the origin parked behind it.
    const recoveries = await client.execute({
      sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
      args: [t.id],
    })
    expect(recoveries.rows).toHaveLength(1)
    expect((await q.getTask(t.id))?.status).toBe('blocked')

    cleanup()
  })

  it('spawns zero additional recovery tasks when the same event is replayed (cursor already advanced)', async () => {
    const { q, ft, rc, rs, pub, client } = await loadModules(repo)

    const t1 = await q.enqueueTask('implement feature Y', undefined, {
      skipTriage: true,
    })
    await q.updateTask(t1.id, {
      status: 'failed',
      failedPhase: 'verify',
      branch: `task/${t1.id}`,
      worktreePath: repo,
    })

    const signature = 'verify/no-commits-ahead'
    const cleanup = registerTestRecipe(rc, signature)

    await rs.ensureRecoverySpawner(client)
    await publish(pub, client, 'task.failed', {
      taskId: t1.id,
      error: 'no commits ahead of integration branch',
    })

    // First drain: spawns the recovery.
    const first = await rs.drainRecoverySpawner(client)
    expect(first.processed).toBe(1)

    // Second drain: cursor is now past the event — nothing pending, nothing processed.
    const second = await rs.drainRecoverySpawner(client)
    expect(second.processed).toBe(0)

    // Still exactly one fix task.
    const fixRows = await client.execute({
      sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
      args: [t1.id],
    })
    expect(fixRows.rows).toHaveLength(1)

    cleanup()
  })

  it('does not spawn a second recovery when the recovery task itself fails, and raises one action-queue item', async () => {
    const { q, ft, rc, rs, pub, client, aq } = await loadModules(repo)

    // Create origin task T1.
    const t1 = await q.enqueueTask('implement feature Z', undefined, {
      skipTriage: true,
    })

    // Register a recipe so upsertFixTask can build the fix-task prompt.
    const signature = 'verify/no-commits-ahead'
    const cleanup = registerTestRecipe(rc, signature)

    // Spawn the initial recovery task T2 for T1.
    const r = await ft.upsertFixTask({
      sourceTaskId: t1.id,
      failureSignature: signature,
      failingStep: 'verify:has-diff',
      truncatedError: 'no commits ahead of integration branch',
      branch: null,
      recipeContext: {
        targetPath: '/tmp/test',
        statusOutput: 'no commits ahead',
        targetBranch: 'main',
        originalPrompt: t1.id,
      },
    })
    const fixTaskId = r.fixTaskId

    // Mark T2 as already failed BEFORE registering the subscriber so that
    // when the subscriber calls handleTaskFailureWithFixTask(T2), the
    // updateTask(T2, failed) call is a no-op (no status change → no new
    // task.failed event to chase, keeping the drain bounded).
    await q.updateTask(fixTaskId, {
      status: 'failed',
      error: 'recovery crashed',
    })

    cleanup()

    // Register subscriber with cursor past all setup events.
    await rs.ensureRecoverySpawner(client)

    // Publish task.failed for T2 (the recovery task) — this is the event the
    // subscriber must react to by escalating, not by spawning another recovery.
    await publish(pub, client, 'task.failed', {
      taskId: fixTaskId,
      error: 'recovery crashed',
    })

    const { processed } = await rs.drainRecoverySpawner(client)
    expect(processed).toBe(1)

    // No additional fix task should have been spawned for T1 — only T2.
    const fixRows = await client.execute({
      sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
      args: [t1.id],
    })
    expect(fixRows.rows).toHaveLength(1)
    expect(
      (fixRows.rows[0] as unknown as { id: string }).id,
    ).toBe(fixTaskId)

    // Exactly one actionQueue item should be open for the origin task's arc,
    // keyed on T1's originId (which equals T1.id for a root task).
    const items = await aq.listActionQueueItems('open')
    const originItems = items.filter(
      (item) =>
        item.originTaskId === t1.id ||
        (item.payload as Record<string, unknown>).originTaskId === t1.id ||
        (item.payload as Record<string, unknown>).recoveryTaskId === fixTaskId,
    )
    expect(originItems.length).toBeGreaterThanOrEqual(1)
  })

  it('does not launch a rescue task when a recovery cannot find its origin worktree', async () => {
    const { q, ft, rs, pub, client } = await loadModules(repo)
    const origin = await q.enqueueTask('implement feature Z', undefined, {
      skipTriage: true,
    })
    const recovery = await ft.upsertFixTask({
      sourceTaskId: origin.id,
      failureSignature: 'verify/no-commits-ahead',
      failingStep: 'verify:has-diff',
      truncatedError: 'no commits ahead of integration branch',
      branch: null,
      recipeContext: {
        targetPath: '',
        statusOutput: 'no commits ahead',
        targetBranch: 'main',
        originalPrompt: origin.prompt,
      },
    })

    await q.updateTask(recovery.fixTaskId, {
      status: 'failed',
      failedPhase: 'code',
      failureReason: 'setup:origin-worktree-missing',
      error: 'origin worktree is missing',
    })
    await rs.ensureRecoverySpawner(client)
    await publish(pub, client, 'task.failed', {
      taskId: recovery.fixTaskId,
      error: 'origin worktree is missing',
    })

    await rs.drainRecoverySpawner(client)

    const followUps = await client.execute({
      sql: `SELECT id FROM tasks WHERE id NOT IN (?, ?)`,
      args: [origin.id, recovery.fixTaskId],
    })
    expect(followUps.rows).toHaveLength(0)
  })

  it('requeues the origin task and spares the recovery slot when the circuit breaker is open', async () => {
    const { q, cb, rs, pub, client } = await loadModules(repo)

    const t1 = await q.enqueueTask('implement feature amid outage', undefined, {
      skipTriage: true,
    })
    const worktreePath = resolve(repo, '.mars', 'worktrees', t1.id)
    mkdirSync(worktreePath, { recursive: true })
    await q.updateTask(t1.id, {
      branch: `task/${t1.id}`,
      worktreePath,
    })
    // Move the task to failed so the requeue is observable (status 'queued' → 'failed' → 'queued').
    await q.updateTask(t1.id, { status: 'failed', failedPhase: 'code', error: 'api connection refused' })

    // Trip the circuit breaker to signal an environmental API outage.
    cb.apiCircuitBreaker.open('ConnectionRefused')

    // Register subscriber after setup events so the cursor only sees the
    // manually published task.failed event below.
    await rs.ensureRecoverySpawner(client)
    await publish(pub, client, 'task.failed', {
      taskId: t1.id,
      error: 'api connection refused',
    })

    const { processed } = await rs.drainRecoverySpawner(client)
    expect(processed).toBe(1)

    // No fix task should have been inserted — the recovery slot is spared.
    const fixRows = await client.execute({
      sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
      args: [t1.id],
    })
    expect(fixRows.rows).toHaveLength(0)

    // The origin task must be back to 'queued' so it can retry once the outage resolves.
    const reloaded = await q.getTask(t1.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('spawns a recovery task normally when the circuit breaker is closed', async () => {
    const { q, rc, rs, pub, client } = await loadModules(repo)

    const t1 = await q.enqueueTask('implement feature (no outage)', undefined, {
      skipTriage: true,
    })
    await q.updateTask(t1.id, {
      status: 'failed',
      failedPhase: 'verify',
      branch: `task/${t1.id}`,
      worktreePath: repo,
    })

    const signature = 'verify/no-commits-ahead'
    const cleanup = registerTestRecipe(rc, signature)

    // Circuit breaker is closed by default in a fresh module registry.
    await rs.ensureRecoverySpawner(client)
    await publish(pub, client, 'task.failed', {
      taskId: t1.id,
      error: 'no commits ahead of integration branch',
    })

    const { processed } = await rs.drainRecoverySpawner(client)
    expect(processed).toBe(1)

    // Exactly one recovery task should have been spawned.
    const fixRows = await client.execute({
      sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
      args: [t1.id],
    })
    expect(fixRows.rows).toHaveLength(1)

    // Origin should be blocked behind the recovery task.
    const reloaded = await q.getTask(t1.id)
    expect(reloaded?.status).toBe('blocked')

    cleanup()
  })

  it('skips recovery and raises a failed action-queue item when spend-control suppressRecovery is true', async () => {
    const { q, aq, rs, pub, client, sc } = await loadModules(repo)

    // Enable the operator suppress-recovery lever.
    await sc.upsertSpendControl(client, { suppressRecovery: true })

    const t1 = await q.enqueueTask('feature with suppressed recovery', undefined, {
      skipTriage: true,
    })
    const worktreePath = resolve(repo, '.mars', 'worktrees', t1.id)
    mkdirSync(worktreePath, { recursive: true })
    await q.updateTask(t1.id, {
      branch: `task/${t1.id}`,
      worktreePath,
    })
    // Pre-set to failed (mirrors production: the event is emitted FROM the
    // status transition to failed, so the task is already failed at drain time).
    await q.updateTask(t1.id, {
      status: 'failed',
      failedPhase: 'verify',
      error: 'no commits ahead of integration branch',
    })

    await rs.ensureRecoverySpawner(client)
    await publish(pub, client, 'task.failed', {
      taskId: t1.id,
      error: 'no commits ahead of integration branch',
    })

    const { processed } = await rs.drainRecoverySpawner(client)
    expect(processed).toBe(1)

    // No fix/recovery task should have been spawned.
    const fixRows = await client.execute({
      sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
      args: [t1.id],
    })
    expect(fixRows.rows).toHaveLength(0)

    // Origin task stays failed (not blocked).
    const reloaded = await q.getTask(t1.id)
    expect(reloaded?.status).toBe('failed')

    // An action-queue item citing spend-control suppression must be open.
    const items = await aq.listActionQueueItems('open')
    const suppressed = items.filter(
      (item) =>
        (item.payload as Record<string, unknown>).suppressedBy === 'spend-control' &&
        (item.payload as Record<string, unknown>).taskId === t1.id,
    )
    expect(suppressed.length).toBeGreaterThanOrEqual(1)
  })

  it('spawns a recovery task normally when spend-control suppressRecovery is false (default)', async () => {
    const { q, rc, rs, pub, client } = await loadModules(repo)

    const t1 = await q.enqueueTask('feature with allowed recovery', undefined, {
      skipTriage: true,
    })
    // Default spend-control levers have suppressRecovery=false; no upsert needed.
    await q.updateTask(t1.id, {
      status: 'failed',
      failedPhase: 'verify',
      branch: `task/${t1.id}`,
      worktreePath: repo,
    })

    const signature = 'verify/no-commits-ahead'
    const cleanup = registerTestRecipe(rc, signature)

    await rs.ensureRecoverySpawner(client)
    await publish(pub, client, 'task.failed', {
      taskId: t1.id,
      error: 'no commits ahead of integration branch',
    })

    const { processed } = await rs.drainRecoverySpawner(client)
    expect(processed).toBe(1)

    // A fix task must have been spawned (not suppressed).
    const fixRows = await client.execute({
      sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
      args: [t1.id],
    })
    expect(fixRows.rows).toHaveLength(1)

    cleanup()
  })
})

// ---------------------------------------------------------------------------
// Gate meta-monitor: K identical verify-gate verdicts across DIFFERENT tasks
// raise ONE level-triggered row and suppress recovery for that verdict without
// consuming the origin's one recovery slot (draft proposal acd01d23).
// ---------------------------------------------------------------------------

describe.skip('legacy verify-gate verdict suppression', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  // The verify primitive stamps the fine-grained failing step on
  // `failure_reason` (`verify:<gate>`) and the verdict on `failure_signature`
  // (`verify:<gate>/<class>`), and the `status='failed'` transition itself emits
  // the durable `task.failed` event the recovery-spawn subscriber drains. So a
  // test simulating a verify-gate failure just sets those fields via the same
  // `updateTask` transition, then drains — exactly the production choreography.
  const VERIFY_STEP = 'verify:completeness'
  const GATE_ERROR = 'no commits ahead of integration branch' // → class 'no-commits-ahead'
  const VERDICT = 'verify:completeness/no-commits-ahead'

  /**
   * Fail a fresh origin task through a verify gate carrying the shared verdict,
   * then run the subscriber drain. The caller MUST have already registered the
   * subscriber (via `rs.ensureRecoverySpawner`) so the cursor tails from before
   * the first failure — otherwise a subscriber registered mid-stream skips the
   * `task.failed` event emitted by this task's `failed` transition. Returns the
   * origin task id.
   */
  const failOneVerifyGateTask = async (
    loaded: Loaded,
    index: number,
  ): Promise<string> => {
    const { q, rs, client } = loaded
    const t = await q.enqueueTask(`gate task ${index}`, undefined, {
      skipTriage: true,
    })
    // The `queued → failed` transition emits the durable task.failed event.
    await q.updateTask(t.id, {
      status: 'failed',
      failedPhase: 'verify',
      failureReason: VERIFY_STEP,
      failureSignature: VERDICT,
      error: GATE_ERROR,
      branch: `task/${t.id}`,
      worktreePath: repo,
    })
    await rs.drainRecoverySpawner(client)
    return t.id
  }

  const countFixTasksFor = async (
    client: DbClient,
    originId: string,
  ): Promise<number> => {
    const r = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [originId],
    })
    return Number((r.rows[0] as unknown as { n: number }).n)
  }

  const countGateBrokenRows = async (aq: ActionQueueModule): Promise<number> => {
    const items = await aq.listActionQueueItems('open')
    return items.filter((i) => (i as { kind?: string }).kind === 'gate-broken')
      .length
  }

  it('trips at K identical verdicts across different tasks and raises exactly ONE gate-broken row', async () => {
    const loaded = await loadModules(repo)
    const { rs, gm, aq, client } = loaded
    const K = gm.GATE_VERDICT_TRIP_THRESHOLD
    // Register the subscriber's cursor before any task fails so every
    // task.failed transition below is drained.
    await rs.ensureRecoverySpawner(client)

    // Below the threshold: no trip, no row, verdict not yet suppressed.
    for (let i = 0; i < K - 1; i++) {
      await failOneVerifyGateTask(loaded, i)
    }
    expect(await countGateBrokenRows(aq)).toBe(0)
    expect(await gm.isVerdictSuppressed(client, VERDICT)).toBe(false)

    // The K-th identical verdict (a DIFFERENT task) trips the monitor.
    await failOneVerifyGateTask(loaded, K - 1)
    expect(await gm.isVerdictSuppressed(client, VERDICT)).toBe(true)
    expect(await countGateBrokenRows(aq)).toBe(1)

    // Further identical failures do NOT raise a second row (idempotent episode).
    await failOneVerifyGateTask(loaded, K)
    await failOneVerifyGateTask(loaded, K + 1)
    expect(await countGateBrokenRows(aq)).toBe(1)
  })

  it('does not advance the streak when the SAME task fails the same gate repeatedly', async () => {
    const loaded = await loadModules(repo)
    const { q, rs, pub, gm, aq, client } = loaded
    const K = gm.GATE_VERDICT_TRIP_THRESHOLD

    const t = await q.enqueueTask('single repeat-failing task', undefined, {
      skipTriage: true,
    })
    await q.updateTask(t.id, {
      status: 'failed',
      failedPhase: 'verify',
      failureReason: VERIFY_STEP,
      failureSignature: VERDICT,
      error: GATE_ERROR,
    })
    await rs.ensureRecoverySpawner(client)

    // Publish the SAME task's failure K+2 times. Because the monitor advances
    // only on a DIFFERENT task id, the streak never passes 1 and never trips.
    for (let i = 0; i < K + 2; i++) {
      await publish(pub, client, 'task.failed', { taskId: t.id, error: GATE_ERROR })
      await rs.drainRecoverySpawner(client)
    }

    expect(await gm.isVerdictSuppressed(client, VERDICT)).toBe(false)
    expect(await countGateBrokenRows(aq)).toBe(0)
  })

  it('suppresses recovery for the tripped verdict, leaving the origin failed-and-restartable with its recovery slot unconsumed', async () => {
    const loaded = await loadModules(repo)
    const { q, rs, gm, client } = loaded
    const K = gm.GATE_VERDICT_TRIP_THRESHOLD
    await rs.ensureRecoverySpawner(client)

    // Trip the monitor with K-1 genuine failures (each may spawn a recovery).
    for (let i = 0; i < K - 1; i++) {
      await failOneVerifyGateTask(loaded, i)
    }
    // The K-th trips + is itself suppressed.
    const trippedId = await failOneVerifyGateTask(loaded, K - 1)
    expect(await gm.isVerdictSuppressed(client, VERDICT)).toBe(true)

    // The tripping task consumed NO recovery slot: zero fix tasks point at it,
    // and it is left `failed` (restartable via `mars restart`), not `blocked`
    // behind a spawned-and-doomed recovery.
    expect(await countFixTasksFor(client, trippedId)).toBe(0)
    const tripped = await q.getTask(trippedId)
    expect(tripped?.status).toBe('failed')
    expect(tripped?.failureReason).toBe(`gate-suppressed:${VERDICT}`)

    // A brand-new task carrying the now-suppressed verdict is ALSO suppressed:
    // failed, no fix task, no task_blockers edge.
    const laterId = await failOneVerifyGateTask(loaded, K)
    expect(await countFixTasksFor(client, laterId)).toBe(0)
    const later = await q.getTask(laterId)
    expect(later?.status).toBe('failed')
    const edges = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ?`,
      args: [laterId],
    })
    expect(Number((edges.rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  it('does not feed the monitor for non-verify failures (a code-phase failure never trips it)', async () => {
    const loaded = await loadModules(repo)
    const { q, rs, gm, aq, client } = loaded
    const K = gm.GATE_VERDICT_TRIP_THRESHOLD

    await rs.ensureRecoverySpawner(client)
    // K+1 distinct tasks failing in the CODE phase (failure_reason has no
    // `verify:` prefix) must not trip the gate monitor.
    for (let i = 0; i < K + 1; i++) {
      const t = await q.enqueueTask(`code-fail task ${i}`, undefined, {
        skipTriage: true,
      })
      await q.updateTask(t.id, {
        status: 'failed',
        failedPhase: 'code',
        failureReason: 'code',
        error: 'agent bailed without committing',
      })
      await rs.drainRecoverySpawner(client)
    }

    expect(await countGateBrokenRows(aq)).toBe(0)
    // The verify verdict is untouched.
    expect(await gm.isVerdictSuppressed(client, VERDICT)).toBe(false)
  })
})
