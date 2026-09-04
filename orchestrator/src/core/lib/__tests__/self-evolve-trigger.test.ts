/**
 * Integration tests for runSelfEvolveTrigger.
 *
 * Each test gets a fresh git repo + mars.db so module-level singletons are
 * reset between tests (via vi.resetModules inside the loadContext helper).
 *
 * PRD-mandated cases:
 *  1. autoTrigger=false  → zero proposals, zero queued tasks
 *  2. autoTrigger=true, confident drift above threshold → exactly one draft proposal
 *     with source='reflection', title naming the KPI, body containing the full
 *     KPI vector.
 *  3. Dedup: re-running the trigger while the prior draft is still 'draft'
 *     creates zero additional proposals.
 *  4. Either snapshot below sample floor → zero proposals even if delta exceeds
 *     the threshold (per-KPI: failure_rate low-confidence suppresses failure_rate only).
 *  5. Per-KPI confidence: cost_per_arc low-confidence on one side skips cost_per_arc_p50
 *     and cost_per_arc_p90 (with reason 'low-confidence') but still raises a proposal
 *     for failure_rate when failure_rate is confident on both sides and regresses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { openLibsql } from '../libsql.js'
import { createTaskStore, type DomainTaskStore as TaskStore } from '../../store/task-store.js'
import type { ProposalSource } from '../../proposals.js'
import type { KpiArcRow } from '../kpi-compute.js'

// ---------------------------------------------------------------------------
// Module-level mock for kpi-compute.js.
//
// listCostPerArcArcs uses PostgreSQL-specific JSON operators (::jsonb,
// json_object_agg) that libsql/SQLite does not support, so in-process tests
// cannot call it against the real DB.  We stub it here with a controllable
// variable; the phaseMedians test sets phaseEnrichmentArcs before running the
// trigger so the enrichment block receives pre-built arcs.  All other tests
// leave it as [] (the branch is never entered for failure_rate regressions).
// ---------------------------------------------------------------------------
let phaseEnrichmentArcs: KpiArcRow[] = []
vi.mock('../kpi-compute.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../kpi-compute.js')>()
  return {
    ...mod,
    listCostPerArcArcs: vi.fn().mockImplementation(() =>
      Promise.resolve(phaseEnrichmentArcs),
    ),
  }
})

// ---------------------------------------------------------------------------
// Test-DB DDL — per-KPI schema matching kpi-snapshots.ts (slice 1).
// Each KPI has its own sample_count and low_confidence column pair.
// ---------------------------------------------------------------------------

const KPI_SNAPSHOTS_DDL = `
  CREATE TABLE IF NOT EXISTS kpi_snapshots (
    id TEXT PRIMARY KEY,
    taken_at TEXT NOT NULL,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    cost_per_arc_sample_count INTEGER NOT NULL DEFAULT 0,
    cost_per_arc_low_confidence INTEGER NOT NULL DEFAULT 0,
    failure_rate_sample_count INTEGER NOT NULL DEFAULT 0,
    failure_rate_low_confidence INTEGER NOT NULL DEFAULT 0,
    autonomous_completion_rate_sample_count INTEGER NOT NULL DEFAULT 0,
    autonomous_completion_rate_low_confidence INTEGER NOT NULL DEFAULT 0,
    recovery_success_rate_sample_count INTEGER NOT NULL DEFAULT 0,
    recovery_success_rate_low_confidence INTEGER NOT NULL DEFAULT 0,
    cost_per_arc_p50 REAL,
    cost_per_arc_p90 REAL,
    failure_rate REAL,
    autonomous_completion_rate REAL,
    recovery_success_rate REAL
  )
`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-set-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

interface TestContext {
  runSelfEvolveTrigger: (opts?: { store?: TaskStore }) => Promise<{
    raised: string[]
    skipped: Array<{ kpi: string; reason: string }>
  }>
  store: TaskStore
  listProposals: (opts?: { status?: string; source?: ProposalSource }) => Promise<Array<{
    id: string
    title: string
    problem: string
    solution: string
    notes: string
    source: string
    status: string
    kpiTag?: string | null
  }>>
  countTasks: () => Promise<number>
}

/**
 * Reset modules, set MARS_REPO, initialize the DB, and return the trigger +
 * helpers that share the same mars.db.
 */
