import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildActionQueueView,
  type PersistedActionQueueRow,
  type ActionQueueStateStore,
  type ActionQueueTaskStore,
} from '../daemon/view/action-queue'
import { DAEMON_VIEW_TIMEOUT_MS } from '../../cli/commands/action-queue'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-action-queue-view-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

// ── Budget constants ──────────────────────────────────────────────────────────

/**
 * The configured budget must be generous enough that the operator never gets
 * a false "unknown" from a momentarily busy daemon. These tests guard against
 * regressions on both sides: too-low budget (false failures) and too-slow view
 * (latency regression).
 */
describe('DAEMON_VIEW_TIMEOUT_MS budget', () => {
  it('is configured well above the measured p95 latency', () => {
    // Measured p95 for the action-queue listing under real load: 5-7s.
    // The budget must be well above that so a busy daemon never produces a
    // false "unknown". 15s is the floor; production default is 30s.
    expect(DAEMON_VIEW_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000)
  })
})

// ── Enrichment-performance benchmark ─────────────────────────────────────────

/**
 * buildActionQueueView enrichment cost for 120 open rows (4 kinds × 30 rows).
 *
 * This test exercises the pure-CPU derivation path: no DB, no git probes, no
 * I/O — just the recipe lookup, failure-kind enrichment, and sort that runs
 * for every row. It catches regressions that re-introduce per-row I/O
 * (e.g. git probes on every row) or slow recipe computations.
 *
 * Using in-memory fixtures keeps the test fast and avoids DB-singleton leakage
 * between tests (a real DB would leave stale module singletons after cleanup).
 */
describe('buildActionQueueView enrichment performance with 100+ rows', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('completes well within the operator-facing budget', async () => {
    const now = Date.now()
    const kinds: Array<PersistedActionQueueRow['kind']> = [
      'failed', 'stale-queued', 'signature-storm', 'daemon-died',
    ]
    const rows: PersistedActionQueueRow[] = []
    for (let k = 0; k < kinds.length; k++) {
      const kind = kinds[k]!
      for (let i = 0; i < 30; i++) {
        const id = `${kind}-${i}`
        rows.push({
          id,
          kind,
          priority: 'high',
          title: `Alert ${id}`,
          body: '',
          payload: kind === 'failed'
            ? { taskId: id }
            : kind === 'stale-queued'
              ? { taskId: id, queuedAgeMs: 3_600_000 }
              : kind === 'signature-storm'
                ? { signature: `verify:typecheck:${i}`, streak: 3 }
                : { pid: 10000 + i, crashDetectedAt: new Date(now).toISOString() },
          context: {},
          raisedAt: now - 3_600_000,
          lastSeenAt: now,
          signature: `test:${kind}:${i}`,
        })
      }
    }

    const stateStore: ActionQueueStateStore = {
      listOpenActionQueueItems: async () => rows,
      listResolvedActionQueueItems: async () => ({ items: [], nextCursor: null }),
    }
    const taskStore: ActionQueueTaskStore = {
      listTasksForActionQueueItems: async () => [],
    }

    const startedAt = performance.now()
    const result = await buildActionQueueView({
      stateStore,
      taskStore,
      repoRoot: repo,
      filter: 'open',
    })
    const elapsedMs = performance.now() - startedAt

    expect(result.length).toBe(rows.length)
    // Must answer well within the operator-facing budget.
    // Budget: 10% of DAEMON_VIEW_TIMEOUT_MS (e.g. 3s for a 30s budget).
    // This guards against per-row I/O regressions while tolerating CI slowness.
    const perfBudgetMs = DAEMON_VIEW_TIMEOUT_MS * 0.1
    expect(elapsedMs).toBeLessThan(perfBudgetMs)
  })
})

// ── Full-stack bounded-view test ──────────────────────────────────────────────

describe('AppServices action queue view', () => {
  let repo: string
  let previousRepo: string | undefined
  let previousProfileSetting: string | undefined

  beforeEach(() => {
    repo = setupRepo()
    previousRepo = process.env.MARS_REPO
    previousProfileSetting = process.env.MARS_ACTION_QUEUE_VIEW_PROFILE
    process.env.MARS_REPO = repo
    process.env.MARS_ACTION_QUEUE_VIEW_PROFILE = '1'
  })

  afterEach(() => {
    if (previousRepo === undefined) {
      delete process.env.MARS_REPO
    } else {
      process.env.MARS_REPO = previousRepo
    }
    if (previousProfileSetting === undefined) {
      delete process.env.MARS_ACTION_QUEUE_VIEW_PROFILE
    } else {
      process.env.MARS_ACTION_QUEUE_VIEW_PROFILE = previousProfileSetting
    }
    rmSync(repo, { recursive: true, force: true })
  })

  it('keeps the open action queue view bounded to active rows after thousands of completed tasks', async () => {
    const { __resetContextCacheForTests } = await import('../context.js')
    const { __resetDbRegistryForTests } = await import('../lib/db.js')
    __resetContextCacheForTests()
    await __resetDbRegistryForTests()

    const { getCompositionRootClient, runCompositionRootMigrations } =
      await import('../store/task-store-default.js')
    const { raiseActionQueueItem } = await import('../lib/action-queue.js')
    const { createAppServices } = await import('../app-services.js')
    const { nullTraceStore } = await import('../lib/run-tool.js')

    await runCompositionRootMigrations()
    const db = getCompositionRootClient()
    await db.execute(`INSERT INTO tasks (id, prompt, status, created_at, updated_at)
      SELECT 'completed-' || n, 'completed task', 'done', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM generate_series(1, 2500) AS series(n)`)
    await db.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES (?, ?, 'failed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      args: ['active-task', 'Repair the active task'],
    })
    await raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: 'Active task failed',
      body: 'Only this task requires an operator.',
      payload: { taskId: 'active-task' },
      context: {},
      raisedBy: 'test',
      signature: 'active-task',
    })

    const profile = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const services = createAppServices({
      traceStore: nullTraceStore,
      buildAlertSources: async () => ({
        listFailedArcs: async () => [],
        listStaleWorktrees: async () => [],
        listVerifyUncovered: async () => [],
      }),
    })

    const rows = await services.viewActionQueue('open')

    expect(rows).toHaveLength(1)
    expect(rows[0]?.entityId).toBe('active-task')
    expect(profile).toHaveBeenCalledWith(
      expect.stringContaining('visible_rows=1 task_graph_rows=1'),
    )
    profile.mockRestore()
  }, 60_000)
})
