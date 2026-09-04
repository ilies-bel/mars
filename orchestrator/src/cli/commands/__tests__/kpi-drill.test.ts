/**
 * Tests for `mars kpi drill cost_per_arc`.
 *
 * Seeds the tasks + trace_events tables with three arcs that have known
 * per-phase weighted token costs, then asserts the table output: ordering,
 * column values, and the median/p90 footer.
 *
 * Test dataset (arc costs are cache-weighted token totals):
 *   arc-alpha  total=1500  code=1200, verify=200, setup=100, other=0
 *   arc-beta   total=900   code=700,  other=200
 *   arc-gamma  total=300   code=200,  setup=100
 *
 * Expected table order: arc-alpha (1500) → arc-beta (900) → arc-gamma (300).
 *
 * Tasks are seeded with updated_at = 2 days ago so they fall inside the
 * 7-day fallback window produced by listKpiArcs when no kpi_snapshot exists.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDb } from '../../../../test/db-fixture.js'
import type { DbClient } from '../../../core/lib/db.js'
import type { InProcessOptions } from '../../test-adapter'
import type { OrchestratorContext } from '../../../core/context'

// ── Timestamps ────────────────────────────────────────────────────────────────

/** 2 days ago — always inside the 7-day fallback KPI window. */
const RECENT_DATE = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
const CREATED_AT = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString()

// ── Seed helpers ──────────────────────────────────────────────────────────────

let eventSeq = 0

