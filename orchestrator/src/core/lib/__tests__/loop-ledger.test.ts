/**
 * Unit tests for listLoopLedger (PRD 41aa2fb2, Watchtower slice 6).
 *
 * Tests drive a real SQLite file in a temp directory (via MARS_REPO) rather
 * than mocks, so the SQL join is exercised against actual data. The fixture
 * uses recordScorerResult / recordPromotionLedgerEntry so the DDL paths are
 * also covered — no raw INSERT bypasses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-loop-ledger-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadMods = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const [scorerMod, plMod, llMod] = await Promise.all([
    import('../../scorer-results') as Promise<typeof import('../../scorer-results')>,
    import('../../promotion-ledger') as Promise<typeof import('../../promotion-ledger')>,
    import('../loop-ledger') as Promise<typeof import('../loop-ledger')>,
  ])
  return { scorerMod, plMod, llMod }
}

describe('listLoopLedger', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns empty array when no scorer_results exist for the workflow', async () => {
    const { scorerMod, llMod } = await loadMods(repo)
    await scorerMod.initScorerResults()
    const entries = await llMod.listLoopLedger('task', 50)
    expect(entries).toEqual([])
  })

  it('returns entries ordered newest first, capped by limit', async () => {
    const { scorerMod, llMod } = await loadMods(repo)
    await scorerMod.initScorerResults()

    // Insert three scorer results in ascending order (oldest first).
    for (let i = 0; i < 3; i++) {
      await scorerMod.recordScorerResult({
        scorerId: `sc-${i}`,
        taskId: `task-${i}`,
        workflow: 'task',
        score: 0.5 + i * 0.1,
        rationale: 'ok',
        status: 'scored',
      })
    }

    // Limit to 2 — should return the 2 newest.
    const entries = await llMod.listLoopLedger('task', 2)
    expect(entries).toHaveLength(2)
    // Newest first: task-2 then task-1.
    expect(entries[0].runId).toBe('task-2')
    expect(entries[1].runId).toBe('task-1')
  })

  it('returns recorded=true for scored rows and recorded=false for error rows', async () => {
    const { scorerMod, llMod } = await loadMods(repo)
    await scorerMod.initScorerResults()

    await scorerMod.recordScorerResult({
      scorerId: 'sc-ok',
      taskId: 'task-ok',
      workflow: 'task',
      score: 0.8,
      rationale: 'good',
      status: 'scored',
    })
    await scorerMod.recordScorerResult({
      scorerId: 'sc-err',
      taskId: 'task-err',
      workflow: 'task',
      score: null,
      rationale: 'timeout',
      status: 'error',
    })

    const entries = await llMod.listLoopLedger('task', 50)
    const ok = entries.find((e) => e.runId === 'task-ok')
    const err = entries.find((e) => e.runId === 'task-err')

    expect(ok?.recorded).toBe(true)
    expect(ok?.score).toBeCloseTo(0.8)
    expect(err?.recorded).toBe(false)
    expect(err?.score).toBeNull()
  })

  it('suggestion and review are null when no promotion_ledger entry exists for this version', async () => {
    const { scorerMod, plMod, llMod } = await loadMods(repo)
    await scorerMod.initScorerResults()
    await plMod.initPromotionLedger()

    await scorerMod.recordScorerResult({
      scorerId: 'sc-1',
      taskId: 'task-1',
      workflow: 'task',
      score: 0.75,
      rationale: 'fine',
      status: 'scored',
      workflowConfigVersionId: 'wc-v1',
    })
    // promotion_ledger table exists but has no entry for wc-v1.

    const entries = await llMod.listLoopLedger('task', 50)
    expect(entries).toHaveLength(1)
    expect(entries[0].suggestion).toBeNull()
    expect(entries[0].review).toBeNull()
  })

  it('suggestion is set (pending) and review is null when gate is still pending', async () => {
    const { scorerMod, plMod, llMod } = await loadMods(repo)
    await scorerMod.initScorerResults()
    await plMod.initPromotionLedger()
    const { resolveStateClient } = await import('../../store/state-client')
    const client = resolveStateClient()

    await scorerMod.recordScorerResult({
      scorerId: 'sc-1',
      taskId: 'task-1',
      workflow: 'task',
      score: 0.75,
      rationale: 'fine',
      status: 'scored',
      workflowConfigVersionId: 'wc-v1',
    })

    await plMod.recordPromotionLedgerEntry(client, {
      workflow: 'task',
      candidateVersionId: 'wc-v1',
      incumbentVersionId: 'wc-v0',
      candidateScore: 0.75,
      incumbentScore: 0.65,
      candidateN: 5,
      incumbentN: 10,
      decision: 'pending',
      decidedAt: null,
    })

    const entries = await llMod.listLoopLedger('task', 50)
    expect(entries).toHaveLength(1)
    expect(entries[0].suggestion).toEqual({ version: 'wc-v1', decisionKind: 'pending' })
    expect(entries[0].review).toBeNull()
  })

  it('suggestion and review are both set when gate has been decided (promoted)', async () => {
    const { scorerMod, plMod, llMod } = await loadMods(repo)
    await scorerMod.initScorerResults()
    await plMod.initPromotionLedger()
    const { resolveStateClient } = await import('../../store/state-client')
    const client = resolveStateClient()

    await scorerMod.recordScorerResult({
      scorerId: 'sc-1',
      taskId: 'task-1',
      workflow: 'task',
      score: 0.9,
      rationale: 'excellent',
      status: 'scored',
      workflowConfigVersionId: 'wc-v2',
    })

    const decidedAt = 1_700_000_001_000
    await plMod.recordPromotionLedgerEntry(client, {
      workflow: 'task',
      candidateVersionId: 'wc-v2',
      incumbentVersionId: 'wc-v1',
      candidateScore: 0.9,
      incumbentScore: 0.75,
      candidateN: 10,
      incumbentN: 10,
      decision: 'promoted',
      decidedAt,
    })

    const entries = await llMod.listLoopLedger('task', 50)
    expect(entries).toHaveLength(1)
    expect(entries[0].suggestion).toEqual({ version: 'wc-v2', decisionKind: 'promoted' })
    expect(entries[0].review).toEqual({ decision: 'promoted', decidedAt })
  })

  it('uses the most-recent promotion_ledger row when multiple exist for the same version', async () => {
    const { scorerMod, plMod, llMod } = await loadMods(repo)
    await scorerMod.initScorerResults()
    await plMod.initPromotionLedger()
    const { resolveStateClient } = await import('../../store/state-client')
    const client = resolveStateClient()

    await scorerMod.recordScorerResult({
      scorerId: 'sc-1',
      taskId: 'task-1',
      workflow: 'task',
      score: 0.8,
      rationale: 'ok',
      status: 'scored',
      workflowConfigVersionId: 'wc-v3',
    })

    // Insert rows with explicit created_at so the ordering is deterministic
    // (recordPromotionLedgerEntry always uses Date.now(), which would be
    // the same millisecond for both rapid inserts).
    const decidedAt = 1_700_000_002_000
    // Older row: pending (created_at = 1_000).
    await client.execute({
      sql: `INSERT INTO promotion_ledger
              (id, workflow, candidate_version_id, incumbent_version_id,
               candidate_score, incumbent_score, candidate_n, incumbent_n,
               decision, decided_at, created_at)
            VALUES ('pl-old', 'task', 'wc-v3', 'wc-v2', 0.8, 0.7, 3, 5,
                    'pending', NULL, 1000)`,
      args: [],
    })
    // Newer row: retired (created_at = 2_000) — should win.
    await client.execute({
      sql: `INSERT INTO promotion_ledger
              (id, workflow, candidate_version_id, incumbent_version_id,
               candidate_score, incumbent_score, candidate_n, incumbent_n,
               decision, decided_at, created_at)
            VALUES ('pl-new', 'task', 'wc-v3', 'wc-v2', 0.8, 0.7, 10, 10,
                    'retired', ?, 2000)`,
      args: [decidedAt],
    })

    const entries = await llMod.listLoopLedger('task', 50)
    expect(entries).toHaveLength(1)
    // The most-recent ledger row is 'retired'.
    expect(entries[0].suggestion?.decisionKind).toBe('retired')
    expect(entries[0].review?.decision).toBe('retired')
  })

  it('does not cross-contaminate entries from different workflows', async () => {
    const { scorerMod, plMod, llMod } = await loadMods(repo)
    await scorerMod.initScorerResults()
    await plMod.initPromotionLedger()
    const { resolveStateClient } = await import('../../store/state-client')
    const client = resolveStateClient()

    // scorer result for 'task' workflow with version wc-v1.
    await scorerMod.recordScorerResult({
      scorerId: 'sc-task',
      taskId: 'task-1',
      workflow: 'task',
      score: 0.7,
      rationale: 'ok',
      status: 'scored',
      workflowConfigVersionId: 'wc-v1',
    })

    // promotion_ledger entry for 'fix' workflow also using 'wc-v1' as candidate.
    // Should NOT appear on the 'task' ledger results.
    await plMod.recordPromotionLedgerEntry(client, {
      workflow: 'fix',
      candidateVersionId: 'wc-v1',
      incumbentVersionId: 'wc-v0',
      candidateScore: 0.7,
      incumbentScore: 0.6,
      candidateN: 5,
      incumbentN: 5,
      decision: 'promoted',
      decidedAt: 1_700_000_001_000,
    })

    const entries = await llMod.listLoopLedger('task', 50)
    expect(entries).toHaveLength(1)
    // The promotion ledger row belongs to 'fix', not 'task' — no join match.
    expect(entries[0].suggestion).toBeNull()
    expect(entries[0].review).toBeNull()
  })
})
