/**
 * Core proposals invariant tests.
 *
 * Guards the lifecycle-transition rules that are NOT covered by narrower
 * single-feature test files (proposal-bus-events, proposal-expiry, …).
 *
 * Specifically targets the anomaly described in the task brief: a dismissed
 * proposal was silently reverted to 'draft' two minutes later, implying some
 * write path had no guard against reversing an explicit operator decision.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface ProposalsMod {
  createProposal: typeof import('../proposals').createProposal
  dismissProposal: typeof import('../proposals').dismissProposal
  setProposalField: typeof import('../proposals').setProposalField
  initProposals: typeof import('../proposals').initProposals
}

interface QueueMod {
  migrateQueueSchema: typeof import('../queue').migrateQueueSchema
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-proposals-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadMods = async (repo: string): Promise<{ p: ProposalsMod; q: QueueMod }> => {
  const { vi } = await import('vitest')
  vi.resetModules()
  process.env.MARS_REPO = repo
  const p = (await import('../proposals')) as unknown as ProposalsMod
  const q = (await import('../queue')) as unknown as QueueMod
  await p.initProposals()
  await q.migrateQueueSchema()
  return { p, q }
}

describe('proposals — lifecycle-transition guards', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  describe('dismissed → draft reversion guard', () => {
    it('setProposalField rejects status=draft on a dismissed proposal', async () => {
      const { p } = await loadMods(repo)

      const proposal = await p.createProposal('A proposal to dismiss', { source: 'human' })
      await p.dismissProposal(proposal.id)

      // Attempting to move the dismissed proposal back to 'draft' via
      // setProposalField must be rejected — this is the write path that was
      // unguarded and produced the status-reversion anomaly.
      await expect(
        p.setProposalField(proposal.id, 'status', 'draft'),
      ).rejects.toThrow(/dismissed.*cannot be moved back to 'draft'/)
    })

    it('dismissProposal itself still works on a draft proposal', async () => {
      const { p } = await loadMods(repo)

      const proposal = await p.createProposal('Another proposal', { source: 'human' })
      const dismissed = await p.dismissProposal(proposal.id)
      expect(dismissed.status).toBe('dismissed')
    })

    it('dismissing an already-dismissed proposal throws (no silent no-op)', async () => {
      const { p } = await loadMods(repo)

      const proposal = await p.createProposal('Double-dismiss target', { source: 'human' })
      await p.dismissProposal(proposal.id)

      // The existing guarded UPDATE in dismissProposal rejects this because
      // AND status='draft' matches zero rows.
      await expect(p.dismissProposal(proposal.id)).rejects.toThrow(
        /already 'dismissed'/,
      )
    })

    it('dismisses a prd-ready proposal', async () => {
      const { p } = await loadMods(repo)

      const proposal = await p.createProposal('Shaped proposal', {
        source: 'human',
        problem: 'a problem',
        solution: 'a solution',
      })
      await p.setProposalField(proposal.id, 'status', 'prd-ready')
      const dismissed = await p.dismissProposal(proposal.id)
      expect(dismissed.status).toBe('dismissed')
    })

    it('dismisses a sliced proposal with no live tasks', async () => {
      const { p } = await loadMods(repo)

      const proposal = await p.createProposal('Sliced proposal', {
        source: 'human',
        problem: 'a problem',
        solution: 'a solution',
      })
      await p.setProposalField(proposal.id, 'status', 'sliced')
      const dismissed = await p.dismissProposal(proposal.id)
      expect(dismissed.status).toBe('dismissed')
    })

    it('setProposalField allows other status transitions from non-dismissed proposals', async () => {
      const { p } = await loadMods(repo)

      const proposal = await p.createProposal('A proposal', { source: 'human' })
      // Setting status to 'expired' (a valid exit from 'draft') is allowed.
      const updated = await p.setProposalField(proposal.id, 'status', 'expired')
      expect(updated.status).toBe('expired')
    })

    it('setProposalField allows non-status field writes on a dismissed proposal', async () => {
      const { p } = await loadMods(repo)

      const proposal = await p.createProposal('Proposal with notes', { source: 'human' })
      await p.dismissProposal(proposal.id)

      // Writing non-status fields on a dismissed proposal is fine — the guard
      // is specific to status='draft', not to all mutations on dismissed rows.
      const updated = await p.setProposalField(proposal.id, 'notes', 'post-dismiss note')
      expect(updated.notes).toBe('post-dismiss note')
      expect(updated.status).toBe('dismissed')
    })
  })

  describe('prd-ready body guard', () => {
    it('setProposalField rejects status=prd-ready when both problem and solution are empty', async () => {
      const { p } = await loadMods(repo)

      // A freshly-created proposal has no problem or solution text.
      const proposal = await p.createProposal('A bodyless proposal title', { source: 'human' })
      expect(proposal.problem).toBe('')
      expect(proposal.solution).toBe('')

      await expect(
        p.setProposalField(proposal.id, 'status', 'prd-ready'),
      ).rejects.toThrow(/has no problem or solution text/)
    })

    it('setProposalField allows status=prd-ready when problem is populated', async () => {
      const { p } = await loadMods(repo)

      const proposal = await p.createProposal('Problem-only proposal', { source: 'human' })
      await p.setProposalField(proposal.id, 'problem', 'Users cannot reset their password.')

      // At least one field non-empty → promotion should succeed.
      const promoted = await p.setProposalField(proposal.id, 'status', 'prd-ready')
      expect(promoted.status).toBe('prd-ready')
    })

    it('setProposalField allows status=prd-ready when solution is populated (problem empty)', async () => {
      const { p } = await loadMods(repo)

      const proposal = await p.createProposal('Solution-only proposal', { source: 'human' })
      await p.setProposalField(proposal.id, 'solution', 'Add a /reset-password route.')

      // solution alone is enough — a prescribed solution without a formal
      // problem description is still sliceable.
      const promoted = await p.setProposalField(proposal.id, 'status', 'prd-ready')
      expect(promoted.status).toBe('prd-ready')
    })

    it('error message names the proposal id and the remediation command', async () => {
      const { p } = await loadMods(repo)

      const proposal = await p.createProposal('Empty body proposal', { source: 'human' })

      await expect(
        p.setProposalField(proposal.id, 'status', 'prd-ready'),
      ).rejects.toThrow(new RegExp(`${proposal.id}.*problem.*solution`, 's'))
    })
  })
})
