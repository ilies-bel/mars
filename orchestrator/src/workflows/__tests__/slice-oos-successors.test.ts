/**
 * Tests for out-of-scope successor proposal creation.
 *
 * Acceptance criteria:
 *   1. A proposal with one deferred deliverable in outOfScope produces exactly
 *      one successor draft proposal with the right dependency edge.
 *   2. Reslicing (calling createOutOfScopeSuccessors a second time with the
 *      same deliverable) produces no duplicate — the fingerprint holds.
 *   3. A proposal with an empty deliverables list produces no successors.
 *   4. The dependency edge points the right way: successor is blocked by parent
 *      (successor depends on parent, not the reverse).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Module shape declarations
// ---------------------------------------------------------------------------

interface ProposalsModule {
  createProposal: typeof import('../../core/proposals').createProposal
  initProposals: typeof import('../../core/proposals').initProposals
  listProposals: typeof import('../../core/proposals').listProposals
  listProposalDependencies: typeof import('../../core/proposals').listProposalDependencies
}

interface SliceWorkflowModule {
  createOutOfScopeSuccessors: typeof import('../slice-workflow').createOutOfScopeSuccessors
}

// ---------------------------------------------------------------------------
// Repo fixture helpers
// ---------------------------------------------------------------------------

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-oos-successors-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ proposals: ProposalsModule; sw: SliceWorkflowModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const proposals = (await import('../../core/proposals')) as unknown as ProposalsModule
  await proposals.initProposals()
  const sw = (await import('../slice-workflow')) as unknown as SliceWorkflowModule
  return { proposals, sw }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createOutOfScopeSuccessors', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('creates exactly one successor draft for one deferred deliverable', async () => {
    const { proposals, sw } = await loadModules(repo)

    const parent = await proposals.createProposal('Beta-tester broadcast system', {
      source: 'human',
      problem: 'Need a way to broadcast messages to beta testers',
      solution: 'REST API for broadcasts',
    })

    const deliverables = [
      {
        title: 'Admin UI screens for the broadcast system',
        outOfScopeText:
          'The admin UI itself. This proposal delivers the REST contract; the screens live in the admin interface being written separately.',
      },
    ]

    const ids = await sw.createOutOfScopeSuccessors(parent, deliverables)

    expect(ids).toHaveLength(1)

    const all = await proposals.listProposals()
    const successors = all.filter((p) => p.source === 'slicer')
    expect(successors).toHaveLength(1)
    expect(successors[0].status).toBe('draft')
    expect(successors[0].title).toBe('Admin UI screens for the broadcast system')
    expect(successors[0].problem).toContain(parent.id)
    expect(successors[0].problem).toContain('The admin UI itself')
  })

  it('links the successor to the parent with the correct dependency direction', async () => {
    const { proposals, sw } = await loadModules(repo)

    const parent = await proposals.createProposal('Beta-tester broadcast system', {
      source: 'human',
    })

    const deliverables = [
      {
        title: 'Admin UI screens',
        outOfScopeText: 'The admin UI itself. Screens live in a separate proposal.',
      },
    ]

    const [successorId] = await sw.createOutOfScopeSuccessors(parent, deliverables)

    // Successor should be blocked by (follow) the parent, not the reverse.
    const successorBlockers = await proposals.listProposalDependencies(successorId)
    expect(successorBlockers).toContain(parent.id)

    // Parent should have no blockers from this operation.
    const parentBlockers = await proposals.listProposalDependencies(parent.id)
    expect(parentBlockers).not.toContain(successorId)
  })

  it('produces no successors when the deliverables list is empty', async () => {
    const { proposals, sw } = await loadModules(repo)

    const parent = await proposals.createProposal('REST API only proposal', {
      source: 'human',
    })

    const ids = await sw.createOutOfScopeSuccessors(parent, [])

    expect(ids).toHaveLength(0)

    const all = await proposals.listProposals()
    const successors = all.filter((p) => p.source === 'slicer')
    expect(successors).toHaveLength(0)
  })

  it('does not duplicate successors when called twice with the same deliverable (idempotency)', async () => {
    const { proposals, sw } = await loadModules(repo)

    const parent = await proposals.createProposal('Beta-tester broadcast system', {
      source: 'human',
    })

    const deliverables = [
      {
        title: 'Admin UI screens',
        outOfScopeText: 'The admin UI itself. Screens live in a separate proposal.',
      },
    ]

    // First call — creates the successor.
    await sw.createOutOfScopeSuccessors(parent, deliverables)
    // Second call (reslice) — must not create a duplicate.
    await sw.createOutOfScopeSuccessors(parent, deliverables)

    const all = await proposals.listProposals()
    const successors = all.filter((p) => p.source === 'slicer')
    expect(successors).toHaveLength(1)
  })
})
