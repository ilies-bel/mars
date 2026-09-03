/**
 * Tests for `mars kpi acknowledge` CLI command and the acknowledgment
 * suppression wired into `runSelfEvolveTrigger`.
 *
 * Two test sections:
 *
 *   1. CLI round-trip (PGlite via getTestDb): exercises the `kpi acknowledge`
 *      command paths end-to-end — upsert, list, clear, error cases.
 *
 *   2. Suppression integration (LibSQL + MARS_REPO): mirrors the pattern used
 *      by self-evolve-trigger.test.ts to verify that acknowledging a KPI
 *      baseline suppresses drift proposals and clearing restores detection.
 */

// ── Section 1 — CLI round-trip ─────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { getTestDb } from '../../../../test/db-fixture.js'
import type { DbClient } from '../../../core/lib/db.js'
import type { InProcessOptions } from '../../test-adapter'
import type { OrchestratorContext } from '../../../core/context'

const makeCtx = (): OrchestratorContext => ({
  repoRoot: '/tmp/kpi-ack-test',
  stateDir: '/tmp/kpi-ack-test/.mars',
  queueDbPath: '/tmp/kpi-ack-test/.mars/queue.db',
  observabilityDbPath: '/tmp/kpi-ack-test/.mars/observability.db',
  stateDbPath: '/tmp/kpi-ack-test/.mars/state.db',
})

const loadDeps = async (db: DbClient): Promise<Omit<InProcessOptions, 'daemon'>> => {
  const storeModule = await import('../../../core/store/task-store.js')
  return {
    store: storeModule.createTaskStore(db),
    ctx: makeCtx(),
  }
}

const run = async (
  argv: readonly string[],
  opts: InProcessOptions,
): Promise<{ code: number; out: string[]; err: string[] }> => {
  const { runCommandInProcess } = await import('../../test-adapter.js')
  return runCommandInProcess(argv, opts)
}

const makeFake = async () => {
  const { makeFakeDaemon } = await import('../../test-adapter.js')
  return makeFakeDaemon()
}

/** Insert a minimal kpi_snapshots row so `kpi acknowledge <key>` can read a value. */
async function insertKpiSnapshot(
  db: DbClient,
  opts: { id: string; costP50: number | null; failureRate: number | null },
): Promise<void> {
  await db.execute({
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
      '2026-09-01T00:00:00Z',
      '2026-08-25T00:00:00Z',
      '2026-09-01T00:00:00Z',
      10, 0, // cost_per_arc_sample_count / low_confidence
      10, 0, // failure_rate_sample_count / low_confidence
      10, 0, // autonomous_completion_rate
      10, 0, // recovery_success_rate
      opts.costP50,
      null, // cost_per_arc_p90
      opts.failureRate,
    ],
  })
}