const loadContext = async (repo: string): Promise<TestContext> => {
  vi.resetModules()
  process.env.MARS_REPO = repo

  // Open a direct client to the shared mars.db for kpi_snapshots inserts and
  // task counting. The trigger's optional `store` parameter accepts this.
  const dbPath = resolve(repo, '.mars', 'mars.db')
  const client = openLibsql({ url: `file:${dbPath}` })
  await client.execute(KPI_SNAPSHOTS_DDL)

  // Minimal tasks table so we can count rows and prove no tasks were enqueued.
  // (The real migrateQueueSchema schema is not needed here — we only SELECT COUNT(*).)
  await client.execute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      priority INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  // initProposals needs the proposals table in the same mars.db.
  const { initProposals, listProposals: listProposalsFn } = await import('../../proposals.js')
  await initProposals()

  const store = createTaskStore(client)

  const { runSelfEvolveTrigger } = await import('../self-evolve-trigger.js')

  const listProposals = async (opts?: { status?: string; source?: ProposalSource }) => {
    return listProposalsFn(opts)
  }

  const countTasks = async (): Promise<number> => {
    const r = await store.query({ sql: 'SELECT COUNT(*) as n FROM tasks', args: [] })
    const row = r.rows[0] as unknown as { n: number }
    return row.n
  }

  return { runSelfEvolveTrigger, store, listProposals, countTasks }
}

/**
 * Insert a synthetic kpi_snapshot row directly (bypasses takeKpiSnapshot logic).
 * All per-KPI low_confidence flags default to 0; pass explicit flags to override.
 */
