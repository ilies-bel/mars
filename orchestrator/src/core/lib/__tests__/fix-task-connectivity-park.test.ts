/**
 * Regression suite for the fix-task API-connectivity gap (mars-26c967ef):
 *
 * SYMPTOM. When a recovery (fix) task's code step failed because the provider
 * API was unreachable (ENOTFOUND / ConnectionRefused), the fix-task escalation
 * path in `handleTaskFailureWithFixTask` immediately raised an action-queue item
 * and left the origin task permanently `blocked`. The origin's single recovery
 * slot was consumed by an infrastructure outage — not a code regression.
 *
 * FIX. Inside the `fixForTaskId !== null` branch, detect `/api-unreachable`
 * signatures and re-queue the fix task on its existing worktree ("park and
 * resume"), leaving the origin `blocked` until connectivity is restored.
 * `envRestartCount` bounds the loop; once MAX_ENV_RESTART_ATTEMPTS is reached,
 * the cap-exhausted path falls through to the normal escalation.
 *
 * This file pins four invariants:
 *  1. API connectivity failure → fix task is re-queued (not escalated), origin stays blocked.
 *  2. envRestartCount increments on each park and is capped at MAX_ENV_RESTART_ATTEMPTS.
 *  3. No fix-of-fix task is spawned for connectivity failures.
 *  4. A genuine code failure on a fix task still escalates as before (regression guard).
 *
 * Test harness mirrors queue-fix-tasks.test.ts: one migrated template DB
 * cloned per test, modules re-imported against a fresh `MARS_REPO`.
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
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
}

interface FixTasksModule {
  handleTaskFailureWithFixTask: typeof import('../../queue-fix-tasks').handleTaskFailureWithFixTask
  upsertFixTask: typeof import('../../queue-fix-tasks').upsertFixTask
  MAX_ENV_RESTART_ATTEMPTS: typeof import('../../queue-fix-tasks').MAX_ENV_RESTART_ATTEMPTS
}

interface RecipesModule {
  recipes: typeof import('../fix-recipes').recipes
}

/**
 * Error output that the provider CLI emits after exhausting its internal API
 * retries. `computeFailureSignature('code:coder-exit-nonzero', this)` returns
 * `'code:coder-exit-nonzero/api-unreachable'`.
 */
const API_UNREACHABLE_OUTPUT = 'Unable to connect to API (ENOTFOUND api.openai.com)'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-fix-conn-park-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

let templateRepo: string

const TEMPLATE_DB_FILES = ['queue.db', 'state.db'] as const

const cloneTemplateDbs = (destRepo: string): void => {
  for (const file of TEMPLATE_DB_FILES) {
    const src = resolve(templateRepo, '.mars', file)
    if (!existsSync(src)) continue
    copyFileSync(src, resolve(destRepo, '.mars', file))
  }
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; ft: FixTasksModule; rc: RecipesModule }> => {
  try {
    const { closeAllDbs } = await import('../db')
    await closeAllDbs()
  } catch {
    // Non-fatal: first invocation or already-crashed instance.
  }
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const ft = (await import('../../queue-fix-tasks')) as unknown as FixTasksModule
  const rc = (await import('../fix-recipes')) as unknown as RecipesModule
  return { q, ft, rc }
}

/**
 * Register a synthetic recipe for the duration of a single test.
 * Returns a teardown that removes it.
 */
const registerTestRecipe = (rc: RecipesModule, signature: string): (() => void) => {
  rc.recipes[signature] = {
    signature,
    title: () => `test recipe: ${signature}`,
    buildPrompt: () => `synthetic recovery prompt for ${signature}`,
  }
  return () => {
    delete rc.recipes[signature]
  }
}