describe('mars kpi acknowledge — CLI round-trip', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await getTestDb()
    vi.resetModules()
  })

  it('exits 0 and prints "no acknowledged baselines" when no row exists', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(['kpi', 'acknowledge', '--list'], { ...deps, daemon: fake })

    expect(result.code).toBe(0)
    expect(result.out.join('\n')).toContain('no acknowledged baselines')
  })

  it('exits 1 and shows usage when key is missing', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(['kpi', 'acknowledge'], { ...deps, daemon: fake })

    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('mars kpi acknowledge:')
  })

  it('exits 1 and shows usage when key is unknown', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(['kpi', 'acknowledge', 'bad_key'], { ...deps, daemon: fake })

    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('bad_key')
  })

  it('exits 1 when no snapshot exists', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(['kpi', 'acknowledge', 'failure_rate'], { ...deps, daemon: fake })

    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('no KPI snapshot found')
  })

  it('exits 0 and upserts the snapshot value when a snapshot exists', async () => {
    await insertKpiSnapshot(db, { id: 'snap-1', costP50: 2.5, failureRate: 0.15 })
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'acknowledge', 'failure_rate', '--reason', 'known regression'],
      { ...deps, daemon: fake },
    )

    expect(result.code).toBe(0)
    expect(result.out.join('\n')).toContain('acknowledged failure_rate')
    expect(result.out.join('\n')).toContain('0.15')
  })

  it('--list shows the upserted row including reason', async () => {
    await insertKpiSnapshot(db, { id: 'snap-2', costP50: 3.0, failureRate: 0.20 })
    const deps = await loadDeps(db)
    const fake = await makeFake()

    await run(
      ['kpi', 'acknowledge', 'cost_per_arc_p50', '--reason', 'infra upgrade'],
      { ...deps, daemon: fake },
    )

    const listResult = await run(['kpi', 'acknowledge', '--list'], { ...deps, daemon: fake })

    expect(listResult.code).toBe(0)
    const output = listResult.out.join('\n')
    expect(output).toContain('cost_per_arc_p50')
    expect(output).toContain('3')
    expect(output).toContain('infra upgrade')
  })

  it('--clear removes the row and --list shows empty again', async () => {
    await insertKpiSnapshot(db, { id: 'snap-3', costP50: 1.0, failureRate: 0.10 })
    const deps = await loadDeps(db)
    const fake = await makeFake()

    // First acknowledge
    await run(['kpi', 'acknowledge', 'failure_rate'], { ...deps, daemon: fake })

    // Confirm it exists
    const listBefore = await run(['kpi', 'acknowledge', '--list'], { ...deps, daemon: fake })
    expect(listBefore.out.join('\n')).toContain('failure_rate')

    // Clear
    const clearResult = await run(
      ['kpi', 'acknowledge', '--clear', 'failure_rate'],
      { ...deps, daemon: fake },
    )
    expect(clearResult.code).toBe(0)
    expect(clearResult.out.join('\n')).toContain('cleared')

    // Now list shows empty
    const listAfter = await run(['kpi', 'acknowledge', '--list'], { ...deps, daemon: fake })
    expect(listAfter.code).toBe(0)
    expect(listAfter.out.join('\n')).toContain('no acknowledged baselines')
  })

  it('upsert overwrites a prior acknowledgment', async () => {
    await insertKpiSnapshot(db, { id: 'snap-4', costP50: 2.0, failureRate: 0.18 })
    const deps = await loadDeps(db)
    const fake = await makeFake()

    // First acknowledge failure_rate
    await run(['kpi', 'acknowledge', 'failure_rate'], { ...deps, daemon: fake })

    // Seed a new snapshot with a different value
    await insertKpiSnapshot(db, { id: 'snap-5', costP50: 2.0, failureRate: 0.22 })

    // Re-acknowledge — the value should be updated
    const result = await run(['kpi', 'acknowledge', 'failure_rate'], { ...deps, daemon: fake })
    expect(result.code).toBe(0)

    const listResult = await run(['kpi', 'acknowledge', '--list'], { ...deps, daemon: fake })
    const output = listResult.out.join('\n')
    // Most-recent snapshot has failure_rate=0.22
    expect(output).toContain('0.22')
  })

  it('kpi acknowledge is discoverable in the registry', async () => {
    const { registry } = await import('../../commands/index.js')
    expect(registry.has('kpi acknowledge')).toBe(true)
  })
})

// ── Section 2 — Suppression integration ───────────────────────────────────

/**
 * Minimal DDL for the LibSQL test DB. The suppression tests bypass the full
 * PGlite schema and provision only the tables the trigger actually needs.
 */
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

const KPI_ACK_BASELINES_DDL = `
  CREATE TABLE IF NOT EXISTS kpi_acknowledged_baselines (
    kpi_key         TEXT PRIMARY KEY,
    value           REAL NOT NULL,
    acknowledged_at TEXT NOT NULL,
    reason          TEXT
  )
`

const TASKS_DDL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    priority INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-kpi-ack-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

