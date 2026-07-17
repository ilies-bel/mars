import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface PromotionLedgerMod {
  initPromotionLedger: typeof import('../promotion-ledger').initPromotionLedger
  recordPromotionLedgerEntry: typeof import('../promotion-ledger').recordPromotionLedgerEntry
  listPromotionLedgerEntries: typeof import('../promotion-ledger').listPromotionLedgerEntries
  getLatestLedgerEntry: typeof import('../promotion-ledger').getLatestLedgerEntry
  PromotionDecisionSchema: typeof import('../promotion-ledger').PromotionDecisionSchema
  PromotionLedgerEntrySchema: typeof import('../promotion-ledger').PromotionLedgerEntrySchema
  __resetPromotionLedgerForTests: typeof import('../promotion-ledger').__resetPromotionLedgerForTests
}

interface StateClientMod {
  resolveStateClient: typeof import('../store/state-client').resolveStateClient
  __resetStateClientForTests: typeof import('../store/state-client').__resetStateClientForTests
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-pl-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadMods = async (
  repo: string,
): Promise<{ pl: PromotionLedgerMod; sc: StateClientMod }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const pl = (await import('../promotion-ledger')) as unknown as PromotionLedgerMod
  const sc = (await import('../store/state-client')) as unknown as StateClientMod
  await pl.initPromotionLedger()
  return { pl, sc }
}

