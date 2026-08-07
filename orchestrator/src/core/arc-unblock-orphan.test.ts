import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  enqueueTask: typeof import('./queue').enqueueTask
  addBlockers: typeof import('./queue').addBlockers
  getTask: typeof import('./queue').getTask
  resolveQueueClient: typeof import('./queue').resolveQueueClient
  ensureQueueSchema: typeof import('./queue').ensureQueueSchema
}

interface ArcModule {
  Arc: typeof import('./arc').Arc
}

interface ActionQueueModule {
  listActionQueueItems: typeof import('./lib/action-queue').listActionQueueItems
}

interface BlockerResolutionModule {
  ORPHANED_ORIGIN_FAILURE_REASON: typeof import('./blocker-resolution').ORPHANED_ORIGIN_FAILURE_REASON
}

interface ProposalsModule {
  initProposals: typeof import('./proposals').initProposals
  createProposal: typeof import('./proposals').createProposal
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-orphan-origin-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; arc: ArcModule; actionQueue: ActionQueueModule; br: BlockerResolutionModule; proposals: ProposalsModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('./queue')) as unknown as QueueModule
  await q.ensureQueueSchema()
  const proposals = (await import('./proposals')) as unknown as ProposalsModule
  await proposals.initProposals()
  const arc = (await import('./arc')) as unknown as ArcModule
  const actionQueue = (await import('./lib/action-queue')) as unknown as ActionQueueModule
  const br = (await import('./blocker-resolution')) as unknown as BlockerResolutionModule
  return { q, arc, actionQueue, br, proposals }
}

const blockTask = async (
  q: QueueModule,
  taskId: string,
  blockerTaskId: string,
  recoverySpawnedCount = 0,
): Promise<void> => {
  await q.addBlockers(taskId, [blockerTaskId])
  await q.resolveQueueClient().execute({
    sql: `UPDATE tasks SET status = 'blocked', recovery_spawned_count = ? WHERE id = ?`,
    args: [recoverySpawnedCount, taskId],
  })
}

describe('Arc.unblockByCompletion — orphaned origin guard', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  it('fails a dependent whose origin no longer exists instead of re-queuing it', async () => {
    // Scenario:
    //   O  — original origin task (will be purged from tasks table)
    //   D  — dependent task with origin_id = O.id
    //   B  — blocker for D (completes and triggers the cascade)
    //
    // When B completes, Arc.unblockByCompletion walks D. D's origin_id points
    // at O, but O was deleted. D must be failed (ORPHANED_ORIGIN) — not queued.

    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, arc, actionQueue, br } = await loadModules(repo)

    // Create O, B, and D (D has origin_id = O.id).
    const O = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    const B = await q.enqueueTask('blocker task', undefined, { skipTriage: true })
    const D = await q.enqueueTask('dependent task', undefined, {
      skipTriage: true,
      originId: O.id,
    })

    // Block D on B.
    await blockTask(q, D.id, B.id, 0)

    // Purge O from the tasks table — no FK constraint on origin_id, so this
    // succeeds and leaves D with a dangling origin_id reference.
    await q.resolveQueueClient().execute({
      sql: `DELETE FROM tasks WHERE id = ?`,
      args: [O.id],
    })

    // Confirm O is gone.
    expect(await q.getTask(O.id)).toBeNull()

    // Mark B done via raw SQL to bypass auto-promote, so only
    // Arc.unblockByCompletion drives the cascade.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [B.id],
    })

    // Drive the cascade.
    const result = await arc.Arc.unblockByCompletion(B.id)

    // D must be failed, not queued.
    const reloaded = await q.getTask(D.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failureReason).toBe(br.ORPHANED_ORIGIN_FAILURE_REASON)

    // The outcome list must record a 'failed' result for D.
    expect(result.outcomes).toHaveLength(1)
    expect(result.outcomes[0].taskId).toBe(D.id)
    expect(result.outcomes[0].outcome).toBe('failed')
    expect(result.outcomes[0].failureReason).toBe(br.ORPHANED_ORIGIN_FAILURE_REASON)

    // Exactly one action-queue item naming both D and O must be present.
    const open = await actionQueue.listActionQueueItems('open')
    const orphanItems = open.filter(
      (i) =>
        i.kind === 'orphaned-origin' &&
        (i.payload as Record<string, unknown>).taskId === D.id &&
        (i.payload as Record<string, unknown>).originId === O.id,
    )
    expect(orphanItems).toHaveLength(1)

    // Zero task.unblocked events must have been written for D.
    const events = await q.resolveQueueClient().execute({
      sql: `SELECT payload FROM events WHERE type = 'task.unblocked'`,
      args: [],
    })
    const unblockedForD = events.rows.filter((row) => {
      try {
        const p = JSON.parse((row as Record<string, unknown>).payload as string) as {
          taskId: string
        }
        return p.taskId === D.id
      } catch {
        return false
      }
    })
    expect(unblockedForD).toHaveLength(0)
  })

  it('still re-queues a dependent whose origin is itself (self-origin arc root)', async () => {
    // Regression guard: a self-origin dependent (origin_id = id) must NOT be
    // treated as orphaned even though origin_id === id means no separate origin row.

    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, arc } = await loadModules(repo)

    const B = await q.enqueueTask('blocker', undefined, { skipTriage: true })
    // D enqueued without explicit originId → defaults to its own id (self-origin).
    const D = await q.enqueueTask('dependent', undefined, { skipTriage: true })

    await blockTask(q, D.id, B.id, 0)
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [B.id],
    })

    const result = await arc.Arc.unblockByCompletion(B.id)

    const reloaded = await q.getTask(D.id)
    expect(reloaded?.status).toBe('queued')
    expect(result.outcomes[0].outcome).toBe('queued')
  })

  it('re-queues a sliced task whose origin_id is a valid proposal id (not orphaned)', async () => {
    // Regression guard for the false-positive: tasks produced by
    // `mars proposal slice` carry origin_id = proposal_id. The proposals table
    // has no FK in the tasks schema, so getTask(origin_id) returns null —
    // but that must NOT trigger the orphaned-origin guard. The task must be
    // re-queued, not failed.

    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, arc, proposals } = await loadModules(repo)

    // Create a proposal; its id becomes the origin for the sliced task.
    const proposal = await proposals.createProposal('group the task detail step timeline', {
      source: 'human',
    })

    const B = await q.enqueueTask('blocker task', undefined, { skipTriage: true })
    // D is a slice of the proposal: origin_id = proposal.id (not a task id).
    const D = await q.enqueueTask('sliced dependent task', undefined, {
      skipTriage: true,
      originId: proposal.id,
    })

    await blockTask(q, D.id, B.id, 0)
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [B.id],
    })

    const result = await arc.Arc.unblockByCompletion(B.id)

    // D must be queued (proposal origin is valid), NOT failed with orphaned-origin.
    const reloaded = await q.getTask(D.id)
    expect(reloaded?.status).toBe('queued')
    expect(result.outcomes).toHaveLength(1)
    expect(result.outcomes[0].taskId).toBe(D.id)
    expect(result.outcomes[0].outcome).toBe('queued')
  })
})
