import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface ProposalsMod {
  createProposal: typeof import('../proposals').createProposal
  promoteProposal: typeof import('../proposals').promoteProposal
  claimProposalForSlicing: typeof import('../proposals').claimProposalForSlicing
  markProposalSliced: typeof import('../proposals').markProposalSliced
  getProposal: typeof import('../proposals').getProposal
  initProposals: typeof import('../proposals').initProposals
  addProposalUserStory: typeof import('../proposals').addProposalUserStory
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-claim-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadMods = async (repo: string): Promise<ProposalsMod> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const p = (await import('../proposals')) as unknown as ProposalsMod
  await p.initProposals()
  return p
}

const seedPrdReady = async (p: ProposalsMod): Promise<string> => {
  const proposal = await p.createProposal('Feature to slice', {
    source: 'human',
    problem: 'p',
    solution: 's',
  })
  await p.addProposalUserStory(proposal.id, 'As a user I can do something')
  const promoted = await p.promoteProposal(proposal.id)
  expect(promoted.status).toBe('prd-ready')
  return proposal.id
}

describe('claimProposalForSlicing — atomic CAS on prd-ready', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns true exactly once when two callers race to claim the same proposal', async () => {
    // The TOCTOU race the function exists to close: two concurrent
    // runSlice triggers (promote auto-slice + a direct slice RPC, or a
    // daemon restart re-exposing the same prd-ready row) both used to
    // read 'prd-ready' and both ran the slicer. With the atomic claim,
    // exactly ONE caller wins; the loser sees a false return and aborts.
    const p = await loadMods(repo)
    const proposalId = await seedPrdReady(p)

    const [a, b] = await Promise.all([
      p.claimProposalForSlicing(proposalId),
      p.claimProposalForSlicing(proposalId),
    ])

    // Exactly one wins. The order is not determined.
    expect([a, b].filter((v) => v === true)).toHaveLength(1)
    expect([a, b].filter((v) => v === false)).toHaveLength(1)

    // The proposal is now 'slicing' — neither 'prd-ready' nor 'sliced'.
    const after = await p.getProposal(proposalId)
    expect(after?.status).toBe('slicing')
  })

  it('returns false when the proposal is not prd-ready', async () => {
    // Defensive: a manual claim attempt against a draft proposal must
    // not flip its status. The CAS requires status='prd-ready'.
    const p = await loadMods(repo)
    const proposal = await p.createProposal('Draft proposal', { source: 'human' })

    const claimed = await p.claimProposalForSlicing(proposal.id)
    expect(claimed).toBe(false)

    const after = await p.getProposal(proposal.id)
    expect(after?.status).toBe('draft')
  })

  it('keeps promotion coordination after a daemon restart', async () => {
    const p = await loadMods(repo)
    const proposal = await p.createProposal('Start work after slicing', {
      source: 'human',
      problem: 'Operators need coordinated slices after promotion',
      solution: 'Queue slices automatically after they finish',
    })
    await p.addProposalUserStory(proposal.id, 'As an operator I can promote work once')

    await p.promoteProposal(proposal.id, { coordinated: true })

    // Re-importing the proposal API models a daemon restart: only row state
    // should carry the coordination choice through eventual slicing.
    const restarted = await loadMods(repo)
    const afterRestart = await restarted.getProposal(proposal.id)

    expect(afterRestart).toMatchObject({
      status: 'prd-ready',
      coordinated: true,
    })
  })

  it('markProposalSliced only flips from slicing — calling it without claim throws', async () => {
    // The complementary CAS in markProposalSliced: only the caller that
    // holds the 'slicing' claim can complete the transition to 'sliced'.
    // A 'prd-ready' proposal with no prior claim must NOT be flippable
    // to 'sliced' directly.
    const p = await loadMods(repo)
    const proposalId = await seedPrdReady(p)

    await expect(p.markProposalSliced(proposalId, 3)).rejects.toThrow(
      /expected status='slicing'/,
    )

    // Status untouched.
    const after = await p.getProposal(proposalId)
    expect(after?.status).toBe('prd-ready')
  })

  it('the loser of the race cannot also markProposalSliced — only one cohort lands', async () => {
    // End-to-end shape: even if the losing caller ignores its false
    // return and forges ahead to call markProposalSliced, the second
    // CAS in markProposalSliced refuses the flip. The proposal never
    // ends up 'sliced' twice; at most ONE caller's cohort lands.
    const p = await loadMods(repo)
    const proposalId = await seedPrdReady(p)

    const a = await p.claimProposalForSlicing(proposalId)
    const b = await p.claimProposalForSlicing(proposalId)
    expect(a).toBe(true)
    expect(b).toBe(false)

    // Winner can complete.
    await p.markProposalSliced(proposalId, 4)
    const afterWinner = await p.getProposal(proposalId)
    expect(afterWinner?.status).toBe('sliced')

    // Loser, if it tried, would fail — status is now 'sliced', not 'slicing'.
    await expect(p.markProposalSliced(proposalId, 4)).rejects.toThrow(
      /expected status='slicing'/,
    )
  })
})
