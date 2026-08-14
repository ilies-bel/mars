/**
 * Fixture-based tests for `mars kpi compare`.
 *
 * Seeds the tasks + trace_events tables with a known dataset (two time windows:
 * "before" and "after") and asserts the four computed metrics + deltas.
 *
 * Uses the shared PGlite test database (getTestDb) and wraps it in a
 * DomainTaskStore for injection into runCommandInProcess. No process is
 * spawned; no daemon connection is needed (kpi compare is read-only).
 *
 * Metric definitions under test:
 *   cost-per-merged-task       = total provider $ / done task count in window
 *   failure-rate               = failed_arcs / (done + failed) arcs
 *   autonomous-completion-rate = done_without_recovery / done arcs
 *   recovery-success-rate      = (recovery.done AND origin.done) / all recovery samples
 *
 * Test dataset:
 *   before window: 2026-01-01 → 2026-07-01 (tasks updated 2026-02-01)
 *     tb1  done, autonomous, Coder 1 000 000 in + 0 out  → $3.00 (Coder inputPer1M=3.0)
 *     tb2  done, autonomous, Coder 1 000 000 in + 0 out  → $3.00
 *     tb3  failed, no recovery                            → 1 failed arc
 *     tb4  done (origin), no trace events                → excluded from avg cost
 *     tb4r done (recovery of tb4), no trace events       → arc tb4 non-autonomous
 *
 *   Expected before metrics:
 *     cost-per-merged-task = ($3.00 + $3.00) / 2 priced tasks = $3.00
 *     failure-rate         = 1 failed arc / 4 arcs = 25.00%
 *     autonomous-compl.    = 2 autonomous / 3 done arcs = 66.67%
 *     recovery-success     = 1/1 = 100.00%
 *
 *   after window: 2026-07-01 → now (tasks updated 2026-08-01)
 *     ta1  done, autonomous, Coder 500 000 in + 0 out  → $1.50
 *
 *   Expected after metrics:
 *     cost-per-merged-task = $1.50
 *     failure-rate         = 0%
 *     autonomous-compl.    = 100.00%
 *     recovery-success     = n/a (no samples)
 *
 *   Expected deltas:
 *     cost:      $1.50 - $3.00 = -$1.50  → ✓ pass
 *     failure:   0 - 25% = -25.00 pp     → ✓ pass
 *     auto:      100 - 66.67 = +33.33 pp → ✓ pass
 *     recovery:  n/a (after window has no samples)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDb } from '../../../../test/db-fixture.js'
import type { DbClient } from '../../../core/lib/db.js'
import type { InProcessOptions } from '../../test-adapter'
import type { OrchestratorContext } from '../../../core/context'

// ── Timestamps ─────────────────────────────────────────────────────────────────

const BEFORE_TS = '2026-01-01T00:00:00.000Z'
const AFTER_TS = '2026-07-01T00:00:00.000Z'
const BEFORE_WINDOW_DATE = '2026-02-01T00:00:00.000Z'  // updated_at for "before" tasks
const AFTER_WINDOW_DATE = '2026-08-01T00:00:00.000Z'   // updated_at for "after" tasks (past)

// ── Seed helpers ───────────────────────────────────────────────────────────────

let stepSeq = 0

async function insertTask(
  db: DbClient,
  opts: {
    id: string
    status: string
    updatedAt: string
    originId?: string
    fixForTaskId?: string
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at, origin_id, fix_for_task_id)
          VALUES (?, '', ?, ?, ?, ?, ?)`,
    args: [
      opts.id,
      opts.status,
      BEFORE_TS,              // created_at — reuse BEFORE_TS for all tasks
      opts.updatedAt,
      opts.originId ?? null,
      opts.fixForTaskId ?? null,
    ],
  })
}

async function insertStepEnded(
  db: DbClient,
  opts: {
    taskId: string
    workerName: string
    inputTokens: number
    outputTokens?: number
    updatedAt: string
  },
): Promise<void> {
  const seq = ++stepSeq
  const ts = new Date(opts.updatedAt).getTime() + seq
  const payload = JSON.stringify({
    stepName: 'code',
    workerName: opts.workerName,
    outcome: 'completed',
    durationMs: 1000,
    usageSignals: {
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens ?? 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      messageCount: 1,
    },
  })
  await db.execute({
    sql: `INSERT INTO trace_events (id, timestamp, kind, severity, task_id, payload)
          VALUES (?, ?, 'step_ended', 'info', ?, ?)`,
    args: [`te-${seq}`, ts, opts.taskId, payload],
  })
}

// ── Test setup ─────────────────────────────────────────────────────────────────

const makeCtx = (): OrchestratorContext => ({
  repoRoot: '/tmp/kpi-compare-test',
  stateDir: '/tmp/kpi-compare-test/.mars',
  queueDbPath: '/tmp/kpi-compare-test/.mars/queue.db',
  observabilityDbPath: '/tmp/kpi-compare-test/.mars/observability.db',
  stateDbPath: '/tmp/kpi-compare-test/.mars/state.db',
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

describe('mars kpi compare — seeded dataset', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await getTestDb()
    stepSeq = 0
    vi.resetModules()

    // ── Seed before-window tasks ──────────────────────────────────────────────

    // tb1: done, autonomous, Coder 1_000_000 input → $3.00
    await insertTask(db, { id: 'tb1', status: 'done', updatedAt: BEFORE_WINDOW_DATE })
    await insertStepEnded(db, {
      taskId: 'tb1',
      workerName: 'Coder',
      inputTokens: 1_000_000,
      updatedAt: BEFORE_WINDOW_DATE,
    })

    // tb2: done, autonomous, Coder 1_000_000 input → $3.00
    await insertTask(db, { id: 'tb2', status: 'done', updatedAt: BEFORE_WINDOW_DATE })
    await insertStepEnded(db, {
      taskId: 'tb2',
      workerName: 'Coder',
      inputTokens: 1_000_000,
      updatedAt: BEFORE_WINDOW_DATE,
    })

    // tb3: failed, no recovery → 1 failed arc in failure-rate denominator
    await insertTask(db, { id: 'tb3', status: 'failed', updatedAt: BEFORE_WINDOW_DATE })

    // tb4: done origin (no trace events → excluded from priced avg)
    await insertTask(db, { id: 'tb4', status: 'done', updatedAt: BEFORE_WINDOW_DATE })

    // tb4r: done recovery of tb4 → makes arc tb4 non-autonomous; recovery success = 100%
    await insertTask(db, {
      id: 'tb4r',
      status: 'done',
      updatedAt: BEFORE_WINDOW_DATE,
      originId: 'tb4',
      fixForTaskId: 'tb4',
    })

    // ── Seed after-window tasks ───────────────────────────────────────────────

    // ta1: done, autonomous, Coder 500_000 input → $1.50
    await insertTask(db, { id: 'ta1', status: 'done', updatedAt: AFTER_WINDOW_DATE })
    await insertStepEnded(db, {
      taskId: 'ta1',
      workerName: 'Coder',
      inputTokens: 500_000,
      updatedAt: AFTER_WINDOW_DATE,
    })
  })

  it('exits 0 and prints a 4-row table', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'compare', '--before', BEFORE_TS, '--after', AFTER_TS],
      { ...deps, daemon: fake },
    )

    expect(result.code).toBe(0)
    const output = result.out.join('\n')
    expect(output).toContain('cost-per-merged-task')
    expect(output).toContain('failure-rate')
    expect(output).toContain('autonomous-completion-rate')
    expect(output).toContain('recovery-success-rate')
  })

  it('computes before cost-per-merged-task = $3.00 (avg of tb1 + tb2, tb4 + tb4r excluded)', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'compare', '--before', BEFORE_TS, '--after', AFTER_TS],
      { ...deps, daemon: fake },
    )

    const output = result.out.join('\n')
    // Before column must show $3.00
    const costLine = result.out.find((l) => l.includes('cost-per-merged-task'))
    expect(costLine).toBeDefined()
    expect(costLine).toContain('$3.00')
  })

  it('computes after cost-per-merged-task = $1.50 (ta1 only)', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'compare', '--before', BEFORE_TS, '--after', AFTER_TS],
      { ...deps, daemon: fake },
    )

    const costLine = result.out.find((l) => l.includes('cost-per-merged-task'))
    expect(costLine).toBeDefined()
    expect(costLine).toContain('$1.50')
  })

  it('computes cost delta = -$1.50 and verdict = pass', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'compare', '--before', BEFORE_TS, '--after', AFTER_TS],
      { ...deps, daemon: fake },
    )

    const costLine = result.out.find((l) => l.includes('cost-per-merged-task'))
    expect(costLine).toBeDefined()
    expect(costLine).toContain('-$1.50')
    expect(costLine).toContain('pass')
  })

  it('computes before failure-rate = 25.00% (1 failed arc of 4 arcs)', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'compare', '--before', BEFORE_TS, '--after', AFTER_TS],
      { ...deps, daemon: fake },
    )

    const failLine = result.out.find((l) => l.includes('failure-rate'))
    expect(failLine).toBeDefined()
    expect(failLine).toContain('25.00%')
  })

  it('computes after failure-rate = 0.00% (no failed arcs)', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'compare', '--before', BEFORE_TS, '--after', AFTER_TS],
      { ...deps, daemon: fake },
    )

    const failLine = result.out.find((l) => l.includes('failure-rate'))
    expect(failLine).toBeDefined()
    expect(failLine).toContain('0.00%')
  })

  it('computes failure-rate delta = -25.00 pp and verdict = pass', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'compare', '--before', BEFORE_TS, '--after', AFTER_TS],
      { ...deps, daemon: fake },
    )

    const failLine = result.out.find((l) => l.includes('failure-rate'))
    expect(failLine).toBeDefined()
    expect(failLine).toContain('-25.00 pp')
    expect(failLine).toContain('pass')
  })

  it('computes before autonomous-completion-rate = 66.67% (tb1+tb2 of 3 done arcs)', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'compare', '--before', BEFORE_TS, '--after', AFTER_TS],
      { ...deps, daemon: fake },
    )

    const autoLine = result.out.find((l) => l.includes('autonomous-completion-rate'))
    expect(autoLine).toBeDefined()
    // 2/3 ≈ 66.67%
    expect(autoLine).toMatch(/66\.6[67]%/)
  })

  it('computes after autonomous-completion-rate = 100.00%', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'compare', '--before', BEFORE_TS, '--after', AFTER_TS],
      { ...deps, daemon: fake },
    )

    const autoLine = result.out.find((l) => l.includes('autonomous-completion-rate'))
    expect(autoLine).toBeDefined()
    expect(autoLine).toContain('100.00%')
  })

  it('computes autonomous-completion-rate delta with verdict = pass', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'compare', '--before', BEFORE_TS, '--after', AFTER_TS],
      { ...deps, daemon: fake },
    )

    const autoLine = result.out.find((l) => l.includes('autonomous-completion-rate'))
    expect(autoLine).toBeDefined()
    // Delta is positive (improvement)
    expect(autoLine).toMatch(/\+\d+\.\d+ pp/)
    expect(autoLine).toContain('pass')
  })

  it('computes before recovery-success-rate = 100.00% (tb4r succeeded)', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'compare', '--before', BEFORE_TS, '--after', AFTER_TS],
      { ...deps, daemon: fake },
    )

    const recLine = result.out.find((l) => l.includes('recovery-success-rate'))
    expect(recLine).toBeDefined()
    expect(recLine).toContain('100.00%')
  })

  it('shows n/a for after recovery-success-rate when no samples exist', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'compare', '--before', BEFORE_TS, '--after', AFTER_TS],
      { ...deps, daemon: fake },
    )

    const recLine = result.out.find((l) => l.includes('recovery-success-rate'))
    expect(recLine).toBeDefined()
    // After column and delta/verdict should all be n/a
    const parts = recLine!.trim().split(/\s{2,}/)
    // Somewhere in the line: after = n/a, delta = n/a
    expect(recLine).toContain('n/a')
  })
})

describe('mars kpi compare — argument validation', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await getTestDb()
    vi.resetModules()
  })

  it('exits 1 and shows usage when --before is missing', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'compare', '--after', AFTER_TS],
      { ...deps, daemon: fake },
    )

    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('--before')
  })

  it('exits 1 and shows usage when --after is missing', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'compare', '--before', BEFORE_TS],
      { ...deps, daemon: fake },
    )

    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('--after')
  })

  it('exits 1 when --before names a task id that does not exist', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'compare', '--before', 'nonexistent-task', '--after', AFTER_TS],
      { ...deps, daemon: fake },
    )

    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('nonexistent-task')
  })

  it('accepts a task id and uses its created_at as the window start', async () => {
    // Seed a task with a known created_at
    await db.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES (?, '', 'done', ?, ?)`,
      args: ['seed-task', BEFORE_TS, BEFORE_WINDOW_DATE],
    })

    const deps = await loadDeps(db)
    const fake = await makeFake()

    // Use a task id for --before; the window should start at BEFORE_TS
    const result = await run(
      ['kpi', 'compare', '--before', 'seed-task', '--after', AFTER_TS],
      { ...deps, daemon: fake },
    )

    // Should succeed (the resolved timestamp matches what the seed task's created_at provides)
    expect(result.code).toBe(0)
  })
})

describe('mars kpi compare — empty windows', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await getTestDb()
    vi.resetModules()
  })

  it('exits 0 and shows n/a for all metrics when both windows are empty', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(
      ['kpi', 'compare', '--before', '2020-01-01T00:00:00.000Z', '--after', '2021-01-01T00:00:00.000Z'],
      { ...deps, daemon: fake },
    )

    expect(result.code).toBe(0)
    const output = result.out.join('\n')
    // All four metric rows should exist
    expect(output).toContain('cost-per-merged-task')
    expect(output).toContain('failure-rate')
    expect(output).toContain('autonomous-completion-rate')
    expect(output).toContain('recovery-success-rate')
    // All values should be n/a
    const dataRows = result.out.filter(
      (l) =>
        l.includes('cost-per-merged-task') ||
        l.includes('failure-rate') ||
        l.includes('autonomous-completion-rate') ||
        l.includes('recovery-success-rate'),
    )
    for (const row of dataRows) {
      // Each data row should contain at least one n/a
      expect(row).toContain('n/a')
    }
  })
})

describe('mars kpi — root command and help', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await getTestDb()
    vi.resetModules()
  })

  it('kpi compare is discoverable in the registry', async () => {
    const { registry } = await import('../../commands/index.js')
    expect(registry.has('kpi')).toBe(true)
    expect(registry.has('kpi compare')).toBe(true)
  })

  it('exits 1 and shows usage when called with no subcommand', async () => {
    const deps = await loadDeps(db)
    const fake = await makeFake()

    const result = await run(['kpi'], { ...deps, daemon: fake })

    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('kpi')
  })
})
