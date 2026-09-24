/**
 * Tests for the proposal expiry subsystem:
 * - `expireProposals()`: bulk-expires stale agent-authored drafts
 * - `reviveProposal()`: flips an expired proposal back to draft
 * - Near-duplicate dedup guard in `createProposal()`: coalesces near-identical
 *   agent-authored proposals from the same author within the dedup window
 * - `mars proposal list --status expired` (via `listProposals()`)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface ProposalsMod {
  createProposal: typeof import('../proposals').createProposal
  getProposal: typeof import('../proposals').getProposal
  listProposals: typeof import('../proposals').listProposals
  expireProposals: typeof import('../proposals').expireProposals
  reviveProposal: typeof import('../proposals').reviveProposal
  dismissProposal: typeof import('../proposals').dismissProposal
  initProposals: typeof import('../proposals').initProposals
  appendProposalNotes: typeof import('../proposals').appendProposalNotes
}

interface QueueMod {
  migrateQueueSchema: typeof import('../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../queue').resolveQueueClient
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-prop-expiry-test-'))
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
  return { p, q }
}

/** Age a proposal by setting updated_at to 30 days in the past via direct SQL. */
const ageProposal = async (q: QueueMod, id: string): Promise<void> => {
  const client = q.resolveQueueClient()
  const longAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
  await client.execute({
    sql: `UPDATE proposals SET updated_at = ?, created_at = ? WHERE id = ?`,
    args: [longAgo, longAgo, id],
  })
}

describe('expireProposals()', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('expires agent-authored draft proposals older than the cutoff', async () => {
    const { p, q } = await loadMods(repo)
    const proposal = await p.createProposal('Add error handling to pipeline', {
      source: 'reflection',
      author: { kind: 'agent', name: 'reflector' },
    })
    expect(proposal.status).toBe('draft')

    // Age the proposal so it is well beyond any test expiry window.
    await ageProposal(q, proposal.id)

    const { count, ids } = await p.expireProposals(14 * 24 * 60 * 60 * 1000)
    expect(count).toBe(1)
    expect(ids).toContain(proposal.id)

    const after = await p.getProposal(proposal.id)
    expect(after?.status).toBe('expired')
  })

  it('does NOT expire human-authored draft proposals', async () => {
    const { p, q } = await loadMods(repo)
    const human = await p.createProposal('A human idea', {
      source: 'human',
      author: { kind: 'human', name: 'operator' },
    })
    expect(human.status).toBe('draft')
    await ageProposal(q, human.id)

    const { count } = await p.expireProposals(14 * 24 * 60 * 60 * 1000)
    expect(count).toBe(0)

    const after = await p.getProposal(human.id)
    expect(after?.status).toBe('draft')
  })

  it('does NOT expire agent-authored drafts newer than the cutoff', async () => {
    const { p } = await loadMods(repo)
    await p.createProposal('Recent agent proposal', {
      source: 'reflection',
      author: { kind: 'agent', name: 'reflector' },
    })

    // Use a very large window — the proposal was just created so it is well
    // within the 14-day default. Do NOT age it.
    const { count } = await p.expireProposals(14 * 24 * 60 * 60 * 1000)
    expect(count).toBe(0)
  })

  it('does NOT re-expire proposals already in expired state', async () => {
    const { p, q } = await loadMods(repo)
    const a = await p.createProposal('Alpha old feature', {
      source: 'reflection',
      author: { kind: 'agent', name: 'reflector' },
    })
    const b = await p.createProposal('Beta new feature update', {
      source: 'reflection',
      author: { kind: 'agent', name: 'reflector' },
    })
    // Age both proposals so they fall past the expiry cutoff.
    await ageProposal(q, a.id)
    await ageProposal(q, b.id)

    // First sweep expires both.
    const first = await p.expireProposals(14 * 24 * 60 * 60 * 1000)
    expect(first.count).toBe(2)
    expect((await p.getProposal(a.id))?.status).toBe('expired')
    expect((await p.getProposal(b.id))?.status).toBe('expired')

    // Second sweep should find nothing new to expire.
    const second = await p.expireProposals(14 * 24 * 60 * 60 * 1000)
    expect(second.count).toBe(0)
    expect(second.ids).toHaveLength(0)
  })

  it('returns empty when no agent-authored drafts exist', async () => {
    const { p } = await loadMods(repo)
    const { count, ids } = await p.expireProposals(14 * 24 * 60 * 60 * 1000)
    expect(count).toBe(0)
    expect(ids).toHaveLength(0)
  })
})

