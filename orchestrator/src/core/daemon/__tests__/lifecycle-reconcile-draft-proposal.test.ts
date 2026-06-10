/**
 * Regression test for the boot-time reconcile bug where clause (b) of
 * reconcileTerminalTasks was incorrectly resolving every open draft-proposal
 * action-queue row because their origin_task_id is a proposal id (absent from
 * the tasks table), not a task id.
 *
 * Fix: clause (b) now excludes kind = 'draft-proposal' from the orphan sweep.
 * Draft-proposal rows are evicted by the per-event path in
 * action-queue-repopulator (proposal.promoted / dismissed / deleted).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Client } from '@libsql/client'

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
}

interface ActionQueueModule {
  initActionQueue: typeof import('../../lib/action-queue').initActionQueue
  raiseActionQueueItem: typeof import('../../lib/action-queue').raiseActionQueueItem
  getActionQueueItem: typeof import('../../lib/action-queue').getActionQueueItem
}

interface ReconcileModule {
  reconcileTerminalTasks: typeof import('../lifecycle-reconcile').reconcileTerminalTasks
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-lifecycle-draft-proposal-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  await actionQueue.initActionQueue()
  const reconcile = (await import('../lifecycle-reconcile')) as unknown as ReconcileModule
  return { q, actionQueue, reconcile }
}

const insertProposal = async (client: Client, id: string): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO proposals (id, title, status, source, created_at, updated_at)
          VALUES (?, ?, 'draft', 'human', ?, ?)`,
    args: [id, `Proposal ${id}`, Date.now(), Date.now()],
  })
}

describe('reconcileTerminalTasks — draft-proposal rows are not swept as purged-task residue', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('leaves a draft-proposal row open when its origin_task_id is a live proposal id', async () => {
    const { q, actionQueue, reconcile } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Seed: a proposal in the proposals table (not in tasks).
    const proposalId = 'prop-live-draft-001'
    await insertProposal(client, proposalId)

    // Seed: open draft-proposal action-queue row keyed to that proposal.
    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'draft-proposal',
      category: 'user',
      priority: 'normal',
      title: `Draft proposal: Live draft`,
      body: `Proposal ${proposalId} is ready for review.`,
      payload: { proposalId, source: 'human' },
      context: {},
      raisedBy: 'test',
      signature: proposalId,
      originTaskId: proposalId,
    })

    // --- RUN ---
    const { rowsResolved } = await reconcile.reconcileTerminalTasks(client)

    // The draft-proposal row must remain open — the proposal is live.
    const item = await actionQueue.getActionQueueItem(itemId)
    expect(item).not.toBeNull()
    expect(item!.state).toBe('open')

    // Nothing should have been resolved from this row.
    expect(rowsResolved).toBe(0)
  })

  it('still resolves a genuinely-orphaned non-draft-proposal row whose task was purged', async () => {
    const { q, actionQueue, reconcile } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Seed: open 'failed'-kind row whose origin_task_id is absent from both
    // tasks and proposals — a genuinely purged task.
    const purgedTaskId = 'T-purged-for-real'
    const orphanItemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: `Task ${purgedTaskId} failed`,
      body: 'orphan from purged task',
      payload: {},
      context: {},
      raisedBy: 'test',
      signature: `sig-${purgedTaskId}`,
      originTaskId: purgedTaskId,
    })

    // --- RUN ---
    await reconcile.reconcileTerminalTasks(client)

    // The orphan row for the purged task must be resolved.
    const orphanItem = await actionQueue.getActionQueueItem(orphanItemId)
    expect(orphanItem).not.toBeNull()
    expect(orphanItem!.state).toBe('resolved')
  })

  it('leaves draft-proposal open and resolves orphan task row in the same run', async () => {
    const { q, actionQueue, reconcile } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Seed: live proposal with an open draft-proposal row.
    const proposalId = 'prop-mixed-test-001'
    await insertProposal(client, proposalId)
    const draftItemId = await actionQueue.raiseActionQueueItem({
      kind: 'draft-proposal',
      category: 'user',
      priority: 'normal',
      title: `Draft proposal: Mixed test`,
      body: `Proposal ${proposalId} is ready for review.`,
      payload: { proposalId, source: 'human' },
      context: {},
      raisedBy: 'test',
      signature: proposalId,
      originTaskId: proposalId,
    })

    // Seed: open 'failed'-kind orphan row (purged task).
    const purgedTaskId = 'T-purged-mixed-001'
    const orphanItemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: `Task ${purgedTaskId} failed`,
      body: 'orphan',
      payload: {},
      context: {},
      raisedBy: 'test',
      signature: `sig-${purgedTaskId}`,
      originTaskId: purgedTaskId,
    })

    // --- RUN ---
    const { rowsResolved } = await reconcile.reconcileTerminalTasks(client)

    // Draft-proposal row stays open.
    const draftItem = await actionQueue.getActionQueueItem(draftItemId)
    expect(draftItem).not.toBeNull()
    expect(draftItem!.state).toBe('open')

    // Orphan task row is resolved.
    const orphanItem = await actionQueue.getActionQueueItem(orphanItemId)
    expect(orphanItem).not.toBeNull()
    expect(orphanItem!.state).toBe('resolved')

    // Only the orphan task row was resolved.
    expect(rowsResolved).toBe(1)
  })
})
