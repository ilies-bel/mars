/**
 * Slice F.2 actionQueue-side tests:
 *  - aggregated actionQueue row on committer failure lists every blocked dependent.
 *  - on committer success, stale failed-committer actionQueue rows (at a DIFFERENT
 *    hash) get superseded.
 *  - releaseMainCommitterDependents re-queues tasks blocked on a dead committer.
 *  - Regression (mars-4d66145d): main-committer done must NOT mark origin done
 *    or cascade-unblock dependents; source task must be re-queued instead.
 *
 * Pattern follows the existing F.1 blocker-invariant tests: a temp repo and
 * a per-test reset of the queue/actionQueue singletons via `vi.resetModules()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-main-dirty-action-queue-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const noopLog = (): void => {}

describe('raiseAggregatedMainCommiterFailureRow', () => {
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

  it('lists every blocked dependent in the body and titles the cohort count', async () => {
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const { spawnOrAttachMainCommitter, nullTraceStore } = await (async () => {
      const m = await import('../../lib/main-dirty')
      const r = await import('../../lib/run-tool')
      return { ...m, nullTraceStore: r.nullTraceStore }
    })()

    const src1 = await queue.enqueueTask('first dependent', undefined, {
      skipTriage: true,
    })
    const src2 = await queue.enqueueTask('second dependent', undefined, {
      skipTriage: true,
    })

    const detection = { dirty: true as const, statusOutput: '' }
    const resolution = await spawnOrAttachMainCommitter({
      sourceTaskId: src1.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src1.id,
      traceStore: nullTraceStore,
    })
    await spawnOrAttachMainCommitter({
      sourceTaskId: src2.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'verify',
      recipePrompt: 'p',
      sourceOriginId: src2.id,
      traceStore: nullTraceStore,
    })

    const { raiseAggregatedMainCommiterFailureRow } = await import(
      '../main-dirty-action-queue'
    )
    const actionQueueItemId = await raiseAggregatedMainCommiterFailureRow(
      resolution.fixTaskId,
      noopLog,
    )
    expect(actionQueueItemId).toBeTruthy()

    const actionQueue = await import('../../lib/action-queue')
    const item = await actionQueue.getActionQueueItem(actionQueueItemId!)
    expect(item).not.toBeNull()
    expect(item!.kind).toBe('failed')
    expect(item!.priority).toBe('high')
    expect(item!.title).toMatch(/2 tasks blocked/)
    expect(item!.body).toContain(src1.id)
    expect(item!.body).toContain(src2.id)
    expect(item!.body).toContain('first dependent')
    expect(item!.body).toContain('second dependent')
  })

  it('handles a committer with zero current dependents (cleared by other paths)', async () => {
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const { spawnOrAttachMainCommitter, nullTraceStore } = await (async () => {
      const m = await import('../../lib/main-dirty')
      const r = await import('../../lib/run-tool')
      return { ...m, nullTraceStore: r.nullTraceStore }
    })()
    const src = await queue.enqueueTask('a', undefined, { skipTriage: true })
    const resolution = await spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection: { dirty: true, statusOutput: '' },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src.id,
      traceStore: nullTraceStore,
    })
    // Simulate the dependent being unblocked by another path: drop the edge.
    const c = queue.resolveQueueClient()
    await c.execute({
      sql: `DELETE FROM task_blockers WHERE blocker_task_id = ?`,
      args: [resolution.fixTaskId],
    })

    const { raiseAggregatedMainCommiterFailureRow } = await import(
      '../main-dirty-action-queue'
    )
    const id = await raiseAggregatedMainCommiterFailureRow(
      resolution.fixTaskId,
      noopLog,
    )
    expect(id).toBeTruthy()
    const actionQueue = await import('../../lib/action-queue')
    const item = await actionQueue.getActionQueueItem(id!)
    expect(item!.title).toMatch(/no tasks currently blocked/i)
  })
})

describe('sweepStaleFailedMainCommiterActionQueue', () => {
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

  it('resolves both stale rows when two failed committers on main are superseded by a succeeding committer on main', async () => {
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const { spawnOrAttachMainCommitter, nullTraceStore } = await (async () => {
      const m = await import('../../lib/main-dirty')
      const r = await import('../../lib/run-tool')
      return { ...m, nullTraceStore: r.nullTraceStore }
    })()
    const { raiseAggregatedMainCommiterFailureRow, sweepStaleFailedMainCommiterActionQueue } =
      await import('../main-dirty-action-queue')

    // First failed committer on main.
    const src1 = await queue.enqueueTask('first task', undefined, { skipTriage: true })
    const old1 = await spawnOrAttachMainCommitter({
      sourceTaskId: src1.id,
      detection: { dirty: true, statusOutput: '' },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src1.id,
      traceStore: nullTraceStore,
    })
    await queue.updateTask(old1.fixTaskId, { status: 'failed', error: 'first committer failed' })
    const oldId1 = await raiseAggregatedMainCommiterFailureRow(old1.fixTaskId, noopLog)
    expect(oldId1).toBeTruthy()

    // Second failed committer on main (first having already failed).
    const src2 = await queue.enqueueTask('second task', undefined, { skipTriage: true })
    const old2 = await spawnOrAttachMainCommitter({
      sourceTaskId: src2.id,
      detection: { dirty: true, statusOutput: '' },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src2.id,
      traceStore: nullTraceStore,
    })
    await queue.updateTask(old2.fixTaskId, { status: 'failed', error: 'second committer failed' })
    const oldId2 = await raiseAggregatedMainCommiterFailureRow(old2.fixTaskId, noopLog)
    expect(oldId2).toBeTruthy()

    // Fresh committer on main succeeds.
    const src3 = await queue.enqueueTask('third task', undefined, { skipTriage: true })
    const fresh = await spawnOrAttachMainCommitter({
      sourceTaskId: src3.id,
      detection: { dirty: true, statusOutput: '' },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src3.id,
      traceStore: nullTraceStore,
    })

    await sweepStaleFailedMainCommiterActionQueue('main', fresh.fixTaskId, noopLog)

    const actionQueue = await import('../../lib/action-queue')
    const item1 = await actionQueue.getActionQueueItem(oldId1!)
    const item2 = await actionQueue.getActionQueueItem(oldId2!)
    expect(item1!.state).toBe('resolved')
    expect(item2!.state).toBe('resolved')
  })

  it('leaves a failed committer on release-2026-01 untouched when a committer on main succeeds', async () => {
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const { spawnOrAttachMainCommitter, nullTraceStore } = await (async () => {
      const m = await import('../../lib/main-dirty')
      const r = await import('../../lib/run-tool')
      return { ...m, nullTraceStore: r.nullTraceStore }
    })()
    const { raiseAggregatedMainCommiterFailureRow, sweepStaleFailedMainCommiterActionQueue } =
      await import('../main-dirty-action-queue')

    // Failed committer on the release branch.
    const releaseSrc = await queue.enqueueTask('release task', undefined, { skipTriage: true })
    const releaseCommitter = await spawnOrAttachMainCommitter({
      sourceTaskId: releaseSrc.id,
      detection: { dirty: true, statusOutput: '' },
      integrationBranch: 'release-2026-01',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: releaseSrc.id,
      traceStore: nullTraceStore,
    })
    await queue.updateTask(releaseCommitter.fixTaskId, { status: 'failed', error: 'release committer failed' })
    const releaseActionQueueId = await raiseAggregatedMainCommiterFailureRow(
      releaseCommitter.fixTaskId,
      noopLog,
    )
    expect(releaseActionQueueId).toBeTruthy()

    // Fresh committer on main succeeds.
    const mainSrc = await queue.enqueueTask('main task', undefined, { skipTriage: true })
    const mainFresh = await spawnOrAttachMainCommitter({
      sourceTaskId: mainSrc.id,
      detection: { dirty: true, statusOutput: '' },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: mainSrc.id,
      traceStore: nullTraceStore,
    })

    // Sweep only main — must not touch the release-2026-01 row.
    await sweepStaleFailedMainCommiterActionQueue('main', mainFresh.fixTaskId, noopLog)

    const actionQueue = await import('../../lib/action-queue')
    const releaseItem = await actionQueue.getActionQueueItem(releaseActionQueueId!)
    expect(releaseItem!.state).toBe('open')
  })
})

// ---------------------------------------------------------------------------
// releaseMainCommitterDependents: blocked dependents are re-queued on failure
// ---------------------------------------------------------------------------

describe('releaseMainCommitterDependents', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-release-committer-test-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    mkdirSync(resolve(repo, '.mars'), { recursive: true })
    // Create an initial commit with a .gitignore so `git status --porcelain`
    // returns clean output by default. The releaseMainCommitterDependents guard
    // checks git status before deciding whether to release dependents; tests
    // that want a "clean" main rely on this baseline.
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
    writeFileSync(resolve(repo, '.gitignore'), '.mars/\n')
    execFileSync('git', ['add', '.gitignore'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('re-queues tasks blocked on the failed committer', async () => {
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const { spawnOrAttachMainCommitter, nullTraceStore } = await (async () => {
      const m = await import('../../lib/main-dirty')
      const r = await import('../../lib/run-tool')
      return { ...m, nullTraceStore: r.nullTraceStore }
    })()

    const src1 = await queue.enqueueTask('task-one', undefined, { skipTriage: true })
    const src2 = await queue.enqueueTask('task-two', undefined, { skipTriage: true })
    const detection = { dirty: true as const, statusOutput: '' }

    const res = await spawnOrAttachMainCommitter({
      sourceTaskId: src1.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit the mess',
      sourceOriginId: src1.id,
      traceStore: nullTraceStore,
    })
    await spawnOrAttachMainCommitter({
      sourceTaskId: src2.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit the mess',
      sourceOriginId: src2.id,
      traceStore: nullTraceStore,
    })

    // Both tasks are now blocked on the committer.
    expect((await queue.getTask(src1.id))?.status).toBe('blocked')
    expect((await queue.getTask(src2.id))?.status).toBe('blocked')

    // Fail the committer.
    await queue.updateTask(res.fixTaskId, { status: 'failed', error: 'verify failed' })

    // Release dependents. Main is clean (no uncommitted changes after initial
    // commit), so the git-status guard passes and dependents are re-queued.
    const { releaseMainCommitterDependents } = await import('../main-dirty-action-queue')
    await releaseMainCommitterDependents(res.fixTaskId, noopLog, repo)

    // Both tasks must now be queued.
    expect((await queue.getTask(src1.id))?.status).toBe('queued')
    expect((await queue.getTask(src2.id))?.status).toBe('queued')

    // Blocker edges for the failed committer must be gone.
    const c = queue.resolveQueueClient()
    const edges = await c.execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE blocker_task_id = ?`,
      args: [res.fixTaskId],
    })
    expect(Number((edges.rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  it('leaves a task blocked when other active blockers remain', async () => {
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const { spawnOrAttachMainCommitter, nullTraceStore } = await (async () => {
      const m = await import('../../lib/main-dirty')
      const r = await import('../../lib/run-tool')
      return { ...m, nullTraceStore: r.nullTraceStore }
    })()

    // One task blocked on the committer AND an independent prerequisite.
    const src = await queue.enqueueTask('depends-on-two', undefined, { skipTriage: true })
    const prereq = await queue.enqueueTask('independent-prereq', undefined, { skipTriage: true })

    const res = await spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection: { dirty: true, statusOutput: '' },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src.id,
      traceStore: nullTraceStore,
    })
    // Add a second blocker directly.
    const c = queue.resolveQueueClient()
    await c.execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at)
            VALUES (?, ?, 'confirmed', datetime('now'))`,
      args: [src.id, prereq.id],
    })

    // Fail the committer and release. Main is clean, so the git-status guard
    // passes and Arc processes the edge removal (committer edge removed, prereq edge kept).
    await queue.updateTask(res.fixTaskId, { status: 'failed', error: 'oops' })
    const { releaseMainCommitterDependents } = await import('../main-dirty-action-queue')
    await releaseMainCommitterDependents(res.fixTaskId, noopLog, repo)

    // Task still blocked because the independent prereq is alive.
    expect((await queue.getTask(src.id))?.status).toBe('blocked')

    // Committer edge removed, prereq edge remains.
    const remaining = await c.execute({
      sql: `SELECT blocker_task_id FROM task_blockers WHERE task_id = ?`,
      args: [src.id],
    })
    const blockers = (remaining.rows as unknown as Array<{ blocker_task_id: string }>).map(
      (r) => r.blocker_task_id,
    )
    expect(blockers).not.toContain(res.fixTaskId)
    expect(blockers).toContain(prereq.id)
  })

  it('newly-enqueued task is NOT permanently blocked on a failed committer for the same branch', async () => {
    // This is the regression test for the reported deadlock:
    // A failed committer must not poison-pill fresh tasks at dispatch time.
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const { spawnOrAttachMainCommitter, nullTraceStore } = await (async () => {
      const m = await import('../../lib/main-dirty')
      const r = await import('../../lib/run-tool')
      return { ...m, nullTraceStore: r.nullTraceStore }
    })()

    const detection = { dirty: true as const, statusOutput: '' }

    // Task T1 triggers the first committer C1.
    const t1 = await queue.enqueueTask('first task', undefined, { skipTriage: true })
    const first = await spawnOrAttachMainCommitter({
      sourceTaskId: t1.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: t1.id,
      traceStore: nullTraceStore,
    })

    // C1 fails.
    await queue.updateTask(first.fixTaskId, { status: 'failed', error: 'commit failed' })

    // Now a NEW task T2 dispatches against the same dirty branch.
    const t2 = await queue.enqueueTask('second task', undefined, { skipTriage: true })
    const second = await spawnOrAttachMainCommitter({
      sourceTaskId: t2.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: t2.id,
      traceStore: nullTraceStore,
    })

    // T2 must NOT be blocked on the failed committer C1.
    expect(second.fixTaskId).not.toBe(first.fixTaskId)
    expect(second.spawned).toBe(true)

    // The edge from T2 to C1 must not exist.
    const c = queue.resolveQueueClient()
    const poisonEdge = await c.execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
      args: [t2.id, first.fixTaskId],
    })
    expect(Number((poisonEdge.rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Core invariant: dependents released ONLY when main is clean
  // -------------------------------------------------------------------------

  it('keeps dependents blocked when main is still dirty after committer failure', async () => {
    // Simulates the re-park loop scenario: committer fails, main is still dirty.
    // Releasing dependents now would re-dispatch them into the same dirty state
    // and spawn another committer, burning retry budgets until hard failure.
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const { spawnOrAttachMainCommitter, nullTraceStore } = await (async () => {
      const m = await import('../../lib/main-dirty')
      const r = await import('../../lib/run-tool')
      return { ...m, nullTraceStore: r.nullTraceStore }
    })()

    const src = await queue.enqueueTask('task-waiting-on-dirty-main', undefined, { skipTriage: true })
    const detection = { dirty: true as const, statusOutput: 'M leftover.ts' }
    const res = await spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit leftover',
      sourceOriginId: src.id,
      traceStore: nullTraceStore,
    })

    expect((await queue.getTask(src.id))?.status).toBe('blocked')

    // Fail the committer.
    await queue.updateTask(res.fixTaskId, { status: 'failed', error: 'install frozen-lockfile failed' })

    // Make main dirty: stage a file but don't commit (simulates leftover from a
    // previous failed worktree merge).
    writeFileSync(resolve(repo, 'leftover.ts'), 'uncommitted changes from prior run')
    execFileSync('git', ['add', 'leftover.ts'], { cwd: repo })

    // Attempt to release — the guard must detect dirty main and abort.
    const { releaseMainCommitterDependents } = await import('../main-dirty-action-queue')
    await releaseMainCommitterDependents(res.fixTaskId, noopLog, repo)

    // Dependent MUST remain blocked — releasing it would trigger the re-park loop.
    expect((await queue.getTask(src.id))?.status).toBe('blocked')

    // Blocker edge to the failed committer must still exist (not removed).
    const c = queue.resolveQueueClient()
    const edges = await c.execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE blocker_task_id = ?`,
      args: [res.fixTaskId],
    })
    expect(Number((edges.rows[0] as unknown as { n: number }).n)).toBe(1)
  })

  it('releases dependents when main is clean at the time of committer failure', async () => {
    // Simulates the case where a concurrent merge cleaned main before
    // releaseMainCommitterDependents runs: the guard finds main clean and
    // proceeds with the normal release path.
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const { spawnOrAttachMainCommitter, nullTraceStore } = await (async () => {
      const m = await import('../../lib/main-dirty')
      const r = await import('../../lib/run-tool')
      return { ...m, nullTraceStore: r.nullTraceStore }
    })()

    const src = await queue.enqueueTask('task-clean-main', undefined, { skipTriage: true })
    const detection = { dirty: true as const, statusOutput: '' }
    const res = await spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit the mess',
      sourceOriginId: src.id,
      traceStore: nullTraceStore,
    })

    expect((await queue.getTask(src.id))?.status).toBe('blocked')

    // Fail the committer; main is clean (no uncommitted files in repo).
    await queue.updateTask(res.fixTaskId, { status: 'failed', error: 'session-id collision' })

    // Verify main is actually clean before calling release.
    const { releaseMainCommitterDependents } = await import('../main-dirty-action-queue')
    await releaseMainCommitterDependents(res.fixTaskId, noopLog, repo)

    // Dependent must be re-queued: main is clean, release proceeds normally.
    expect((await queue.getTask(src.id))?.status).toBe('queued')

    // Blocker edge must be gone.
    const c = queue.resolveQueueClient()
    const edges = await c.execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE blocker_task_id = ?`,
      args: [res.fixTaskId],
    })
    expect(Number((edges.rows[0] as unknown as { n: number }).n)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Regression: mars-4d66145d — main-committer done must NOT mark source done
//
// When a main-committer (recipe='main-commiter') completes as 'done', the
// recovery-done-propagation reconciler previously called propagateRecoveryDone()
// which falsely flipped the source task to 'done' and cascade-unblocked its
// dependents. The fix skips propagation for main-committers and instead calls
// releaseMainCommitterDependents so the source task is re-queued to retry.
// ---------------------------------------------------------------------------

describe('main-committer done: source task re-queued, not marked done (mars-4d66145d)', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-mc-done-guard-test-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    mkdirSync(resolve(repo, '.mars'), { recursive: true })
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('re-queues the source task instead of marking it done when the main-committer completes', async () => {
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const { spawnOrAttachMainCommitter, nullTraceStore } = await (async () => {
      const m = await import('../../lib/main-dirty')
      const r = await import('../../lib/run-tool')
      return { ...m, nullTraceStore: r.nullTraceStore }
    })()

    // Source task is blocked on the main-committer (simulates dispatch:main-dirty)
    const src = await queue.enqueueTask('implement-license-slice-3', undefined, { skipTriage: true })
    const detection = { dirty: true as const, statusOutput: 'M some-file.ts' }
    const resolution = await spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit the dirty files',
      sourceOriginId: src.id,
      traceStore: nullTraceStore,
    })
    expect((await queue.getTask(src.id))?.status).toBe('blocked')

    // Main-committer "completes" (cleaned the branch, no slice code delivered)
    await queue.updateTask(resolution.fixTaskId, { status: 'done' })

    // Run the recovery-done-propagation reconciler step
    const { RECONCILERS } = await import('../reconcilers')
    const step = RECONCILERS.find((r) => r.name === 'recovery-done-propagation')!
    await step.run({ log: () => {}, bus: new EventEmitter(), traceStore: null, handleProposalSlice: null })

    // Source task MUST be re-queued so it can retry, NOT falsely marked done
    const srcAfter = await queue.getTask(src.id)
    expect(srcAfter?.status).toBe('queued')
    expect(srcAfter?.status).not.toBe('done')
  })

  it('does NOT cascade-unblock downstream tasks when main-committer completes (mars-4d66145d)', async () => {
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const { spawnOrAttachMainCommitter, nullTraceStore } = await (async () => {
      const m = await import('../../lib/main-dirty')
      const r = await import('../../lib/run-tool')
      return { ...m, nullTraceStore: r.nullTraceStore }
    })()

    // Source task (blocked on committer) with a downstream that should stay blocked
    const src = await queue.enqueueTask('implement-license-slice-3', undefined, { skipTriage: true })
    const downstream = await queue.enqueueTask('slice-9-ui', undefined, { skipTriage: true })

    // Wire downstream → src blocker edge
    const qc = queue.resolveQueueClient()
    await qc.execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at)
            VALUES (?, ?, 'confirmed', datetime('now'))`,
      args: [downstream.id, src.id],
    })
    await qc.execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [downstream.id],
    })

    const detection = { dirty: true as const, statusOutput: 'M dirty.ts' }
    const resolution = await spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'clean the branch',
      sourceOriginId: src.id,
      traceStore: nullTraceStore,
    })

    // Committer completes
    await queue.updateTask(resolution.fixTaskId, { status: 'done' })

    // Run reconciler step
    const { RECONCILERS } = await import('../reconcilers')
    const step = RECONCILERS.find((r) => r.name === 'recovery-done-propagation')!
    await step.run({ log: () => {}, bus: new EventEmitter(), traceStore: null, handleProposalSlice: null })

    // Source re-queued; downstream still blocked (its blocker src is now queued, not done)
    expect((await queue.getTask(src.id))?.status).toBe('queued')
    // Downstream must remain blocked — src hasn't delivered its work yet
    expect((await queue.getTask(downstream.id))?.status).toBe('blocked')
  })

  it('a regular (non-main-committer) fix task still marks the origin done', async () => {
    // Regression guard: ensure we didn't accidentally break the normal recovery path
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()

    const origin = await queue.enqueueTask('origin-task', undefined, { skipTriage: true })
    // Force origin to 'failed' (normal failure state before a recovery runs)
    await queue.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [origin.id],
    })

    // Create a regular fix task (no main-committer recovery_payload)
    const fixId = `fix-test-${Math.random().toString(36).slice(2, 10)}`
    const now = new Date().toISOString()
    await queue.resolveQueueClient().execute({
      sql: `INSERT INTO tasks (id, prompt, status, kind, fix_for_task_id, origin_id, priority, created_at, updated_at)
            VALUES (?, 'fix prompt', 'done', 'fix', ?, ?, 1, ?, ?)`,
      args: [fixId, origin.id, origin.id, now, now],
    })

    // Run the reconciler step
    const { RECONCILERS } = await import('../reconcilers')
    const step = RECONCILERS.find((r) => r.name === 'recovery-done-propagation')!
    await step.run({ log: () => {}, bus: new EventEmitter(), traceStore: null, handleProposalSlice: null })

    // Normal recovery MUST flip origin to done
    expect((await queue.getTask(origin.id))?.status).toBe('done')
  })
})