describe('promotion_ledger table CRUD', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('recordPromotionLedgerEntry persists a row and round-trips through PromotionLedgerEntrySchema', async () => {
    const { pl, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    const entry = await pl.recordPromotionLedgerEntry(client, {
      workflow: 'task',
      candidateVersionId: 'wfc-v2',
      incumbentVersionId: 'wfc-v1',
      candidateScore: 0.82,
      incumbentScore: 0.75,
      candidateN: 30,
      incumbentN: 50,
      decision: 'promoted',
      decidedAt: 1700000000000,
    })

    expect(entry.workflow).toBe('task')
    expect(entry.candidateVersionId).toBe('wfc-v2')
    expect(entry.incumbentVersionId).toBe('wfc-v1')
    expect(entry.candidateScore).toBeCloseTo(0.82)
    expect(entry.incumbentScore).toBeCloseTo(0.75)
    expect(entry.candidateN).toBe(30)
    expect(entry.incumbentN).toBe(50)
    expect(entry.decision).toBe('promoted')
    expect(entry.decidedAt).toBe(1700000000000)
    expect(entry.createdAt).toBeGreaterThan(0)
    expect(entry.id).toMatch(/^pl-/)

    // Schema validates the full shape.
    expect(() => pl.PromotionLedgerEntrySchema.parse(entry)).not.toThrow()
  })

  it('PromotionDecisionSchema rejects unknown decision values', async () => {
    const { pl } = await loadMods(repo)
    const { PromotionDecisionSchema } = pl
    expect(() => PromotionDecisionSchema.parse('approved')).toThrow()
    expect(() => PromotionDecisionSchema.parse('rejected')).toThrow()
    expect(() => PromotionDecisionSchema.parse('done')).toThrow()
    expect(PromotionDecisionSchema.parse('promoted')).toBe('promoted')
    expect(PromotionDecisionSchema.parse('retired')).toBe('retired')
    expect(PromotionDecisionSchema.parse('pending')).toBe('pending')
  })

  it('recordPromotionLedgerEntry accepts null scores and null decidedAt for pending rows', async () => {
    const { pl, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    const entry = await pl.recordPromotionLedgerEntry(client, {
      workflow: 'fix',
      candidateVersionId: 'wfc-fix-v2',
      incumbentVersionId: 'wfc-fix-v1',
      candidateScore: null,
      incumbentScore: null,
      candidateN: 0,
      incumbentN: 0,
      decision: 'pending',
      decidedAt: null,
    })

    expect(entry.decision).toBe('pending')
    expect(entry.candidateScore).toBeNull()
    expect(entry.incumbentScore).toBeNull()
    expect(entry.decidedAt).toBeNull()
  })

  it('listPromotionLedgerEntries returns all rows ordered newest first', async () => {
    const { pl, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    const e1 = await pl.recordPromotionLedgerEntry(client, {
      workflow: 'task',
      candidateVersionId: 'wfc-v2',
      incumbentVersionId: 'wfc-v1',
      candidateScore: 0.7,
      incumbentScore: 0.6,
      candidateN: 20,
      incumbentN: 20,
      decision: 'promoted',
      decidedAt: 1700000001000,
    })
    const e2 = await pl.recordPromotionLedgerEntry(client, {
      workflow: 'task',
      candidateVersionId: 'wfc-v3',
      incumbentVersionId: 'wfc-v2',
      candidateScore: 0.65,
      incumbentScore: 0.7,
      candidateN: 10,
      incumbentN: 20,
      decision: 'retired',
      decidedAt: 1700000002000,
    })
    // Different workflow — should not appear in task-scoped list.
    await pl.recordPromotionLedgerEntry(client, {
      workflow: 'fix',
      candidateVersionId: 'wfc-fix-v2',
      incumbentVersionId: 'wfc-fix-v1',
      candidateScore: 0.9,
      incumbentScore: 0.8,
      candidateN: 15,
      incumbentN: 25,
      decision: 'promoted',
      decidedAt: 1700000003000,
    })

    const taskEntries = await pl.listPromotionLedgerEntries(client, 'task')
    expect(taskEntries).toHaveLength(2)
    // Newest first — e2 was inserted after e1.
    expect(taskEntries[0].id).toBe(e2.id)
    expect(taskEntries[1].id).toBe(e1.id)

    const fixEntries = await pl.listPromotionLedgerEntries(client, 'fix')
    expect(fixEntries).toHaveLength(1)
    expect(fixEntries[0].workflow).toBe('fix')
  })

  it('listPromotionLedgerEntries without a workflow filter returns all rows', async () => {
    const { pl, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    await pl.recordPromotionLedgerEntry(client, {
      workflow: 'task',
      candidateVersionId: 'wfc-v2',
      incumbentVersionId: 'wfc-v1',
      candidateScore: 0.7,
      incumbentScore: 0.6,
      candidateN: 20,
      incumbentN: 20,
      decision: 'promoted',
      decidedAt: null,
    })
    await pl.recordPromotionLedgerEntry(client, {
      workflow: 'fix',
      candidateVersionId: 'wfc-fix-v2',
      incumbentVersionId: 'wfc-fix-v1',
      candidateScore: 0.9,
      incumbentScore: 0.8,
      candidateN: 15,
      incumbentN: 25,
      decision: 'promoted',
      decidedAt: null,
    })

    const allEntries = await pl.listPromotionLedgerEntries(client)
    expect(allEntries).toHaveLength(2)
  })

  it('listPromotionLedgerEntries returns empty array for a workflow with no rows', async () => {
    const { pl, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    const entries = await pl.listPromotionLedgerEntries(client, 'plan')
    expect(entries).toHaveLength(0)
  })

  it('getLatestLedgerEntry returns the most recently inserted row for a workflow', async () => {
    const { pl, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    await pl.recordPromotionLedgerEntry(client, {
      workflow: 'task',
      candidateVersionId: 'wfc-v2',
      incumbentVersionId: 'wfc-v1',
      candidateScore: 0.7,
      incumbentScore: 0.6,
      candidateN: 20,
      incumbentN: 20,
      decision: 'promoted',
      decidedAt: 1700000001000,
    })
    const latest = await pl.recordPromotionLedgerEntry(client, {
      workflow: 'task',
      candidateVersionId: 'wfc-v3',
      incumbentVersionId: 'wfc-v2',
      candidateScore: 0.65,
      incumbentScore: 0.7,
      candidateN: 10,
      incumbentN: 20,
      decision: 'retired',
      decidedAt: 1700000002000,
    })

    const found = await pl.getLatestLedgerEntry(client, 'task')
    expect(found?.id).toBe(latest.id)
    expect(found?.decision).toBe('retired')
  })

  it('getLatestLedgerEntry returns null when no rows exist for the workflow', async () => {
    const { pl, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    const found = await pl.getLatestLedgerEntry(client, 'plan')
    expect(found).toBeNull()
  })

  it('getLatestLedgerEntry is scoped to the requested workflow', async () => {
    const { pl, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    await pl.recordPromotionLedgerEntry(client, {
      workflow: 'fix',
      candidateVersionId: 'wfc-fix-v2',
      incumbentVersionId: 'wfc-fix-v1',
      candidateScore: 0.9,
      incumbentScore: 0.8,
      candidateN: 15,
      incumbentN: 25,
      decision: 'promoted',
      decidedAt: null,
    })

    // Requesting for 'task' — should return null even though 'fix' has rows.
    const found = await pl.getLatestLedgerEntry(client, 'task')
    expect(found).toBeNull()
  })
})