describe('fix-task connectivity park-and-resume', () => {
  let repo: string

  beforeAll(async () => {
    templateRepo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = templateRepo
    const q = (await import('../../queue')) as unknown as QueueModule
    await q.migrateQueueSchema()
    const actionQueue = (await import('../action-queue')) as unknown as {
      initActionQueue: typeof import('../action-queue').initActionQueue
    }
    await actionQueue.initActionQueue()
    delete process.env.MARS_REPO
    const { closeAllDbs } = await import('../db')
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
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  it('parks a fix task on API connectivity failure instead of escalating — origin recovery budget intact', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, rc } = await loadModules(repo)
    // Register a recipe so the first (code) failure spawns a fix task.
    const cleanup = registerTestRecipe(rc, 'verify:typecheck/unclassified')
    const origin = await q.enqueueTask('build the thing', undefined, { skipTriage: true })

    // Spawn a fix task for the origin.
    const firstFailure = await ft.handleTaskFailureWithFixTask({
      taskId: origin.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    expect(firstFailure.outcome).toBe('blocked')
    const fixTaskId = firstFailure.fixTaskId!
    expect(fixTaskId).toBeTruthy()

    // Verify the origin is blocked (recovery slot consumed).
    const originAfterSpawn = await q.getTask(origin.id)
    expect(originAfterSpawn?.status).toBe('blocked')
    expect(originAfterSpawn?.retryCount).toBe(1)

    // Now simulate the fix task's coder failing due to API connectivity.
    // This is the exact condition the bug report describes.
    const connResult = await ft.handleTaskFailureWithFixTask({
      taskId: fixTaskId,
      failingStep: 'code:coder-exit-nonzero',
      errorOutput: API_UNREACHABLE_OUTPUT,
    })

    // ── Invariant 1: fix task is re-queued, not escalated ─────────────────
    expect(connResult.outcome).toBe('requeued')
    expect(connResult.actionQueueItemId).toBeUndefined()

    const fixAfterPark = await q.getTask(fixTaskId)
    expect(fixAfterPark?.status).toBe('queued')

    // ── Invariant 2: envRestartCount is incremented ────────────────────────
    expect(fixAfterPark?.envRestartCount).toBe(1)

    // The fix task's failure markers are cleared (a non-terminal row must
    // not carry stale failure metadata).
    expect(fixAfterPark?.failureSignature).toBeNull()
    expect(fixAfterPark?.failureReason).toBeNull()

    // ── Origin recovery budget intact ─────────────────────────────────────
    // The origin remains `blocked` (waiting for the fix task to complete).
    // Its retryCount has NOT been incremented again — the slot was only
    // consumed once when the fix task was first spawned.
    const originAfterPark = await q.getTask(origin.id)
    expect(originAfterPark?.status).toBe('blocked')
    expect(originAfterPark?.retryCount).toBe(1)

    // ── Invariant 3: no fix-of-fix task was spawned ────────────────────────
    const descendants = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [fixTaskId],
    })
    expect(Number((descendants.rows[0] as unknown as { n: number }).n)).toBe(0)

    cleanup()
  })

  it('increments envRestartCount on each connectivity park and caps at MAX_ENV_RESTART_ATTEMPTS', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, rc } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'verify:typecheck/unclassified')
    const origin = await q.enqueueTask('build the thing', undefined, { skipTriage: true })

    const spawnResult = await ft.handleTaskFailureWithFixTask({
      taskId: origin.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    expect(spawnResult.outcome).toBe('blocked')
    const fixTaskId = spawnResult.fixTaskId!

    const cap = ft.MAX_ENV_RESTART_ATTEMPTS // 3

    // Drive the fix task through connectivity parks until the cap.
    for (let i = 1; i <= cap; i++) {
      const r = await ft.handleTaskFailureWithFixTask({
        taskId: fixTaskId,
        failingStep: 'code:coder-exit-nonzero',
        errorOutput: API_UNREACHABLE_OUTPUT,
      })
      expect(r.outcome).toBe('requeued')
      const fixRow = await q.getTask(fixTaskId)
      expect(fixRow?.envRestartCount).toBe(i)
      expect(fixRow?.status).toBe('queued')
    }

    // Next connectivity failure after the cap → escalation.
    const postCapResult = await ft.handleTaskFailureWithFixTask({
      taskId: fixTaskId,
      failingStep: 'code:coder-exit-nonzero',
      errorOutput: API_UNREACHABLE_OUTPUT,
    })
    expect(postCapResult.outcome).toBe('escalated')

    const fixAfterEscalation = await q.getTask(fixTaskId)
    expect(fixAfterEscalation?.status).toBe('failed')
    // envRestartCount stays at cap (escalation path does not increment it).
    expect(fixAfterEscalation?.envRestartCount).toBe(cap)

    cleanup()
  })

  it('escalates a genuine code failure on the fix task exactly as before — no regression', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, rc } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'verify:typecheck/unclassified')
    const origin = await q.enqueueTask('build the thing', undefined, { skipTriage: true })

    const spawnResult = await ft.handleTaskFailureWithFixTask({
      taskId: origin.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    expect(spawnResult.outcome).toBe('blocked')
    const fixTaskId = spawnResult.fixTaskId!

    // Simulate the fix task failing with a code failure (not connectivity).
    const codeFailResult = await ft.handleTaskFailureWithFixTask({
      taskId: fixTaskId,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2339: property does not exist',
    })

    // A code failure on a fix task MUST escalate — this is ADR-0040.
    expect(codeFailResult.outcome).toBe('escalated')
    expect(codeFailResult.actionQueueItemId).toBeTruthy()

    const fixRow = await q.getTask(fixTaskId)
    expect(fixRow?.status).toBe('failed')

    // Origin remains blocked — human resolves via mars continue / mars restart.
    const originRow = await q.getTask(origin.id)
    expect(originRow?.status).toBe('blocked')

    cleanup()
  })
})
