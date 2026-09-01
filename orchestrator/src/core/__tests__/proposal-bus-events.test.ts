import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface ProposalsMod {
  createProposal: typeof import('../proposals').createProposal
  promoteProposal: typeof import('../proposals').promoteProposal
  dismissProposal: typeof import('../proposals').dismissProposal
  markProposalSliced: typeof import('../proposals').markProposalSliced
  claimProposalForSlicing: typeof import('../proposals').claimProposalForSlicing
  initProposals: typeof import('../proposals').initProposals
  setProposalField: typeof import('../proposals').setProposalField
  addProposalUserStory: typeof import('../proposals').addProposalUserStory
}

interface QueueMod {
  migrateQueueSchema: typeof import('../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../queue').resolveQueueClient
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-prop-bus-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadMods = async (repo: string): Promise<{ p: ProposalsMod; q: QueueMod }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const p = (await import('../proposals')) as unknown as ProposalsMod
  const q = (await import('../queue')) as unknown as QueueMod
  await p.initProposals()
  await q.migrateQueueSchema()
  return { p, q }
}

const getEvents = async (
  q: QueueMod,
  type: string,
): Promise<Array<{ type: string; payload: Record<string, unknown> }>> => {
  const client = q.resolveQueueClient()
  const result = await client.execute({
    sql: `SELECT type, payload FROM events WHERE type = ? ORDER BY id`,
    args: [type],
  })
  return (result.rows as unknown as Array<{ type: string; payload: string }>).map((r) => ({
    type: r.type,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
  }))
}

describe('proposal bus events', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('creating a proposal emits proposal.added with proposalId, source, and title', async () => {
    const { p, q } = await loadMods(repo)
    const proposal = await p.createProposal('My new feature', { source: 'human' })

    const events = await getEvents(q, 'proposal.added')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({
      proposalId: proposal.id,
      source: 'human',
      title: 'My new feature',
    })
  })

  it('promoting a proposal emits proposal.promoted with proposalId', async () => {
    const { p, q } = await loadMods(repo)
    // Build a fully-shaped proposal so promoteProposal passes validation.
    const proposal = await p.createProposal('Feature to promote', { source: 'human', problem: 'a problem', solution: 'a solution' })
    await p.addProposalUserStory(proposal.id, 'As a user I can do something')
    await p.promoteProposal(proposal.id)

    const events = await getEvents(q, 'proposal.promoted')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ proposalId: proposal.id })
  })

  it('dismissing a proposal emits proposal.dismissed with proposalId', async () => {
    const { p, q } = await loadMods(repo)
    const proposal = await p.createProposal('Proposal to dismiss', { source: 'human' })
    await p.dismissProposal(proposal.id)

    const events = await getEvents(q, 'proposal.dismissed')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ proposalId: proposal.id })
  })

  it('dismissing a proposal closes its open draft-proposal action-queue row (ADR-0094)', async () => {
    // ADR-0094: operator-decision rows are closed atomically in the same
    // operation as the mutation that resolves them. A dismissed proposal's
    // draft-proposal row can never be resolved through its advertised verbs,
    // so dismissProposal must close it here — not rely on a sweep.
    const { p } = await loadMods(repo)
    const aq = await import('../lib/action-queue')
    await aq.initActionQueue()

    const proposal = await p.createProposal('Proposal with AQ row', { source: 'human' })

    // Raise a draft-proposal AQ row for the proposal.
    await aq.raiseActionQueueItem({
      kind: 'draft-proposal',
      category: 'orchestrator',
      priority: 'normal',
      title: 'Proposal with AQ row',
      body: 'A draft proposal awaiting review',
      payload: { proposalId: proposal.id, source: 'human' },
      context: {},
      raisedBy: 'test',
      signature: `draft-proposal:${proposal.id}`,
    })

    // Confirm the row is open before dismissal.
    const before = await aq.listActionQueueItems('open')
    expect(before.some((r) => r.kind === 'draft-proposal' && r.payload['proposalId'] === proposal.id)).toBe(true)

    // Dismiss the proposal.
    await p.dismissProposal(proposal.id)

    // The draft-proposal row must now be resolved (not open).
    const after = await aq.listActionQueueItems('open')
    expect(after.some((r) => r.kind === 'draft-proposal' && r.payload['proposalId'] === proposal.id)).toBe(false)
  })

  it('marking a proposal sliced emits proposal.sliced with proposalId and taskCount', async () => {
    const { p, q } = await loadMods(repo)
    const proposal = await p.createProposal('Feature to slice', { source: 'human', problem: 'p', solution: 's' })
    await p.addProposalUserStory(proposal.id, 'As a user I can do something')
    await p.promoteProposal(proposal.id)

    // The atomic claim flips 'prd-ready' -> 'slicing'; markProposalSliced
    // only flips 'slicing' -> 'sliced', so we must claim first or the
    // conditional UPDATE matches zero rows.
    const claimed = await p.claimProposalForSlicing(proposal.id)
    expect(claimed).toBe(true)
    await p.markProposalSliced(proposal.id, 3)

    const events = await getEvents(q, 'proposal.sliced')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ proposalId: proposal.id, taskCount: 3 })
  })

  it('existing task transition events are unaffected after proposals emit events', async () => {
    const { p, q } = await loadMods(repo)
    // Create a proposal (emits proposal.added)
    await p.createProposal('Test proposal', { source: 'human' })

    // Verify task events table is clean (no spurious task events)
    const taskEvents = await getEvents(q, 'task.added')
    expect(taskEvents).toHaveLength(0)

    // Verify proposal event did land
    const propEvents = await getEvents(q, 'proposal.added')
    expect(propEvents).toHaveLength(1)
  })
})
