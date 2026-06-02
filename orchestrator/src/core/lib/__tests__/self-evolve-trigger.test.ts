/**
 * Integration tests for runSelfEvolveTrigger.
 *
 * Each test gets a fresh git repo + mars.db so module-level singletons are
 * reset between tests (via vi.resetModules inside the loadContext helper).
 *
 * Four PRD-mandated cases:
 *  1. autoTrigger=false  → zero proposals, zero queued tasks
 *  2. autoTrigger=true, confident drift above threshold → exactly one draft proposal
 *     with source='reflection', title naming the KPI, body containing the full
 *     KPI vector.
 *  3. Dedup: re-running the trigger while the prior draft is still 'draft'
 *     creates zero additional proposals.
 *  4. Either snapshot below sample floor → zero proposals even if delta exceeds
 *     the threshold.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { openLibsql } from '../libsql.js'
import { createLibsqlTaskStore, type TaskStore } from '../task-store.js'
import type { ProposalSource } from '../../proposals.js'

// ---------------------------------------------------------------------------
// Test-DB DDL (minimal — initQueue brings the real schema, but we only need
// kpi_snapshots and a countable tasks table for the "no tasks queued" check).
// ---------------------------------------------------------------------------

const KPI_SNAPSHOTS_DDL = `
  CREATE TABLE IF NOT EXISTS kpi_snapshots (
    id TEXT PRIMARY KEY,
    taken_at TEXT NOT NULL,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    sample_count INTEGER NOT NULL,
    low_confidence INTEGER NOT NULL,
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
  // (The real initQueue schema is not needed here — we only SELECT COUNT(*).)
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

  const store = createLibsqlTaskStore(client)

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

/** Insert a synthetic kpi_snapshot row directly (bypasses takeKpiSnapshot logic). */
const insertSnapshot = async (
  store: TaskStore,
  opts: {
    id: string
    takenAt: string
    failureRate: number | null
    lowConfidence: 0 | 1
  },
): Promise<void> => {
  await store.execute({
    sql: `INSERT INTO kpi_snapshots
            (id, taken_at, window_start, window_end,
             sample_count, low_confidence,
             cost_per_arc_p50, cost_per_arc_p90,
             failure_rate, autonomous_completion_rate, recovery_success_rate)
          VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL)`,
    args: [
      opts.id,
      opts.takenAt,
      opts.takenAt, // window_start (same for test simplicity)
      opts.takenAt, // window_end
      opts.lowConfidence === 0 ? 10 : 2, // sample_count > floor when confident
      opts.lowConfidence,
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
      lowConfidence: 0,
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-02T00:00:00Z',
      failureRate: 0.25, // +150% — well above any threshold
      lowConfidence: 0,
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
      lowConfidence: 0,
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-02T00:00:00Z',
      failureRate: 0.25,
      lowConfidence: 0,
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
      lowConfidence: 0,
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-02T00:00:00Z',
      failureRate: 0.25,
      lowConfidence: 0,
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

  // PRD case 4: either snapshot below sample floor → zero proposals even if the
  // relative delta would exceed the threshold.
  it('creates zero proposals when either snapshot is below the sample floor', async () => {
    process.env.MARS_SELF_EVOLVE_AUTO_TRIGGER = 'true'
    const ctx = await loadContext(repo)

    // prior confident, current low-confidence (sample floor not met)
    await insertSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
      lowConfidence: 0, // confident
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-02T00:00:00Z',
      failureRate: 0.25, // large drift
      lowConfidence: 1, // NOT confident
    })

    const tasksBefore = await ctx.countTasks()
    const result = await ctx.runSelfEvolveTrigger({ store: ctx.store })
    const tasksAfter = await ctx.countTasks()

    expect(result.raised).toHaveLength(0)
    expect(tasksAfter).toBe(tasksBefore)
    const proposals = await ctx.listProposals({ source: 'reflection' })
    expect(proposals).toHaveLength(0)
  })

  it('creates zero proposals when the prior snapshot is below the sample floor', async () => {
    process.env.MARS_SELF_EVOLVE_AUTO_TRIGGER = 'true'
    const ctx = await loadContext(repo)

    // prior low-confidence, current confident
    await insertSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
      lowConfidence: 1, // NOT confident
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-02T00:00:00Z',
      failureRate: 0.25,
      lowConfidence: 0, // confident
    })

    const result = await ctx.runSelfEvolveTrigger({ store: ctx.store })
    expect(result.raised).toHaveLength(0)
    const proposals = await ctx.listProposals({ source: 'reflection' })
    expect(proposals).toHaveLength(0)
  })
})
