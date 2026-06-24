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
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

    const detection = { dirty: true as const, hash: 'aa'.repeat(32), episodeHash: null, statusOutput: '' }
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
      detection: { dirty: true, hash: 'bb'.repeat(32), episodeHash: null, statusOutput: '' },
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

  it('supersedes actionQueue rows for previously-failed committers at DIFFERENT hashes', async () => {
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const { spawnOrAttachMainCommitter, nullTraceStore } = await (async () => {
      const m = await import('../../lib/main-dirty')
      const r = await import('../../lib/run-tool')
      return { ...m, nullTraceStore: r.nullTraceStore }
    })()
    // Old failed committer at hash A.
    const oldSrc = await queue.enqueueTask('old', undefined, {
      skipTriage: true,
    })
    const old = await spawnOrAttachMainCommitter({
      sourceTaskId: oldSrc.id,
      detection: { dirty: true, hash: 'a'.repeat(64), episodeHash: null, statusOutput: '' },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: oldSrc.id,
      traceStore: nullTraceStore,
    })
    await queue.updateTask(old.fixTaskId, {
      status: 'failed',
      error: 'old committer failed',
    })
    const { raiseAggregatedMainCommiterFailureRow } = await import(
      '../main-dirty-action-queue'
    )
    const oldActionQueueId = await raiseAggregatedMainCommiterFailureRow(
      old.fixTaskId,
      noopLog,
    )
    expect(oldActionQueueId).toBeTruthy()

    // Fresh committer succeeds at hash B.
    const newSrc = await queue.enqueueTask('new', undefined, {
      skipTriage: true,
    })
    const fresh = await spawnOrAttachMainCommitter({
      sourceTaskId: newSrc.id,
      detection: { dirty: true, hash: 'b'.repeat(64), episodeHash: null, statusOutput: '' },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: newSrc.id,
      traceStore: nullTraceStore,
    })

    const { sweepStaleFailedMainCommiterActionQueue } = await import(
      '../main-dirty-action-queue'
    )
    await sweepStaleFailedMainCommiterActionQueue(
      'b'.repeat(64),
      fresh.fixTaskId,
      noopLog,
    )

    const actionQueue = await import('../../lib/action-queue')
    const item = await actionQueue.getActionQueueItem(oldActionQueueId!)
    expect(item!.state).toBe('resolved')
  })

  it('leaves an actionQueue row alone when its hash matches the fresh hash', async () => {
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const { spawnOrAttachMainCommitter, nullTraceStore } = await (async () => {
      const m = await import('../../lib/main-dirty')
      const r = await import('../../lib/run-tool')
      return { ...m, nullTraceStore: r.nullTraceStore }
    })()
    const src = await queue.enqueueTask('same-hash', undefined, {
      skipTriage: true,
    })
    const c = await spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection: { dirty: true, hash: 'c'.repeat(64), episodeHash: null, statusOutput: '' },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src.id,
      traceStore: nullTraceStore,
    })
    await queue.updateTask(c.fixTaskId, {
      status: 'failed',
      error: 'committer failed',
    })
    const { raiseAggregatedMainCommiterFailureRow } = await import(
      '../main-dirty-action-queue'
    )
    const actionQueueId = await raiseAggregatedMainCommiterFailureRow(
      c.fixTaskId,
      noopLog,
    )
    expect(actionQueueId).toBeTruthy()

    const { sweepStaleFailedMainCommiterActionQueue } = await import(
      '../main-dirty-action-queue'
    )
    // Sweep with the SAME hash — must NOT resolve the row.
    await sweepStaleFailedMainCommiterActionQueue(
      'c'.repeat(64),
      'unrelated-fresh',
      noopLog,
    )

    const actionQueue = await import('../../lib/action-queue')
    const item = await actionQueue.getActionQueueItem(actionQueueId!)
    expect(item!.state).toBe('open')
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
    const detection = { dirty: true as const, hash: 'ab'.repeat(32), episodeHash: null, statusOutput: '' }

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

    // Release dependents.
    const { releaseMainCommitterDependents } = await import('../main-dirty-action-queue')
    await releaseMainCommitterDependents(res.fixTaskId, noopLog)

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
      detection: { dirty: true, hash: 'cd'.repeat(32), episodeHash: null, statusOutput: '' },
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

    // Fail the committer and release.
    await queue.updateTask(res.fixTaskId, { status: 'failed', error: 'oops' })
    const { releaseMainCommitterDependents } = await import('../main-dirty-action-queue')
    await releaseMainCommitterDependents(res.fixTaskId, noopLog)

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

  it('newly-enqueued task is NOT permanently blocked on a failed committer at the same hash', async () => {
    // This is the regression test for the reported deadlock:
    // A failed committer must not poison-pill fresh tasks at dispatch time.
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const { spawnOrAttachMainCommitter, nullTraceStore } = await (async () => {
      const m = await import('../../lib/main-dirty')
      const r = await import('../../lib/run-tool')
      return { ...m, nullTraceStore: r.nullTraceStore }
    })()

    const detection = { dirty: true as const, hash: 'ef'.repeat(32), episodeHash: null, statusOutput: '' }

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

    // Now a NEW task T2 dispatches against the same dirty hash.
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
    const detection = { dirty: true as const, hash: 'ff'.repeat(32), episodeHash: null, statusOutput: 'M some-file.ts' }
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

    const detection = { dirty: true as const, hash: 'ee'.repeat(32), episodeHash: null, statusOutput: 'M dirty.ts' }
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