interface SuppressCtx {
  runSelfEvolveTrigger: (opts?: {
    store?: import('../../../core/store/task-store.js').DomainTaskStore
  }) => Promise<{ raised: string[]; skipped: Array<{ kpi: string; reason: string }> }>
  store: import('../../../core/store/task-store.js').DomainTaskStore
  acknowledgeKpiBaseline: (kpiKey: string, value: number) => Promise<void>
  clearKpiBaseline: (kpiKey: string) => Promise<void>
}

async function loadSuppressCtx(repo: string): Promise<SuppressCtx> {
  vi.resetModules()
  process.env.MARS_REPO = repo

  const { openLibsql } = await import('../../../core/lib/libsql.js')
  const dbPath = resolve(repo, '.mars', 'mars.db')
  const client = openLibsql({ url: `file:${dbPath}` })

  await client.execute(KPI_SNAPSHOTS_DDL)
  await client.execute(KPI_ACK_BASELINES_DDL)
  await client.execute(TASKS_DDL)

  const { initProposals } = await import('../../../core/proposals.js')
  await initProposals()

  const { createTaskStore } = await import('../../../core/store/task-store.js')
  const store = createTaskStore(client)

  const { runSelfEvolveTrigger } = await import('../../../core/lib/self-evolve-trigger.js')
  const { acknowledgeKpiBaseline, clearKpiBaseline } = await import(
    '../../../core/lib/kpi-baseline.js'
  )

  return {
    runSelfEvolveTrigger,
    store,
    acknowledgeKpiBaseline: (kpiKey, value) => acknowledgeKpiBaseline(store, kpiKey, value),
    clearKpiBaseline: (kpiKey) => clearKpiBaseline(store, kpiKey),
  }
}

async function insertTriggerSnapshot(
  store: import('../../../core/store/task-store.js').DomainTaskStore,
  opts: {
    id: string
    takenAt: string
    failureRate: number | null
    costPerArcP50?: number | null
  },
): Promise<void> {
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
      opts.takenAt,
      opts.takenAt,
      10, 0,
      10, 0,
      10, 0,
      10, 0,
      opts.costPerArcP50 ?? null,
      null,
      opts.failureRate,
    ],
  })
}

describe('mars kpi acknowledge — suppression in runSelfEvolveTrigger', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('skips a finding with reason "acknowledged" when baseline covers current value', async () => {
    const ctx = await loadSuppressCtx(repo)

    // prior: failure_rate=0.10; current: 0.25 → +150% regression (lower-is-better)
    await insertTriggerSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
    })
    await insertTriggerSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-02T00:00:00Z',
      failureRate: 0.25,
    })

    // Acknowledge the current value — current (0.25) is within 0% of acknowledged (0.25)
    await ctx.acknowledgeKpiBaseline('failure_rate', 0.25)

    const result = await ctx.runSelfEvolveTrigger({ store: ctx.store })

    const ackSkipped = result.skipped.filter(
      (s) => s.kpi === 'failure_rate' && s.reason === 'acknowledged',
    )
    expect(ackSkipped).toHaveLength(1)
    // No proposal raised for the acknowledged KPI
    expect(result.raised).toHaveLength(0)
  })

  it('restores detection after clearing the acknowledged baseline', async () => {
    const ctx = await loadSuppressCtx(repo)

    await insertTriggerSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
    })
    await insertTriggerSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-02T00:00:00Z',
      failureRate: 0.25,
    })

    // Acknowledge then clear
    await ctx.acknowledgeKpiBaseline('failure_rate', 0.25)
    await ctx.clearKpiBaseline('failure_rate')

    const result = await ctx.runSelfEvolveTrigger({ store: ctx.store })

    // Detection is restored — the regression should now raise a proposal
    expect(result.raised).toHaveLength(1)
    expect(result.skipped.some((s) => s.reason === 'acknowledged')).toBe(false)
  })
})