describe('reviveProposal()', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('flips an expired proposal back to draft', async () => {
    const { p, q } = await loadMods(repo)
    const proposal = await p.createProposal('Revivable proposal', {
      source: 'reflection',
      author: { kind: 'agent', name: 'reflector' },
    })
    await ageProposal(q, proposal.id)
    await p.expireProposals(14 * 24 * 60 * 60 * 1000)
    expect((await p.getProposal(proposal.id))?.status).toBe('expired')

    const revived = await p.reviveProposal(proposal.id)
    expect(revived.status).toBe('draft')
    expect(revived.id).toBe(proposal.id)
  })

  it('throws when the proposal is not expired', async () => {
    const { p } = await loadMods(repo)
    const proposal = await p.createProposal('Draft proposal', {
      source: 'human',
      author: { kind: 'human', name: 'operator' },
    })
    expect(proposal.status).toBe('draft')

    await expect(p.reviveProposal(proposal.id)).rejects.toThrow(
      /only expired or dismissed proposals can be revived/,
    )
  })

  it('flips a dismissed proposal back to draft', async () => {
    const { p } = await loadMods(repo)
    const proposal = await p.createProposal('Accidentally dismissed', {
      source: 'human',
      author: { kind: 'human', name: 'operator' },
    })
    await p.dismissProposal(proposal.id)
    expect((await p.getProposal(proposal.id))?.status).toBe('dismissed')

    const revived = await p.reviveProposal(proposal.id)
    expect(revived.status).toBe('draft')
    expect(revived.title).toBe('Accidentally dismissed')
  })

  it('throws when the proposal does not exist', async () => {
    const { p } = await loadMods(repo)
    await expect(p.reviveProposal('nonexistent-id')).rejects.toThrow(/not found/)
  })

  it('preserves the proposal title, source, and notes after revival', async () => {
    const { p, q } = await loadMods(repo)
    const proposal = await p.createProposal('Important feature proposal', {
      source: 'reflection',
      author: { kind: 'agent', name: 'reflector' },
      notes: 'Original notes',
    })
    await ageProposal(q, proposal.id)
    await p.expireProposals(14 * 24 * 60 * 60 * 1000)

    const revived = await p.reviveProposal(proposal.id)
    expect(revived.title).toBe(proposal.title)
    expect(revived.source).toBe(proposal.source)
    expect(revived.notes).toBe('Original notes')
  })

  it('can be expired and revived multiple times', async () => {
    const { p, q } = await loadMods(repo)
    const proposal = await p.createProposal('Cyclical proposal', {
      source: 'reflection',
      author: { kind: 'agent', name: 'reflector' },
    })

    for (let cycle = 0; cycle < 2; cycle++) {
      await ageProposal(q, proposal.id)
      const { count } = await p.expireProposals(14 * 24 * 60 * 60 * 1000)
      expect(count).toBe(1)

      const expired = await p.getProposal(proposal.id)
      expect(expired?.status).toBe('expired')

      const revived = await p.reviveProposal(proposal.id)
      expect(revived.status).toBe('draft')
    }
  })
})

describe('listProposals() with status=expired', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns expired proposals when filtering by status=expired', async () => {
    const { p, q } = await loadMods(repo)
    const one = await p.createProposal('One old feature', {
      source: 'reflection',
      author: { kind: 'agent', name: 'reflector' },
    })
    const two = await p.createProposal('Two old improvements', {
      source: 'reflection',
      author: { kind: 'agent', name: 'reflector' },
    })
    await p.createProposal('Human draft', {
      source: 'human',
      author: { kind: 'human', name: 'operator' },
    })

    await ageProposal(q, one.id)
    await ageProposal(q, two.id)
    await p.expireProposals(14 * 24 * 60 * 60 * 1000)

    const expired = await p.listProposals({ status: 'expired' })
    expect(expired).toHaveLength(2)
    expect(expired.every((pr) => pr.status === 'expired')).toBe(true)

    const drafts = await p.listProposals({ status: 'draft' })
    expect(drafts).toHaveLength(1)
    expect(drafts[0].source).toBe('human')
  })
})

