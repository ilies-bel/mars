/**
 * Behaviour tests for the plan-approval gate:
 *
 *   1. `buildSlicerPrompt` emits an operator-feedback section when
 *      `resliceFeedback` is provided.
 *   2. `approveProposalPlan` transitions each task from 'draft' to the
 *      correct status: 'blocked' for hitl slices / slices with blocker edges,
 *      'queued' for everything else.
 *   3. `revertSlicedProposalToReady` flips a 'sliced' proposal back to
 *      'prd-ready', and throws if the proposal is not currently 'sliced'.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildSlicerPrompt } from '../../workflows/slice-workflow'

// ---------------------------------------------------------------------------
// buildSlicerPrompt — pure function, no DB needed
// ---------------------------------------------------------------------------

const STUB_PROPOSAL = {
  id: 'p-test-01',
  title: 'My feature',
  problem: 'Users cannot do X',
  solution: 'Add X',
  outOfScope: '',
  notes: '',
  userStories: ['As a user I can do X'],
}

describe('buildSlicerPrompt — resliceFeedback', () => {
  it('omits the feedback section when resliceFeedback is not provided', () => {
    const prompt = buildSlicerPrompt(STUB_PROPOSAL)
    expect(prompt).not.toContain('Operator re-slice feedback')
    expect(prompt).not.toContain('A prior slice plan was reviewed')
  })

  it('includes the feedback section when resliceFeedback is provided', () => {
    const feedback = 'Please make the slices smaller and add more tests'
    const prompt = buildSlicerPrompt(STUB_PROPOSAL, feedback)
    expect(prompt).toContain('Operator re-slice feedback')
    expect(prompt).toContain('A prior slice plan was reviewed and rejected')
    expect(prompt).toContain(feedback)
  })

  it('includes the PRD title in the prompt regardless of feedback', () => {
    const prompt = buildSlicerPrompt(STUB_PROPOSAL)
    expect(prompt).toContain('My feature')
    expect(prompt).toContain('Users cannot do X')
  })
})

// ---------------------------------------------------------------------------
// DB-backed tests — `approveProposalPlan` and `revertSlicedProposalToReady`
// ---------------------------------------------------------------------------

interface ProposalsMod {
  createProposal: typeof import('../proposals').createProposal
  promoteProposal: typeof import('../proposals').promoteProposal
  claimProposalForSlicing: typeof import('../proposals').claimProposalForSlicing
  markProposalSliced: typeof import('../proposals').markProposalSliced
  getProposal: typeof import('../proposals').getProposal
  initProposals: typeof import('../proposals').initProposals
  addProposalUserStory: typeof import('../proposals').addProposalUserStory
  approveProposalPlan: typeof import('../proposals').approveProposalPlan
  revertSlicedProposalToReady: typeof import('../proposals').revertSlicedProposalToReady
}

interface QueueMod {
  enqueueTask: typeof import('../queue').enqueueTask
  getTask: typeof import('../queue').getTask
}

interface TaskStoreMod {
  getDefaultTaskStore: typeof import('../store/task-store').getDefaultTaskStore
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-plan-approval-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadMods = async (
  repo: string,
): Promise<{ p: ProposalsMod; q: QueueMod; ts: TaskStoreMod }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const p = (await import('../proposals')) as unknown as ProposalsMod
  const q = (await import('../queue')) as unknown as QueueMod
  const ts = (await import('../store/task-store')) as unknown as TaskStoreMod
  await p.initProposals()
  return { p, q, ts }
}

/** Advance a proposal all the way to 'sliced', returning its id. */
const seedSlicedProposal = async (
  p: ProposalsMod,
  proposalId?: string,
): Promise<string> => {
  const proposal = await p.createProposal('Test feature', {
    source: 'human',
    problem: 'need something',
    solution: 'build it',
  })
  await p.addProposalUserStory(proposal.id, 'As a user I can use the feature')
  await p.promoteProposal(proposal.id)
  await p.claimProposalForSlicing(proposal.id)
  // markProposalSliced transitions 'slicing' → 'sliced'
  await p.markProposalSliced(proposal.id, 1)
  return proposal.id
}