async function insertDoneTask(
  db: DbClient,
  id: string,
  prompt: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
          VALUES (?, ?, 'done', ?, ?)`,
    args: [id, prompt, CREATED_AT, RECENT_DATE],
  })
}

async function insertStepEndedWithName(
  db: DbClient,
  opts: {
    taskId: string
    stepName: string
    inputTokens: number
  },
): Promise<void> {
  const seq = ++eventSeq
  const ts = new Date(RECENT_DATE).getTime() + seq
  const payload = JSON.stringify({
    stepName: opts.stepName,
    workerName: 'Coder',
    outcome: 'completed',
    durationMs: 1000,
    usageSignals: {
      inputTokens: opts.inputTokens,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      messageCount: 1,
    },
  })
  await db.execute({
    sql: `INSERT INTO trace_events (id, timestamp, kind, severity, task_id, payload)
          VALUES (?, ?, 'step_ended', 'info', ?, ?)`,
    args: [`te-drill-${seq}`, ts, opts.taskId, payload],
  })
}

// ── Test harness ──────────────────────────────────────────────────────────────

const makeCtx = (): OrchestratorContext => ({
  repoRoot: '/tmp/kpi-drill-test',
  stateDir: '/tmp/kpi-drill-test/.mars',
  queueDbPath: '/tmp/kpi-drill-test/.mars/queue.db',
  observabilityDbPath: '/tmp/kpi-drill-test/.mars/observability.db',
  stateDbPath: '/tmp/kpi-drill-test/.mars/state.db',
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

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('mars kpi drill cost_per_arc — seeded dataset', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await getTestDb()
    eventSeq = 0
    vi.resetModules()

    // arc-alpha: total=1500  code=1200, verify=200, setup=100
    await insertDoneTask(db, 'arc-alpha', 'alpha task prompt')
    await insertStepEndedWithName(db, { taskId: 'arc-alpha', stepName: 'code',   inputTokens: 1200 })
    await insertStepEndedWithName(db, { taskId: 'arc-alpha', stepName: 'verify', inputTokens: 200 })
    await insertStepEndedWithName(db, { taskId: 'arc-alpha', stepName: 'setup',  inputTokens: 100 })

    // arc-beta: total=900   code=700, other('plan')=200
    await insertDoneTask(db, 'arc-beta', 'beta task prompt')
    await insertStepEndedWithName(db, { taskId: 'arc-beta', stepName: 'code',   inputTokens: 700 })
    await insertStepEndedWithName(db, { taskId: 'arc-beta', stepName: 'plan',   inputTokens: 200 })

    // arc-gamma: total=300   code=200, setup=100
    await insertDoneTask(db, 'arc-gamma', 'gamma task prompt')
    await insertStepEndedWithName(db, { taskId: 'arc-gamma', stepName: 'code',  inputTokens: 200 })
    await insertStepEndedWithName(db, { taskId: 'arc-gamma', stepName: 'setup', inputTokens: 100 })
  })

  it('exits 0 and prints a table with arc_id/title/total/code/verify/setup/other columns', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(['kpi', 'drill', 'cost_per_arc'], { ...deps, daemon: fake })

    expect(result.code).toBe(0)
    const header = result.out[0]!
    expect(header).toContain('arc_id')
    expect(header).toContain('title')
    expect(header).toContain('total')
    expect(header).toContain('code')
    expect(header).toContain('verify')
    expect(header).toContain('setup')
    expect(header).toContain('other')
  })

  it('sorts arcs descending by total weighted tokens', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(['kpi', 'drill', 'cost_per_arc'], { ...deps, daemon: fake })

    expect(result.code).toBe(0)
    // Find the data rows (skip header + separator + empty lines + footer)
    const dataRows = result.out.filter((l) =>
      l.includes('arc-alpha') || l.includes('arc-beta') || l.includes('arc-gamma'),
    )
    expect(dataRows).toHaveLength(3)
    // arc-alpha (1500) should appear before arc-beta (900) before arc-gamma (300)
    const alphaIdx = dataRows.findIndex((l) => l.includes('arc-alpha'))
    const betaIdx = dataRows.findIndex((l) => l.includes('arc-beta'))
    const gammaIdx = dataRows.findIndex((l) => l.includes('arc-gamma'))
    expect(alphaIdx).toBeLessThan(betaIdx)
    expect(betaIdx).toBeLessThan(gammaIdx)
  })

  it('shows arc-alpha total=1500 with code=1200, verify=200, setup=100, other=0', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(['kpi', 'drill', 'cost_per_arc'], { ...deps, daemon: fake })

    const alphaRow = result.out.find((l) => l.includes('arc-alpha'))
    expect(alphaRow).toBeDefined()
    expect(alphaRow).toContain('1500')
    expect(alphaRow).toContain('1200')
    expect(alphaRow).toContain('200')
    expect(alphaRow).toContain('100')
  })

  it('puts plan tokens for arc-beta into the other column', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(['kpi', 'drill', 'cost_per_arc'], { ...deps, daemon: fake })

    const betaRow = result.out.find((l) => l.includes('arc-beta'))
    expect(betaRow).toBeDefined()
    expect(betaRow).toContain('900')
    expect(betaRow).toContain('700')
    // The 'other' column should contain the 200 from the 'plan' step
    // We check that '200' appears in the row (as the other column value)
    expect(betaRow).toContain('200')
  })

  it('prints a footer with median and p90 of displayed arcs', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(['kpi', 'drill', 'cost_per_arc'], { ...deps, daemon: fake })

    const footer = result.out.find((l) => l.includes('median:') && l.includes('p90:'))
    expect(footer).toBeDefined()
    // Sorted totals: [300, 900, 1500]; median = 900, p90 = 1500 * 0.9 + 300 * 0.1 = ...
    // Linear interp: p90 index = 0.9 * 2 = 1.8; lo=1(900), hi=2(1500)
    // p90 = 900 + 0.8 * (1500 - 900) = 900 + 480 = 1380
    expect(footer).toContain('median: 900')
    expect(footer).toContain('p90: 1380')
    expect(footer).toContain('3 arcs shown')
  })

  it('limits output to --limit N arcs', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'drill', 'cost_per_arc', '--limit', '2'],
      { ...deps, daemon: fake },
    )

    expect(result.code).toBe(0)
    // Only top 2 arcs (alpha + beta) should appear; gamma should be absent
    const dataRows = result.out.filter((l) =>
      l.includes('arc-alpha') || l.includes('arc-beta') || l.includes('arc-gamma'),
    )
    expect(dataRows).toHaveLength(2)
    expect(dataRows.some((l) => l.includes('arc-gamma'))).toBe(false)

    const footer = result.out.find((l) => l.includes('median:'))
    expect(footer).toContain('2 arcs shown')
  })

  it('shows the arc title (truncated) in the title column', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(['kpi', 'drill', 'cost_per_arc'], { ...deps, daemon: fake })

    const alphaRow = result.out.find((l) => l.includes('arc-alpha'))
    expect(alphaRow).toBeDefined()
    // The prompt 'alpha task prompt' should appear (possibly truncated)
    expect(alphaRow).toContain('alpha task')
  })
})

describe('mars kpi drill — argument validation', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await getTestDb()
    vi.resetModules()
  })

  it('exits 1 with usage when key is missing', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(['kpi', 'drill'], { ...deps, daemon: fake })

    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('cost_per_arc')
  })

  it('exits 1 with usage when key is unknown', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(['kpi', 'drill', 'not_a_key'], { ...deps, daemon: fake })

    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain("unknown key 'not_a_key'")
  })

  it('exits 1 when --limit is not a positive integer', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'drill', 'cost_per_arc', '--limit', '0'],
      { ...deps, daemon: fake },
    )

    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('--limit')
  })

  it('kpi drill is discoverable in the command registry', async () => {
    const { registry } = await import('../../commands/index.js')
    expect(registry.has('kpi drill')).toBe(true)
  })
})

describe('mars kpi drill — empty window', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await getTestDb()
    vi.resetModules()
  })

  it('exits 0 and prints "no arcs in window" when there are no done arcs', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(['kpi', 'drill', 'cost_per_arc'], { ...deps, daemon: fake })

    expect(result.code).toBe(0)
    const output = result.out.join('\n')
    expect(output).toContain('no arcs in window')
  })
})