describe('createProposal() near-duplicate dedup guard', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('coalesces a near-identical agent proposal into the existing draft', async () => {
    const { p } = await loadMods(repo)
    const first = await p.createProposal(
      'Improve error handling in task processing pipeline',
      {
        source: 'reflection',
        author: { kind: 'agent', name: 'reflector' },
        notes: 'First occurrence',
      },
    )

    // Second call with a near-identical title (same key words) from the same agent.
    const second = await p.createProposal(
      'Improve error handling for task processing pipeline',
      {
        source: 'reflection',
        author: { kind: 'agent', name: 'reflector' },
        notes: 'Second occurrence',
      },
    )

    // Should return the existing proposal, not a new one.
    expect(second.id).toBe(first.id)

    // Both proposals: only one row exists.
    const all = await p.listProposals({ status: 'draft' })
    expect(all.filter((pr) => pr.source === 'reflection')).toHaveLength(1)
  })

  it('does NOT coalesce human-authored proposals with similar titles', async () => {
    const { p } = await loadMods(repo)
    const first = await p.createProposal(
      'Improve error handling in task processing pipeline',
      {
        source: 'human',
        author: { kind: 'human', name: 'operator' },
      },
    )
    const second = await p.createProposal(
      'Improve error handling for task processing pipeline',
      {
        source: 'human',
        author: { kind: 'human', name: 'operator' },
      },
    )

    // Human proposals always go through regardless of title similarity.
    expect(second.id).not.toBe(first.id)

    const all = await p.listProposals({ status: 'draft' })
    expect(all).toHaveLength(2)
  })

  it('does NOT coalesce proposals from different agent names', async () => {
    const { p } = await loadMods(repo)
    const first = await p.createProposal(
      'Improve error handling in task processing pipeline',
      {
        source: 'reflection',
        author: { kind: 'agent', name: 'reflector' },
      },
    )
    const second = await p.createProposal(
      'Improve error handling for task processing pipeline',
      {
        source: 'arc-verifier',
        author: { kind: 'agent', name: 'arc-verifier' },
      },
    )

    // Different agent names → no dedup.
    expect(second.id).not.toBe(first.id)

    const all = await p.listProposals({ status: 'draft' })
    expect(all).toHaveLength(2)
  })

  it('does NOT coalesce proposals with dissimilar titles (low Jaccard)', async () => {
    const { p } = await loadMods(repo)
    const first = await p.createProposal('Add caching layer to database queries', {
      source: 'reflection',
      author: { kind: 'agent', name: 'reflector' },
    })
    const second = await p.createProposal('Improve user interface rendering performance', {
      source: 'reflection',
      author: { kind: 'agent', name: 'reflector' },
    })

    // Completely different topics → no dedup.
    expect(second.id).not.toBe(first.id)

    const all = await p.listProposals({ status: 'draft' })
    expect(all).toHaveLength(2)
  })

  it('appends notes from the duplicate to the existing proposal', async () => {
    const { p } = await loadMods(repo)
    const first = await p.createProposal(
      'Improve error handling in task processing pipeline',
      {
        source: 'reflection',
        author: { kind: 'agent', name: 'reflector' },
        notes: 'First occurrence note',
      },
    )

    await p.createProposal(
      'Improve error handling for task processing pipeline',
      {
        source: 'reflection',
        author: { kind: 'agent', name: 'reflector' },
        notes: 'Second occurrence note',
      },
    )

    const updated = await p.getProposal(first.id)
    // Both notes should be present in the existing proposal.
    expect(updated?.notes).toContain('First occurrence note')
    expect(updated?.notes).toContain('Second occurrence note')
  })

  it('still creates a new proposal when no near-duplicate exists', async () => {
    const { p } = await loadMods(repo)
    const a = await p.createProposal('Add metrics collection to services', {
      source: 'reflection',
      author: { kind: 'agent', name: 'reflector' },
    })
    const b = await p.createProposal('Refactor authentication token storage', {
      source: 'reflection',
      author: { kind: 'agent', name: 'reflector' },
    })

    expect(a.id).not.toBe(b.id)
    const all = await p.listProposals({ status: 'draft' })
    expect(all).toHaveLength(2)
  })
})