const insertSnapshot = async (
  store: TaskStore,
  opts: {
    id: string
    takenAt: string
    failureRate: number | null
    costPerArcP50?: number | null
    costPerArcP90?: number | null
    failureRateLowConfidence?: 0 | 1
    costPerArcLowConfidence?: 0 | 1
    autonomousCompletionRateLowConfidence?: 0 | 1
    recoverySuccessRateLowConfidence?: 0 | 1
  },
): Promise<void> => {
  const frConf = opts.failureRateLowConfidence ?? 0
  const costConf = opts.costPerArcLowConfidence ?? 0
  const acrConf = opts.autonomousCompletionRateLowConfidence ?? 0
  const rsrConf = opts.recoverySuccessRateLowConfidence ?? 0

  // Use a proper 7-day window so readKpiWindowComparison can find non-overlapping
  // prior/current pairs. window_start = takenAt − 7d; window_end = takenAt.
  // Strip milliseconds (.000Z → Z) so the string format matches the fixture
  // takenAt values — SQLite compares timestamps lexicographically and 'Z' > '.'
  // so '2026-01-01T00:00:00Z' > '2026-01-01T00:00:00.000Z'.
  const windowStart = new Date(
    new Date(opts.takenAt).getTime() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString().replace(/\.\d{3}Z$/, 'Z')

  await store.execute({
    sql: `INSERT INTO kpi_snapshots
            (id, taken_at, window_start, window_end,
             cost_per_arc_sample_count, cost_per_arc_low_confidence,
             failure_rate_sample_count, failure_rate_low_confidence,
             autonomous_completion_rate_sample_count, autonomous_completion_rate_low_confidence,
             recovery_success_rate_sample_count, recovery_success_rate_low_confidence,
             cost_per_arc_p50, cost_per_arc_p90,
             failure_rate, autonomous_completion_rate, recovery_success_rate)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    args: [
      opts.id,
      opts.takenAt,
      windowStart, // window_start = takenAt − 7d
      opts.takenAt, // window_end = takenAt
      costConf === 0 ? 10 : 2, // cost_per_arc_sample_count
      costConf,
      frConf === 0 ? 10 : 2,   // failure_rate_sample_count
      frConf,
      acrConf === 0 ? 10 : 2,  // autonomous_completion_rate_sample_count
      acrConf,
      rsrConf === 0 ? 10 : 2,  // recovery_success_rate_sample_count
      rsrConf,
      opts.costPerArcP50 ?? null,
      opts.costPerArcP90 ?? null,
      opts.failureRate,
    ],
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSelfEvolveTrigger', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    phaseEnrichmentArcs = [] // reset between tests so the mock is inert by default
    rmSync(repo, { recursive: true, force: true })
  })

  // ADR-0038: the trigger always runs (no autoEnqueue gate) and only raises proposals.
  // With no snapshots on disk, it is a no-op.
  it('is a no-op when no KPI snapshots exist', async () => {
    const ctx = await loadContext(repo)
    // No snapshots inserted — function returns early at readSnapshotsForDrift.
    const tasksBefore = await ctx.countTasks()
    const result = await ctx.runSelfEvolveTrigger({ store: ctx.store })
    const tasksAfter = await ctx.countTasks()

    expect(result.raised).toHaveLength(0)
    expect(tasksAfter).toBe(tasksBefore) // no tasks queued — proposals only, ADR-0038
    const proposals = await ctx.listProposals({ source: 'reflection' })
    expect(proposals).toHaveLength(0)
  })

  // ADR-0038: trigger is always on; raises proposals (never tasks) for confirmed regressions.
  it('raises exactly one draft proposal for a confirmed regression', async () => {
    const ctx = await loadContext(repo)

    // prior: failure_rate=0.10; current: 0.25 → +150% regression (lower-is-better)
    await insertSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-08T00:00:00Z',
      failureRate: 0.25,
    })

    const tasksBefore = await ctx.countTasks()
    const result = await ctx.runSelfEvolveTrigger({ store: ctx.store })
    const tasksAfter = await ctx.countTasks()

    // Exactly one proposal raised
    expect(result.raised).toHaveLength(1)
    expect(result.skipped).toHaveLength(0)

    // Task count unchanged — no tasks were queued
    expect(tasksAfter).toBe(tasksBefore)

    // Proposal has the right shape
    const proposals = await ctx.listProposals({ source: 'reflection' })
    expect(proposals).toHaveLength(1)
    const p = proposals[0]

    expect(p.source).toBe('reflection')
    expect(p.status).toBe('draft')
    // Title must name the regressed KPI
    expect(p.title).toContain('failure_rate')
    // Problem body contains the regressed delta
    expect(p.problem).toContain('failure_rate')
    expect(p.problem).toContain('0.1')   // priorValue
    expect(p.problem).toContain('0.25')  // currentValue
    // Notes is a KpiDriftProposalNotes JSON blob; the vector is nested inside it
    const notesObj = JSON.parse(p.notes) as { vector: Record<string, { prior: number; current: number }> }
    expect(notesObj).toHaveProperty('vector')
    expect(notesObj.vector).toHaveProperty('failure_rate')
    expect(notesObj.vector.failure_rate.prior).toBe(0.10)
    expect(notesObj.vector.failure_rate.current).toBe(0.25)
  })

  // PRD case 3: dedup — re-running while prior draft is still 'draft' creates
  // zero additional proposals.
  it('skips raising a duplicate when an open draft already exists for the same KPI', async () => {
    const ctx = await loadContext(repo)

    await insertSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-08T00:00:00Z',
      failureRate: 0.25,
    })

    // First run — raises one proposal
    const first = await ctx.runSelfEvolveTrigger({ store: ctx.store })
    expect(first.raised).toHaveLength(1)

    // Second run on the same snapshots — the prior draft is still in 'draft'
    const second = await ctx.runSelfEvolveTrigger({ store: ctx.store })
    expect(second.raised).toHaveLength(0)
    expect(second.skipped).toHaveLength(1)
    expect(second.skipped[0].reason).toBe('duplicate')

    // Only one proposal exists in total
    const proposals = await ctx.listProposals({ source: 'reflection' })
    expect(proposals).toHaveLength(1)
  })

  // PRD case 4: failure_rate low-confidence on the current snapshot suppresses
  // failure_rate (per-KPI gating), producing zero proposals.
  it('creates zero proposals when the current snapshot has failure_rate_low_confidence=1', async () => {
    const ctx = await loadContext(repo)

    await insertSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
      // failure_rate_low_confidence: 0 (default — confident)
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-08T00:00:00Z',
      failureRate: 0.25, // large drift — would trigger if confident
      failureRateLowConfidence: 1, // NOT confident
    })

    const tasksBefore = await ctx.countTasks()
    const result = await ctx.runSelfEvolveTrigger({ store: ctx.store })
    const tasksAfter = await ctx.countTasks()

    expect(result.raised).toHaveLength(0)
    expect(tasksAfter).toBe(tasksBefore)
    const proposals = await ctx.listProposals({ source: 'reflection' })
    expect(proposals).toHaveLength(0)
  })

  it('creates zero proposals when the prior snapshot has failure_rate_low_confidence=1', async () => {
    const ctx = await loadContext(repo)

    await insertSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
      failureRateLowConfidence: 1, // NOT confident
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-08T00:00:00Z',
      failureRate: 0.25,
      // failure_rate_low_confidence: 0 (default — confident)
    })

    const result = await ctx.runSelfEvolveTrigger({ store: ctx.store })
    expect(result.raised).toHaveLength(0)
    const proposals = await ctx.listProposals({ source: 'reflection' })
    expect(proposals).toHaveLength(0)
  })

  // PRD case 5 (acceptance criterion): per-KPI confidence gating.
  // cost_per_arc_low_confidence=1 on one side suppresses cost_per_arc_p50 and
  // cost_per_arc_p90 (added to skipped with reason 'low-confidence'), while
  // failure_rate remains confident on both sides and its regression is still raised.
  it('raises a proposal only for failure_rate and skips cost_per_arc when cost_per_arc is low-confidence on one side', async () => {
    const ctx = await loadContext(repo)

    // Prior: failure_rate=0.10, cost_per_arc confident (both flags 0)
    await insertSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
      costPerArcP50: 1.0,
      costPerArcP90: 2.0,
      // failure_rate_low_confidence: 0 (default)
      // cost_per_arc_low_confidence: 0 (default)
    })
    // Current: failure_rate regresses (+150%), cost_per_arc low-confidence
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-08T00:00:00Z',
      failureRate: 0.25,
      costPerArcP50: 1.5,
      costPerArcP90: 2.5,
      // failure_rate_low_confidence: 0 (default — confident on both sides)
      costPerArcLowConfidence: 1, // low-confidence on current side
    })

    const result = await ctx.runSelfEvolveTrigger({ store: ctx.store })

    // Exactly one proposal raised — for failure_rate
    expect(result.raised).toHaveLength(1)

    // cost_per_arc_p50 and cost_per_arc_p90 are in skipped with reason 'low-confidence'
    const lowConfSkipped = result.skipped.filter(s => s.reason === 'low-confidence')
    expect(lowConfSkipped.map(s => s.kpi).sort()).toEqual(['cost_per_arc_p50', 'cost_per_arc_p90'])

    // The raised proposal is for failure_rate
    const proposals = await ctx.listProposals({ source: 'reflection' })
    expect(proposals).toHaveLength(1)
    expect(proposals[0].title).toContain('failure_rate')
  })

  // Phase-enrichment: cost_per_arc_p50 proposals include a phaseMedians breakdown.
  // listCostPerArcArcs is stubbed via the module-level vi.mock (it uses PG-specific
  // SQL that libsql/SQLite cannot execute).  phaseEnrichmentArcs controls what the
  // stub returns; it is reset to [] in afterEach.
  it('enriches cost_per_arc_p50 proposal notes with phaseMedians', async () => {
    // Three arcs with distinct per-phase costs so we can verify the median
    // independently of the DB query layer:
    //   code:   [300, 400, 600]  → sorted median = 400
    //   verify: [150, 200, 200]  → sorted median = 200
    //   setup:  [ 50, 100, 100]  → sorted median = 100
    phaseEnrichmentArcs = [
      {
        arcId: 'arc1', originTaskId: 'arc1', title: '', status: 'done', passed: true,
        costTokens: 900, phaseBreakdown: { code: 600, verify: 200, setup: 100 },
      },
      {
        arcId: 'arc2', originTaskId: 'arc2', title: '', status: 'done', passed: true,
        costTokens: 700, phaseBreakdown: { code: 400, verify: 200, setup: 100 },
      },
      {
        arcId: 'arc3', originTaskId: 'arc3', title: '', status: 'done', passed: true,
        costTokens: 500, phaseBreakdown: { code: 300, verify: 150, setup: 50 },
      },
    ]

    const ctx = await loadContext(repo)

    // cost_per_arc_p50: 500 → 700 (+40%) lower-is-better regression.
    // cost_per_arc_p90 is deliberately null in both snapshots so the detector
    // only fires for p50 — avoiding the near-duplicate title dedup that would
    // otherwise collapse both proposals into the p50 draft and corrupt its notes.
    // failure_rate is also null so it is excluded from drift detection.
    await insertSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: null,
      costPerArcP50: 500,
      costPerArcP90: null,
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-08T00:00:00Z',
      failureRate: null,
      costPerArcP50: 700,
      costPerArcP90: null,
    })

    const result = await ctx.runSelfEvolveTrigger({ store: ctx.store })

    // At least the cost_per_arc_p50 proposal must have been raised
    expect(result.raised.length).toBeGreaterThanOrEqual(1)

    // Find the cost_per_arc_p50 proposal by its title (the title always contains
    // the KPI name per the trigger's title-building logic)
    const proposals = await ctx.listProposals({ source: 'reflection' })
    const p50Proposal = proposals.find(p => p.title.includes('cost_per_arc_p50'))
    expect(p50Proposal).toBeDefined()

    // The notes JSON must carry a phaseMedians block alongside the vector
    const notesObj = JSON.parse(p50Proposal!.notes) as {
      kpi: string
      vector: Record<string, { prior: number; current: number }>
      phaseMedians?: Record<string, number>
    }
    expect(notesObj).toHaveProperty('vector')
    expect(notesObj).toHaveProperty('phaseMedians')
    // code: [300, 400, 600] sorted → median = 400
    // verify: [150, 200, 200] sorted → median = 200
    // setup: [50, 100, 100] sorted → median = 100
    expect(notesObj.phaseMedians).toEqual({ code: 400, verify: 200, setup: 100 })

    // Non-cost proposals (failure_rate) are not raised in this scenario because
    // failure_rate is null in both snapshots and never enters the detector
    const failureProposal = proposals.find(p => p.title.includes('failure_rate'))
    expect(failureProposal).toBeUndefined()
  })

  // driftThresholdPct: prove the value changes what gets raised.
  // With a threshold of 200% only a >200% drift fires; with 10% (default) a 50% drift fires.
  it('respects driftThresholdPct — a drift below the threshold is not raised', async () => {
    process.env.MARS_SELF_EVOLVE_AUTO_TRIGGER = 'true'
    // Set threshold to 200% so a 50% regression is below threshold
    process.env.MARS_SELF_EVOLVE_DRIFT_THRESHOLD = '200'
    const ctx = await loadContext(repo)

    // prior: 0.10, current: 0.15 — +50% drift (lower-is-better regression)
    await insertSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-08T00:00:00Z',
      failureRate: 0.15,
    })

    const result = await ctx.runSelfEvolveTrigger({ store: ctx.store })

    // Below the 200% threshold — no proposal raised
    expect(result.raised).toHaveLength(0)
    const proposals = await ctx.listProposals({ source: 'reflection' })
    expect(proposals).toHaveLength(0)

    // Reset to a low threshold so the same drift IS raised
    delete process.env.MARS_SELF_EVOLVE_DRIFT_THRESHOLD
    vi.resetModules()
    process.env.MARS_SELF_EVOLVE_DRIFT_THRESHOLD = '10'
    const ctx2 = await loadContext(repo)

    const result2 = await ctx2.runSelfEvolveTrigger({ store: ctx2.store })
    // With threshold=10% the 50% drift is above threshold — one proposal raised
    expect(result2.raised).toHaveLength(1)
  })
})
