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
      opts.takenAt, // window_start (same for test simplicity)
      opts.takenAt, // window_end
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
    delete process.env.MARS_SELF_EVOLVE_AUTO_TRIGGER
    rmSync(repo, { recursive: true, force: true })
  })

  // PRD case 1: autoTrigger=false → no proposals, no queued tasks
  it('is a no-op when autoTrigger is false (default)', async () => {
    // Default is false — do not set MARS_SELF_EVOLVE_AUTO_TRIGGER
    const ctx = await loadContext(repo)

    // Insert two confident snapshots with a large drift to confirm the guard
    // is purely the autoTrigger switch, not the absence of data.
    await insertSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-02T00:00:00Z',
      failureRate: 0.25, // +150% — well above any threshold
    })

    const tasksBefore = await ctx.countTasks()
    const result = await ctx.runSelfEvolveTrigger({ store: ctx.store })
    const tasksAfter = await ctx.countTasks()

    expect(result.raised).toHaveLength(0)
    expect(tasksAfter).toBe(tasksBefore) // no tasks queued
    const proposals = await ctx.listProposals({ source: 'reflection' })
    expect(proposals).toHaveLength(0)
  })

  // PRD case 2: autoTrigger=true, confident drift above threshold → exactly one
  // draft proposal with source='reflection', status='draft', title naming the
  // regressed KPI, body containing both the regressed delta and the full vector.
  it('raises exactly one draft proposal for a confirmed regression when enabled', async () => {
    process.env.MARS_SELF_EVOLVE_AUTO_TRIGGER = 'true'
    const ctx = await loadContext(repo)

    // prior: failure_rate=0.10; current: 0.25 → +150% regression (lower-is-better)
    await insertSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-02T00:00:00Z',
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
    // Notes contains the full KPI vector JSON
    const vector = JSON.parse(p.notes) as Record<string, { prior: number; current: number }>
    expect(vector).toHaveProperty('failure_rate')
    expect(vector.failure_rate.prior).toBe(0.10)
    expect(vector.failure_rate.current).toBe(0.25)
  })

  // PRD case 3: dedup — re-running while prior draft is still 'draft' creates
  // zero additional proposals.
  it('skips raising a duplicate when an open draft already exists for the same KPI', async () => {
    process.env.MARS_SELF_EVOLVE_AUTO_TRIGGER = 'true'
    const ctx = await loadContext(repo)

    await insertSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-02T00:00:00Z',
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
    process.env.MARS_SELF_EVOLVE_AUTO_TRIGGER = 'true'
    const ctx = await loadContext(repo)

    await insertSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
      // failure_rate_low_confidence: 0 (default — confident)
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-02T00:00:00Z',
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
    process.env.MARS_SELF_EVOLVE_AUTO_TRIGGER = 'true'
    const ctx = await loadContext(repo)

    await insertSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
      failureRateLowConfidence: 1, // NOT confident
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-02T00:00:00Z',
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
    process.env.MARS_SELF_EVOLVE_AUTO_TRIGGER = 'true'
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
      takenAt: '2026-01-02T00:00:00Z',
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
})
