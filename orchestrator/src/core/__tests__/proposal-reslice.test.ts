/** Behaviour tests for re-slicing a proposal. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildSlicerPrompt } from '../../workflows/slice-workflow'

const STUB_PROPOSAL = {
  id: 'p-test-01',
  title: 'My feature',
  problem: 'Users cannot do X',
  solution: 'Add X',
  outOfScope: '',
  notes: '',
  userStories: ['As a user I can do X'],
}

describe('buildSlicerPrompt — reslice feedback', () => {
  it('omits the feedback section when reslice feedback is not provided', () => {
    const prompt = buildSlicerPrompt(STUB_PROPOSAL)
    expect(prompt).not.toContain('Operator re-slice feedback')
    expect(prompt).not.toContain('A prior slice plan was reviewed')
  })

  it('includes operator feedback in a re-slice prompt', () => {
    const feedback = 'Please make the slices smaller and add more tests'
    const prompt = buildSlicerPrompt(STUB_PROPOSAL, feedback)
    expect(prompt).toContain('Operator re-slice feedback')
    expect(prompt).toContain('A prior slice plan was reviewed and rejected')
    expect(prompt).toContain(feedback)
  })
})

interface ProposalsMod {
  createProposal: typeof import('../proposals').createProposal
  promoteProposal: typeof import('../proposals').promoteProposal
  claimProposalForSlicing: typeof import('../proposals').claimProposalForSlicing
  markProposalSliced: typeof import('../proposals').markProposalSliced
  getProposal: typeof import('../proposals').getProposal
  initProposals: typeof import('../proposals').initProposals
  addProposalUserStory: typeof import('../proposals').addProposalUserStory
  revertSlicedProposalToReady: typeof import('../proposals').revertSlicedProposalToReady
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-proposal-reslice-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadProposals = async (repo: string): Promise<ProposalsMod> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const proposals = (await import('../proposals')) as unknown as ProposalsMod
  await proposals.initProposals()
  return proposals
}

const seedSlicedProposal = async (proposals: ProposalsMod): Promise<string> => {
  const proposal = await proposals.createProposal('Test feature', {
    source: 'human',
    problem: 'need something',
    solution: 'build it',
  })
  await proposals.addProposalUserStory(proposal.id, 'As a user I can use the feature')
  await proposals.promoteProposal(proposal.id)
  await proposals.claimProposalForSlicing(proposal.id)
  await proposals.markProposalSliced(proposal.id, 1)
  return proposal.id
}

describe('revertSlicedProposalToReady', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('makes a sliced proposal ready for a replacement cut', async () => {
    const proposals = await loadProposals(repo)
    const proposalId = await seedSlicedProposal(proposals)

    await proposals.revertSlicedProposalToReady(proposalId)

    expect((await proposals.getProposal(proposalId))?.status).toBe('prd-ready')
  })

  it('refuses to revert a proposal that has not been sliced', async () => {
    const proposals = await loadProposals(repo)
    const proposal = await proposals.createProposal('Feature', {
      source: 'human',
      problem: 'p',
      solution: 's',
    })
    await proposals.addProposalUserStory(proposal.id, 'story')
    await proposals.promoteProposal(proposal.id)

    await expect(proposals.revertSlicedProposalToReady(proposal.id)).rejects.toThrow(
      /cannot revert proposal/,
    )
  })
})
