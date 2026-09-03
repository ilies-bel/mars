/**
 * Unit tests for the arc token-ceiling gate in handleTaskFailureWithFixTask
 * (PRD d7b4e72c slice 2).
 *
 * Acceptance criteria:
 *  - Ceiling set + arc over  → recovery suppressed; failureReason prefixed
 *  - Ceiling unset           → recovery proceeds normally (outcome 'blocked')
 *  - Arc under ceiling       → recovery proceeds normally (outcome 'blocked')
 *  - BUDGET_ARC_EXCEEDED_PREFIX is recognised as terminal by
 *    isTerminalVerdictReason so a subsequent failure event does not re-drive
 *    the recovery-spawn path.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

// ── Module-interface stubs ────────────────────────────────────────────────────

interface QueueModule {
  enqueueTask: typeof import('./queue').enqueueTask
  getTask: typeof import('./queue').getTask
  resolveQueueClient: typeof import('./queue').resolveQueueClient
  migrateQueueSchema: typeof import('./queue').migrateQueueSchema
}

interface FixTasksModule {
  handleTaskFailureWithFixTask: typeof import('./queue-fix-tasks').handleTaskFailureWithFixTask
}

// ── Repo helpers ──────────────────────────────────────────────────────────────

/** Minimal repo directory with an initialised git repo and .mars/ state dir. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-arc-budget-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

// ── Template-DB pattern (mirrors recovery-coordination.test.ts) ──────────────

const TEMPLATE_DB_FILES = ['queue.db', 'state.db'] as const
let templateRepo: string

const cloneTemplateDbs = (destRepo: string): void => {
  for (const file of TEMPLATE_DB_FILES) {
    const src = resolve(templateRepo, '.mars', file)
    if (!existsSync(src)) continue
    copyFileSync(src, resolve(destRepo, '.mars', file))
  }
}

/** Reload all orchestrator modules against `repo` so DB singleton is fresh. */
const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; ft: FixTasksModule }> => {
  try {
    const { closeAllDbs } = await import('./lib/db')
    await closeAllDbs()
  } catch {
    /* non-fatal — first call or already closed */
  }
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('./queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const ft = (await import('./queue-fix-tasks')) as unknown as FixTasksModule
  return { q, ft }
}

/**
 * Insert a `step_ended` trace_events row for `taskId` with the given weighted
 * token spend. Only `inputTokens` is used; the rest are zeroed so the weighted
 * sum equals `tokens` exactly (no cache-read discount).
 */
const insertArcSpend = async (
  q: QueueModule,
  taskId: string,
  tokens: number,
): Promise<void> => {
  const client = q.resolveQueueClient()
  await client.execute({
    sql: `INSERT INTO trace_events (id, timestamp, kind, task_id, payload)
          VALUES (?, ?, 'step_ended', ?, ?)`,
    args: [
      randomUUID(),
      Date.now(),
      taskId,
      JSON.stringify({
        usageSignals: {
          inputTokens: tokens,
          outputTokens: 0,
          cacheCreateTokens: 0,
          cacheReadTokens: 0,
        },
      }),
    ],
  })
}

/**
 * Write `{ budget: { arcTokens } }` into the test repo's daemon.json so
 * `readBudgetConfig()` picks it up.
 */
const setArcTokensCeiling = (repo: string, arcTokens: number): void => {
  writeFileSync(
    resolve(repo, '.mars', 'daemon.json'),
    JSON.stringify({ budget: { arcTokens } }),
  )
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('queue-fix-tasks: arc token-ceiling gate', () => {
  let repo: string

  beforeAll(async () => {
    templateRepo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = templateRepo
    const q = (await import('./queue')) as unknown as QueueModule
    await q.migrateQueueSchema()
    // Initialise the action-queue table so upsertFixTask can raise items.
    const aq = (await import('./lib/action-queue')) as unknown as {
      initActionQueue: typeof import('./lib/action-queue').initActionQueue
    }
    await aq.initActionQueue()
    delete process.env.MARS_REPO
    const { closeAllDbs } = await import('./lib/db')
    await closeAllDbs()
    vi.resetModules()
  })

  afterAll(() => {
    rmSync(templateRepo, { recursive: true, force: true })
  })

  beforeEach(() => {
    repo = setupRepo()
    cloneTemplateDbs(repo)
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Criterion 1: ceiling set + arc over → recovery suppressed ────────────

  it('suppresses recovery and prefixes failureReason when arc spend >= arcTokens', async () => {
    const { q, ft } = await loadModules(repo)

    const task = await q.enqueueTask('arc budget test task', undefined, { skipTriage: true })

    // Insert 2M tokens of arc spend (above the 1M ceiling set below).
    await insertArcSpend(q, task.id, 2_000_000)

    // Set the ceiling BELOW the inserted spend.
    setArcTokensCeiling(repo, 1_000_000)

    const result = await ft.handleTaskFailureWithFixTask({
      taskId: task.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name',
    })

    expect(result.outcome).toBe('failed')

    const updated = await q.getTask(task.id)
    expect(updated?.failureReason).toMatch(/^budget-arc-exceeded:/)
    expect(updated?.status).toBe('failed')
  })

  // ── Criterion 2: ceiling unset → recovery proceeds normally ──────────────

  it('proceeds to recovery when budget.arcTokens is not configured', async () => {
    const { q, ft } = await loadModules(repo)

    // No daemon.json → readBudgetConfig() returns null → gate is a no-op.
    const task = await q.enqueueTask('arc budget test task no ceiling', undefined, {
      skipTriage: true,
    })

    const result = await ft.handleTaskFailureWithFixTask({
      taskId: task.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name',
    })

    // Outcome 'blocked' means a fix task was spawned — recovery proceeded.
    expect(result.outcome).toBe('blocked')
  })

  // ── Criterion 3: arc under ceiling → recovery proceeds normally ───────────

  it('proceeds to recovery when arc spend < arcTokens ceiling', async () => {
    const { q, ft } = await loadModules(repo)

    const task = await q.enqueueTask('arc budget test task under ceiling', undefined, {
      skipTriage: true,
    })

    // Insert 100K tokens — well below the 1M ceiling.
    await insertArcSpend(q, task.id, 100_000)

    setArcTokensCeiling(repo, 1_000_000)

    const result = await ft.handleTaskFailureWithFixTask({
      taskId: task.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name',
    })

    // Recovery should have been spawned — outcome is 'blocked'.
    expect(result.outcome).toBe('blocked')
  })

  // ── Criterion 4: prefixed reason is terminal ──────────────────────────────

  it('BUDGET_ARC_EXCEEDED_PREFIX is recognised as terminal by isTerminalVerdictReason', async () => {
    // Pure unit check — no DB needed. Reload modules to get fresh import.
    vi.resetModules()
    const { isTerminalVerdictReason, BUDGET_ARC_EXCEEDED_PREFIX } = await import(
      './lib/failure-signature'
    )

    expect(
      isTerminalVerdictReason(`${BUDGET_ARC_EXCEEDED_PREFIX}verify:typecheck/typecheck-cannot-find-name`),
    ).toBe(true)

    // Sanity: a raw failing-step reason must NOT be recognised as terminal.
    expect(isTerminalVerdictReason('verify:typecheck/typecheck-cannot-find-name')).toBe(false)
    expect(isTerminalVerdictReason(null)).toBe(false)
  })
})
