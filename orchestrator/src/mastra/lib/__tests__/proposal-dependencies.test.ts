import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface Proposals {
  createProposal: typeof import('../../proposals').createProposal
  addProposalDependencies: typeof import('../../proposals').addProposalDependencies
  listProposalDependencies: typeof import('../../proposals').listProposalDependencies
  removeProposalDependency: typeof import('../../proposals').removeProposalDependency
  deleteProposal: typeof import('../../proposals').deleteProposal
  initProposals: typeof import('../../proposals').initProposals
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-prop-dep-test-'))
  // proposals.ts requires a git repo for context resolution
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadProposals = async (repo: string): Promise<Proposals> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = await import('../../proposals')
  await mod.initProposals()
  return mod as unknown as Proposals
}

describe('proposal_dependencies (ADR-0008 idea->idea planning graph)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('adds an idea->idea edge and lists it back', async () => {
    const p = await loadProposals(repo)
    const a = await p.createProposal('a')
    const b = await p.createProposal('b')
    await p.addProposalDependencies(a.id, [b.id])
    expect(await p.listProposalDependencies(a.id)).toEqual([b.id])
  })

  it('addProposalDependencies is idempotent on duplicate pairs', async () => {
    const p = await loadProposals(repo)
    const a = await p.createProposal('a')
    const b = await p.createProposal('b')
    const c = await p.createProposal('c')
    await p.addProposalDependencies(a.id, [b.id, c.id])
    expect((await p.listProposalDependencies(a.id)).sort()).toEqual(
      [b.id, c.id].sort(),
    )
    // Re-inserting the same pairs must not duplicate or error.
    await p.addProposalDependencies(a.id, [b.id, c.id])
    expect((await p.listProposalDependencies(a.id)).sort()).toEqual(
      [b.id, c.id].sort(),
    )
  })

  it('de-dups blocker ids passed in a single call', async () => {
    const p = await loadProposals(repo)
    const a = await p.createProposal('a')
    const b = await p.createProposal('b')
    await p.addProposalDependencies(a.id, [b.id, b.id])
    expect(await p.listProposalDependencies(a.id)).toEqual([b.id])
  })

  it('rejects a self-edge (an idea cannot block itself)', async () => {
    const p = await loadProposals(repo)
    const a = await p.createProposal('a')
    await expect(p.addProposalDependencies(a.id, [a.id])).rejects.toThrow(
      /cannot block itself/,
    )
    expect(await p.listProposalDependencies(a.id)).toEqual([])
  })

  it('rejects when a blocker id does not reference a real proposal', async () => {
    const p = await loadProposals(repo)
    const a = await p.createProposal('a')
    await expect(
      p.addProposalDependencies(a.id, ['nonexistent-id']),
    ).rejects.toThrow(/blocker nonexistent-id not found/)
    expect(await p.listProposalDependencies(a.id)).toEqual([])
  })

  it('rejects when the subject id does not exist', async () => {
    const p = await loadProposals(repo)
    const b = await p.createProposal('b')
    await expect(
      p.addProposalDependencies('nonexistent-proposal', [b.id]),
    ).rejects.toThrow(/proposal nonexistent-proposal not found/)
  })

  it('removeProposalDependency removes one edge and reports removed:false on a non-existent pair', async () => {
    const p = await loadProposals(repo)
    const a = await p.createProposal('a')
    const b = await p.createProposal('b')
    const c = await p.createProposal('c')
    await p.addProposalDependencies(a.id, [b.id, c.id])

    const r1 = await p.removeProposalDependency(a.id, b.id)
    expect(r1.removed).toBe(true)
    expect(await p.listProposalDependencies(a.id)).toEqual([c.id])

    const r2 = await p.removeProposalDependency(a.id, b.id)
    expect(r2.removed).toBe(false)
  })

  it('deleting a proposal cascades its planning-graph edges away', async () => {
    const p = await loadProposals(repo)
    const a = await p.createProposal('a')
    const b = await p.createProposal('b')
    await p.addProposalDependencies(a.id, [b.id])
    // b is referenced as a blocker; deleting b must not strand the edge.
    await p.deleteProposal(b.id)
    expect(await p.listProposalDependencies(a.id)).toEqual([])
  })
})
