import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@libsql/client'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-kpi-dedup-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('findOpenReflectionDraftForKpi', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns null when there are no proposals', async () => {
    const { initProposals, findOpenReflectionDraftForKpi } = await import(
      '../proposals'
    )
    await initProposals()
    expect(await findOpenReflectionDraftForKpi('token_usage')).toBeNull()
  })

  it('returns the matching draft when one exists', async () => {
    const { initProposals, createProposal, findOpenReflectionDraftForKpi } =
      await import('../proposals')
    await initProposals()
    const created = await createProposal('Reduce token waste', {
      source: 'reflection',
      kpiTag: 'token_usage',
    })
    const result = await findOpenReflectionDraftForKpi('token_usage')
    expect(result).toEqual({ id: created.id, title: created.title })
  })

  it('returns null when the matching draft is dismissed', async () => {
    const {
      initProposals,
      createProposal,
      setProposalField,
      findOpenReflectionDraftForKpi,
    } = await import('../proposals')
    await initProposals()
    const created = await createProposal('Old cache reflection', {
      source: 'reflection',
      kpiTag: 'cache_hit_rate',
    })
    await setProposalField(created.id, 'status', 'dismissed')
    expect(await findOpenReflectionDraftForKpi('cache_hit_rate')).toBeNull()
  })

  it('returns null when the matching draft is promoted (prd-ready)', async () => {
    const {
      initProposals,
      createProposal,
      setProposalField,
      findOpenReflectionDraftForKpi,
    } = await import('../proposals')
    await initProposals()
    const created = await createProposal('Promoted success-rate fix', {
      source: 'reflection',
      kpiTag: 'success_rate',
    })
    await setProposalField(created.id, 'problem', 'a problem')
    await setProposalField(created.id, 'status', 'prd-ready')
    expect(await findOpenReflectionDraftForKpi('success_rate')).toBeNull()
  })

  it('returns null when the matching draft is sliced', async () => {
    const {
      initProposals,
      createProposal,
      setProposalField,
      findOpenReflectionDraftForKpi,
    } = await import('../proposals')
    await initProposals()
    const created = await createProposal('Sliced latency proposal', {
      source: 'reflection',
      kpiTag: 'p95_latency',
    })
    await setProposalField(created.id, 'problem', 'a problem')
    await setProposalField(created.id, 'status', 'prd-ready')
    await setProposalField(created.id, 'status', 'slicing')
    await setProposalField(created.id, 'status', 'sliced')
    expect(await findOpenReflectionDraftForKpi('p95_latency')).toBeNull()
  })

  it('returns null when the matching proposal has a different source', async () => {
    const { initProposals, createProposal, findOpenReflectionDraftForKpi } =
      await import('../proposals')
    await initProposals()
    // Human and planner proposals with the same kpi_tag should not match
    await createProposal('Human token proposal', {
      source: 'human',
      kpiTag: 'token_usage',
    })
    await createProposal('Planner token proposal', {
      source: 'planner',
      kpiTag: 'token_usage',
    })
    expect(await findOpenReflectionDraftForKpi('token_usage')).toBeNull()
  })

  it('returns the most recent when multiple matching drafts exist', async () => {
    const { initProposals, createProposal, findOpenReflectionDraftForKpi } =
      await import('../proposals')
    await initProposals()
    const older = await createProposal('Older token proposal', {
      source: 'reflection',
      kpiTag: 'token_usage',
    })
    const newer = await createProposal('Newer token proposal', {
      source: 'reflection',
      kpiTag: 'token_usage',
    })
    // Push older's created_at back 10 seconds so the ordering is deterministic
    const stateDb = `file:${repo}/.mars/mars.db`
    const c = createClient({ url: stateDb })
    await c.execute({
      sql: `UPDATE proposals SET created_at = created_at - 10000 WHERE id = ?`,
      args: [older.id],
    })
    c.close()

    const result = await findOpenReflectionDraftForKpi('token_usage')
    expect(result).toEqual({ id: newer.id, title: newer.title })
  })
})
