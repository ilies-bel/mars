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

describe('kpi_tag column migration', () => {
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

  it('adds kpi_tag to a pre-existing proposals table and preserves existing rows', async () => {
    const stateDb = `file:${repo}/.mars/mars.db`
    // Seed a proposals table that lacks the kpi_tag column (simulates an
    // older schema vintage).
    const seed = createClient({ url: stateDb })
    await seed.execute(`CREATE TABLE proposals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      problem TEXT NOT NULL DEFAULT '',
      solution TEXT NOT NULL DEFAULT '',
      out_of_scope TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      source TEXT NOT NULL DEFAULT 'human',
      author_kind TEXT,
      author_name TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )`)
    await seed.execute({
      sql: `INSERT INTO proposals (id, title, created_at, updated_at)
            VALUES ('pre01-legacy', 'Pre-existing row', 0, 0)`,
      args: [],
    })
    seed.close()

    const { initProposals } = await import('../proposals')
    await initProposals()

    // Verify the column was added
    const verify = createClient({ url: stateDb })
    const cols = await verify.execute(`PRAGMA table_info(proposals)`)
    const colNames = new Set(
      (cols.rows as unknown as Array<{ name: string }>).map((r) => r.name),
    )
    expect(colNames.has('kpi_tag')).toBe(true)

    // Verify the pre-existing row survived with kpi_tag defaulting to NULL
    const row = await verify.execute({
      sql: `SELECT id, kpi_tag FROM proposals WHERE id = 'pre01-legacy'`,
      args: [],
    })
    verify.close()
    expect(row.rows).toHaveLength(1)
    expect(
      (row.rows[0] as unknown as { kpi_tag: string | null }).kpi_tag,
    ).toBeNull()
  })
})