describe('approveProposalPlan — task status transitions', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('transitions a plain coder draft task to queued', async () => {
    const { p, q } = await loadMods(repo)

    const proposal = await p.createProposal('Feature', {
      source: 'human',
      problem: 'p',
      solution: 's',
    })
    await p.addProposalUserStory(proposal.id, 'story')
    await p.promoteProposal(proposal.id)
    await p.claimProposalForSlicing(proposal.id)

    // Insert a 'draft' coder task tied to the proposal.
    const task = await q.enqueueTask('do the work', undefined, {
      parentProposalId: proposal.id,
      spec: {
        files: [],
        verifyCmd: null,
        doneCriteria: ['it works'],
        mergeMode: 'auto',
        sliceKind: 'coder',
      },
    })

    await p.markProposalSliced(proposal.id, 1)

    const result = await p.approveProposalPlan(proposal.id)

    expect(result.queuedTaskIds).toContain(task.id)
    expect(result.blockedTaskIds).not.toContain(task.id)

    const after = await q.getTask(task.id)
    expect(after?.status).toBe('queued')
  })

  it('transitions a hitl draft task to blocked', async () => {
    const { p, q } = await loadMods(repo)

    const proposal = await p.createProposal('Feature', {
      source: 'human',
      problem: 'p',
      solution: 's',
    })
    await p.addProposalUserStory(proposal.id, 'story')
    await p.promoteProposal(proposal.id)
    await p.claimProposalForSlicing(proposal.id)

    // Insert a 'draft' hitl task.
    const hitlTask = await q.enqueueTask('push to prod', undefined, {
      parentProposalId: proposal.id,
      spec: {
        files: [],
        verifyCmd: null,
        doneCriteria: ['deployed'],
        mergeMode: 'auto',
        sliceKind: 'hitl',
      },
    })

    await p.markProposalSliced(proposal.id, 1)

    const result = await p.approveProposalPlan(proposal.id)

    expect(result.blockedTaskIds).toContain(hitlTask.id)
    expect(result.queuedTaskIds).not.toContain(hitlTask.id)

    const after = await q.getTask(hitlTask.id)
    expect(after?.status).toBe('blocked')
  })

  it('transitions a task with blocker edges to blocked', async () => {
    const { p, q, ts } = await loadMods(repo)

    const proposal = await p.createProposal('Feature', {
      source: 'human',
      problem: 'p',
      solution: 's',
    })
    await p.addProposalUserStory(proposal.id, 'story')
    await p.promoteProposal(proposal.id)
    await p.claimProposalForSlicing(proposal.id)

    // First slice (blocker)
    const blockerTask = await q.enqueueTask('build the foundation', undefined, {
      parentProposalId: proposal.id,
      spec: {
        files: [],
        verifyCmd: null,
        doneCriteria: ['foundation done'],
        mergeMode: 'auto',
        sliceKind: 'coder',
      },
    })

    // Second slice (depends on first)
    const dependentTask = await q.enqueueTask('build on top', undefined, {
      parentProposalId: proposal.id,
      spec: {
        files: [],
        verifyCmd: null,
        doneCriteria: ['feature done'],
        mergeMode: 'auto',
        sliceKind: 'coder',
      },
    })

    // Wire the blocker edge directly in the DB.
    const store = await ts.getDefaultTaskStore()
    await store.atomic(async (scope) => {
      await scope.execute({
        sql: `INSERT INTO task_blockers (task_id, blocker_task_id, provenance, created_at) VALUES (?, ?, ?, ?)`,
        args: [dependentTask.id, blockerTask.id, 'inferred', new Date().toISOString()],
      })
    })

    await p.markProposalSliced(proposal.id, 2)

    const result = await p.approveProposalPlan(proposal.id)

    // Blocker-free task → queued; task-with-edge → blocked.
    expect(result.queuedTaskIds).toContain(blockerTask.id)
    expect(result.blockedTaskIds).toContain(dependentTask.id)

    const afterBlocker = await q.getTask(blockerTask.id)
    const afterDependent = await q.getTask(dependentTask.id)
    expect(afterBlocker?.status).toBe('queued')
    expect(afterDependent?.status).toBe('blocked')
  })

  it('throws when the proposal is not in sliced status', async () => {
    const { p } = await loadMods(repo)

    const proposal = await p.createProposal('Feature', {
      source: 'human',
      problem: 'p',
      solution: 's',
    })
    await p.addProposalUserStory(proposal.id, 'story')
    await p.promoteProposal(proposal.id)
    // Proposal is now 'prd-ready', not 'sliced'.

    await expect(p.approveProposalPlan(proposal.id)).rejects.toThrow(
      /only 'sliced' proposals can be approved/,
    )
  })

  it('throws when the proposal does not exist', async () => {
    const { p } = await loadMods(repo)
    await expect(p.approveProposalPlan('does-not-exist')).rejects.toThrow(
      /not found/,
    )
  })
})

describe('revertSlicedProposalToReady', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('flips a sliced proposal back to prd-ready', async () => {
    const { p } = await loadMods(repo)

    const proposalId = await seedSlicedProposal(p)
    const before = await p.getProposal(proposalId)
    expect(before?.status).toBe('sliced')

    await p.revertSlicedProposalToReady(proposalId)

    const after = await p.getProposal(proposalId)
    expect(after?.status).toBe('prd-ready')
  })

  it('throws when the proposal is not in sliced status', async () => {
    const { p } = await loadMods(repo)

    const proposal = await p.createProposal('Feature', {
      source: 'human',
      problem: 'p',
      solution: 's',
    })
    await p.addProposalUserStory(proposal.id, 'story')
    await p.promoteProposal(proposal.id)
    // Proposal is 'prd-ready', not 'sliced'.

    await expect(p.revertSlicedProposalToReady(proposal.id)).rejects.toThrow(
      /cannot revert proposal/,
    )
  })
})
