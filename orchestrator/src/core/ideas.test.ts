/**
 * End-to-end test for the idea-promote edge rewrite (ADR-0015).
 *
 * When proposal A is promoted into task A', any task T that was blocked by A
 * via `task_proposal_blockers` must have its blocker edge atomically rewritten
 * into `task_blockers(T -> A')`. T stays `blocked` across the rewrite and is
 * unblocked normally when A' reaches `done` via the existing
 * `onBlockerTaskCompleted` path.
 *
 * The slice workflow (where the LLM slicer runs) calls
 * `transferProposalBlockerToTask` in Phase 5 of its execute function. This
 * test exercises that path directly — without running the LLM — to verify
 * the queue-db atomicity invariant and the downstream unblock flow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('./queue').enqueueTask
  updateTask: typeof import('./queue').updateTask
  getTask: typeof import('./queue').getTask
  resolveQueueClient: typeof import('./queue').resolveQueueClient
  migrateQueueSchema: typeof import('./queue').migrateQueueSchema
  addProposalBlockers: typeof import('./queue').addProposalBlockers
  listProposalBlockers: typeof import('./queue').listProposalBlockers
  listBlockers: typeof import('./queue').listBlockers
  transferProposalBlockerToTask: typeof import('./queue').transferProposalBlockerToTask
}

interface ProposalsModule {
  createProposal: typeof import('./proposals').createProposal
  addProposalUserStory: typeof import('./proposals').addProposalUserStory
  promoteProposal: typeof import('./proposals').promoteProposal
  initProposals: typeof import('./proposals').initProposals
}

interface BlockerResolutionModule {
  onBlockerTaskCompleted: typeof import('./blocker-resolution').onBlockerTaskCompleted
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-ideas-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{
  q: QueueModule
  p: ProposalsModule
  br: BlockerResolutionModule
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('./queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const p = (await import('./proposals')) as unknown as ProposalsModule
  await p.initProposals()
  const br = (await import(
    './blocker-resolution'
  )) as unknown as BlockerResolutionModule
  return { q, br, p }
}

describe('idea promotion atomically rewrites task_proposal_blockers edges', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('edge rewrite + downstream unblock: T stays blocked across rewrite and queues when A\' lands done', async () => {
    const { q, p, br } = await loadModules(repo)

    // Create proposal A (needs all required fields to be promotable, but for
    // the edge-rewrite test we only need the id — we bypass promoteProposal
    // and go straight to the transfer).
    const proposalA = await p.createProposal('Blocking Proposal A')

    // Create task T in queued state, then block it on proposal A.
    const taskT = await q.enqueueTask('dependent task T', undefined, {
      skipTriage: true,
    })
    await q.addProposalBlockers(taskT.id, [proposalA.id])
    // Flip T to blocked (mirrors what the daemon does when it receives a
    // task_proposal_blockers gate).
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [taskT.id],
    })

    // Sanity: T is blocked by the proposal, no task_blockers edge yet.
    expect((await q.getTask(taskT.id))?.status).toBe('blocked')
    expect(await q.listProposalBlockers(taskT.id)).toEqual([proposalA.id])
    expect(await q.listBlockers(taskT.id)).toEqual([])

    // Simulate the promote: create the task A' that the slicer would produce,
    // then call transferProposalBlockerToTask — which is exactly what Phase 5
    // of the slice workflow does.
    const taskAPrime = await q.enqueueTask("slice from proposal A", undefined, {
      skipTriage: true,
    })
    await q.transferProposalBlockerToTask(proposalA.id, taskAPrime.id)

    // After the atomic rewrite:
    // 1. task_proposal_blockers row is gone.
    expect(await q.listProposalBlockers(taskT.id)).toEqual([])
    // 2. task_blockers row T -> A' exists.
    expect(await q.listBlockers(taskT.id)).toEqual([taskAPrime.id])
    // 3. T is still blocked — the rewrite must NOT flip T to queued.
    expect((await q.getTask(taskT.id))?.status).toBe('blocked')

    // Now A' completes. Mark it done via raw SQL (bypasses updateTask's
    // promoteDraftToQueued which only handles draft/triaging, not blocked).
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [taskAPrime.id],
    })

    // onBlockerTaskCompleted is the path that unblocks T.
    const result = await br.onBlockerTaskCompleted(taskAPrime.id)

    // T must now be queued.
    expect((await q.getTask(taskT.id))?.status).toBe('queued')
    // The outcome list must include T with outcome 'queued'.
    const tOutcome = result.outcomes.find((o) => o.taskId === taskT.id)
    expect(tOutcome?.outcome).toBe('queued')
  })

  it('multiple dependents all get their edges rewritten atomically', async () => {
    const { q, p, br } = await loadModules(repo)

    const proposalA = await p.createProposal('Blocking Proposal Multi')

    // Two tasks (T1, T2) both blocked by proposal A.
    const taskT1 = await q.enqueueTask('dependent T1', undefined, { skipTriage: true })
    const taskT2 = await q.enqueueTask('dependent T2', undefined, { skipTriage: true })
    await q.addProposalBlockers(taskT1.id, [proposalA.id])
    await q.addProposalBlockers(taskT2.id, [proposalA.id])
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id IN (?, ?)`,
      args: [taskT1.id, taskT2.id],
    })

    // Promote: create A' and transfer.
    const taskAPrime = await q.enqueueTask('promoted task A prime', undefined, {
      skipTriage: true,
    })
    const { transferred } = await q.transferProposalBlockerToTask(
      proposalA.id,
      taskAPrime.id,
    )
    expect(transferred.sort()).toEqual([taskT1.id, taskT2.id].sort())

    // Both proposal edges gone, both task_blockers edges exist.
    expect(await q.listProposalBlockers(taskT1.id)).toEqual([])
    expect(await q.listProposalBlockers(taskT2.id)).toEqual([])
    expect(await q.listBlockers(taskT1.id)).toEqual([taskAPrime.id])
    expect(await q.listBlockers(taskT2.id)).toEqual([taskAPrime.id])

    // Both still blocked.
    expect((await q.getTask(taskT1.id))?.status).toBe('blocked')
    expect((await q.getTask(taskT2.id))?.status).toBe('blocked')

    // A' lands done → both dependents unblock.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [taskAPrime.id],
    })
    const result = await br.onBlockerTaskCompleted(taskAPrime.id)

    expect((await q.getTask(taskT1.id))?.status).toBe('queued')
    expect((await q.getTask(taskT2.id))?.status).toBe('queued')
    expect(result.outcomes.filter((o) => o.outcome === 'queued')).toHaveLength(2)
  })

  it('no-op when proposal has no dependent tasks', async () => {
    const { q, p } = await loadModules(repo)

    const proposalA = await p.createProposal('No dependents')
    const taskAPrime = await q.enqueueTask('slice', undefined, { skipTriage: true })

    // Transfer with no dependents must return empty transferred list.
    const { transferred } = await q.transferProposalBlockerToTask(
      proposalA.id,
      taskAPrime.id,
    )
    expect(transferred).toEqual([])
  })
})
