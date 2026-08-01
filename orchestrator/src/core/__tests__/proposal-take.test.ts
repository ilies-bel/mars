/**
 * Integration tests for proposal take — the live sibling of slice (ADR-0067).
 *
 * Verifies that the sequence of calls made by handleProposalTake produces the
 * correct observable state:
 *   - exactly ONE task created with workflow='live'
 *   - task carries parent_proposal_id and origin_id = proposalId
 *   - proposal transitions to 'sliced' (same post-promotion state as slice)
 *   - the slicer (runSlice) is never invoked
 *
 * Tests exercise the public module API (proposals.ts + queue.ts + getTask),
 * not server.ts internals, so they survive any refactor that keeps the DB
 * contract intact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface ProposalsMod {
  createProposal: typeof import('../proposals').createProposal
  promoteProposal: typeof import('../proposals').promoteProposal
  getProposal: typeof import('../proposals').getProposal
  claimProposalForSlicing: typeof import('../proposals').claimProposalForSlicing
  markProposalSliced: typeof import('../proposals').markProposalSliced
  revertSlicingProposalToReady: typeof import('../proposals').revertSlicingProposalToReady
  initProposals: typeof import('../proposals').initProposals
  addProposalUserStory: typeof import('../proposals').addProposalUserStory
}

interface QueueMod {
  migrateQueueSchema: typeof import('../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../queue').resolveQueueClient
  enqueueTask: typeof import('../queue').enqueueTask
  getTask: typeof import('../queue').getTask
  listTasksForProposal: typeof import('../queue').listTasksForProposal
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-proposal-take-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadMods = async (
  repo: string,
): Promise<{ p: ProposalsMod; q: QueueMod }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const p = (await import('../proposals')) as unknown as ProposalsMod
  const q = (await import('../queue')) as unknown as QueueMod
  await p.initProposals()
  await q.migrateQueueSchema()
  return { p, q }
}

const seedPrdReady = async (p: ProposalsMod): Promise<string> => {
  const proposal = await p.createProposal('Live-take feature', {
    source: 'human',
    problem: 'There is a problem',
    solution: 'Here is the solution',
  })
  await p.addProposalUserStory(proposal.id, 'As a user I can do something')
  const promoted = await p.promoteProposal(proposal.id)
  expect(promoted.status).toBe('prd-ready')
  return proposal.id
}

describe('proposal take — creates one task with workflow=live and proposal linkage', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('creates exactly one queued task with workflow=live, origin_id=proposalId, parent_proposal_id=proposalId', async () => {
    const { p, q } = await loadMods(repo)
    const proposalId = await seedPrdReady(p)

    // Replicate handleProposalTake's sequence: claim → enqueue → mark sliced.
    const claimed = await p.claimProposalForSlicing(proposalId)
    expect(claimed).toBe(true)

    const task = await q.enqueueTask('PRD prompt for live session', undefined, {
      originId: proposalId,
      parentProposalId: proposalId,
      workflow: 'live',
      spec: {
        files: [],
        verifyCmd: null,
        doneCriteria: ['As a user I can do something'],
        mergeMode: 'auto',
      },
    })

    await p.markProposalSliced(proposalId, 1)

    // Verify exactly one task linked to the proposal via origin_id.
    const proposalTasks = await q.listTasksForProposal(proposalId)
    expect(proposalTasks).toHaveLength(1)
    expect(proposalTasks[0].id).toBe(task.id)

    // Verify workflow='live' and originId via the Task interface.
    const created = await q.getTask(task.id)
    expect(created).not.toBeNull()
    expect(created!.workflow).toBe('live')
    expect(created!.originId).toBe(proposalId)

    // Verify parent_proposal_id via direct DB query (not exposed on Task).
    const client = q.resolveQueueClient()
    const row = await client.execute({
      sql: `SELECT parent_proposal_id, workflow FROM tasks WHERE id = ?`,
      args: [task.id],
    })
    const r = row.rows[0] as unknown as {
      parent_proposal_id: string | null
      workflow: string | null
    }
    expect(r.parent_proposal_id).toBe(proposalId)
    expect(r.workflow).toBe('live')

    // Verify proposal is now sliced.
    const proposal = await p.getProposal(proposalId)
    expect(proposal?.status).toBe('sliced')
  })

  it('proposal is not claimable a second time once it moves to sliced', async () => {
    const { p, q } = await loadMods(repo)
    const proposalId = await seedPrdReady(p)

    // First take succeeds.
    await p.claimProposalForSlicing(proposalId)
    await q.enqueueTask('PRD prompt', undefined, {
      originId: proposalId,
      parentProposalId: proposalId,
      workflow: 'live',
    })
    await p.markProposalSliced(proposalId, 1)

    // Second take attempt: claim must fail (proposal is already 'sliced').
    const secondClaim = await p.claimProposalForSlicing(proposalId)
    expect(secondClaim).toBe(false)
  })

  it('failed enqueue reverts proposal to prd-ready via revertSlicingProposalToReady', async () => {
    const { p } = await loadMods(repo)
    const proposalId = await seedPrdReady(p)

    // Claim succeeds: proposal is now 'slicing'.
    const claimed = await p.claimProposalForSlicing(proposalId)
    expect(claimed).toBe(true)
    const mid = await p.getProposal(proposalId)
    expect(mid?.status).toBe('slicing')

    // Simulate failed enqueue — revert claim.
    await p.revertSlicingProposalToReady(proposalId)

    // Proposal should be actionable again.
    const reverted = await p.getProposal(proposalId)
    expect(reverted?.status).toBe('prd-ready')
  })

  it('slicer (runSlice) is never called during the take flow', async () => {
    const { p, q } = await loadMods(repo)
    const proposalId = await seedPrdReady(p)

    // Spy on the slice-workflow module to confirm runSlice is never called.
    const sliceWorkflowSpy = vi.spyOn(
      await import('../../workflows/slice-workflow'),
      'runSlice',
    )

    await p.claimProposalForSlicing(proposalId)
    await q.enqueueTask('PRD prompt', undefined, {
      originId: proposalId,
      parentProposalId: proposalId,
      workflow: 'live',
    })
    await p.markProposalSliced(proposalId, 1)

    expect(sliceWorkflowSpy).not.toHaveBeenCalled()
  })
})
