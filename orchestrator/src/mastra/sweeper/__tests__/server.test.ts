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
  getClient: typeof import('../../queue').getClient
  initQueue: typeof import('../../queue').initQueue
}

interface RecipesModule {
  recipes: typeof import('../../lib/fix-recipes').recipes
}

interface SweeperModule {
  sweepOne: typeof import('../server').sweepOne
  findInFlightSelfHealBySignature: typeof import('../server').findInFlightSelfHealBySignature
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-sweeper-test-'))
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
): Promise<{
  q: QueueModule
  rc: RecipesModule
  sw: SweeperModule
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const rc = (await import('../../lib/fix-recipes')) as unknown as RecipesModule
  const sw = (await import('../server')) as unknown as SweeperModule
  return { q, rc, sw }
}

/**
 * Register a synthetic recipe under `signature` for the duration of a
 * single test. Returns a teardown that deletes it.
 */
const registerTestRecipe = (
  rc: RecipesModule,
  signature: string,
): (() => void) => {
  rc.recipes[signature] = {
    signature,
    title: () => `test recipe: ${signature}`,
    buildPrompt: () => `synthetic recovery prompt for ${signature}`,
  }
  return () => {
    delete rc.recipes[signature]
  }
}

const defaultCtx = {
  targetPath: '/tmp/x',
  statusOutput: 'some error',
  targetBranch: '',
  originalPrompt: '',
}

describe('sweeper/server', () => {
  let repo: string

  beforeAll(async () => {
    templateRepo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = templateRepo
    const q = (await import('../../queue')) as unknown as QueueModule
    await q.initQueue()
    const actionQueue = (await import('../../lib/action-queue')) as unknown as {
      initActionQueue: typeof import('../../lib/action-queue').initActionQueue
    }
    await actionQueue.initActionQueue()
    delete process.env.MARS_REPO
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

  it('enqueues exactly one self-heal task when no in-flight exists for the signature', async () => {
    const { q, rc, sw } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'sweep-sig1')
    const parent = await q.enqueueTask('task a', undefined, { skipTriage: true })

    const outcome = await sw.sweepOne({
      taskId: parent.id,
      failureSignature: 'sweep-sig1',
      failingStep: 'verify:typecheck',
      truncatedError: 'TS2304',
      branch: null,
      recipeContext: defaultCtx,
    })

    expect(outcome.kind).toBe('enqueued')
    if (outcome.kind !== 'enqueued') throw new Error('unreachable')
    expect(outcome.fixTaskId).toBeTruthy()

    const fixTask = await q.getTask(outcome.fixTaskId)
    expect(fixTask?.status).toBe('queued')
    expect(fixTask?.failureSignature).toBe('sweep-sig1')

    cleanup()
  })

  it('skips enqueue when an in-flight self-heal exists for the same signature (different parent)', async () => {
    const { q, rc, sw } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'sweep-sig2')
    const parentA = await q.enqueueTask('task a', undefined, { skipTriage: true })
    const parentB = await q.enqueueTask('task b', undefined, { skipTriage: true })

    // First sweep: enqueues a fix task for parentA
    const first = await sw.sweepOne({
      taskId: parentA.id,
      failureSignature: 'sweep-sig2',
      failingStep: 'verify:typecheck',
      truncatedError: 'err',
      branch: null,
      recipeContext: defaultCtx,
    })
    expect(first.kind).toBe('enqueued')
    if (first.kind !== 'enqueued') throw new Error('unreachable')

    // Second sweep: same signature, different parent — must be skipped
    const second = await sw.sweepOne({
      taskId: parentB.id,
      failureSignature: 'sweep-sig2',
      failingStep: 'verify:typecheck',
      truncatedError: 'err',
      branch: null,
      recipeContext: defaultCtx,
    })
    expect(second.kind).toBe('skipped-in-flight')
    if (second.kind !== 'skipped-in-flight') throw new Error('unreachable')
    expect(second.existingFixTaskId).toBe(first.fixTaskId)

    // Only one fix task row exists for this signature
    const fixTasks = await q.getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks
             WHERE failure_signature = ? AND fix_for_task_id IS NOT NULL`,
      args: ['sweep-sig2'],
    })
    expect(
      Number((fixTasks.rows[0] as unknown as { n: number }).n),
    ).toBe(1)

    cleanup()
  })

  it('skip path leaves the parent task status untouched', async () => {
    const { q, rc, sw } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'sweep-sig3')
    const parentA = await q.enqueueTask('task a', undefined, { skipTriage: true })
    const parentB = await q.enqueueTask('task b', undefined, { skipTriage: true })

    // First sweep enqueues for parentA
    await sw.sweepOne({
      taskId: parentA.id,
      failureSignature: 'sweep-sig3',
      failingStep: 'verify:typecheck',
      truncatedError: 'err',
      branch: null,
      recipeContext: defaultCtx,
    })

    // Capture parentB status before the skip
    const beforeSkip = await q.getTask(parentB.id)
    const statusBeforeSkip = beforeSkip?.status

    // Second sweep: skip path
    const outcome = await sw.sweepOne({
      taskId: parentB.id,
      failureSignature: 'sweep-sig3',
      failingStep: 'verify:typecheck',
      truncatedError: 'err',
      branch: null,
      recipeContext: defaultCtx,
    })
    expect(outcome.kind).toBe('skipped-in-flight')

    const afterSkip = await q.getTask(parentB.id)
    expect(afterSkip?.status).toBe(statusBeforeSkip)

    cleanup()
  })

  it('skips enqueue when the per-(parent,signature) retry budget is exhausted', async () => {
    const { q, rc, sw } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'sweep-budget-sig')
    const parentA = await q.enqueueTask('task a', undefined, { skipTriage: true })
    const parentB = await q.enqueueTask('task b', undefined, { skipTriage: true })

    // First sweep for parentA: zero prior attempts → enqueues normally.
    const first = await sw.sweepOne({
      taskId: parentA.id,
      failureSignature: 'sweep-budget-sig',
      failingStep: 'verify:typecheck',
      truncatedError: 'err',
      branch: null,
      recipeContext: defaultCtx,
    })
    expect(first.kind).toBe('enqueued')

    // Second sweep, same parent + signature: with default budget of 1, the
    // one outstanding attempt already exhausts the budget. Skip path fires.
    const logLines: string[] = []
    const second = await sw.sweepOne(
      {
        taskId: parentA.id,
        failureSignature: 'sweep-budget-sig',
        failingStep: 'verify:typecheck',
        truncatedError: 'err',
        branch: null,
        recipeContext: defaultCtx,
      },
      (line) => logLines.push(line),
    )
    expect(second.kind).toBe('skipped-budget-exhausted')
    if (second.kind !== 'skipped-budget-exhausted') throw new Error('unreachable')
    expect(second.attempts).toBeGreaterThanOrEqual(second.budget)

    // Log line records the budget skip and includes the signature.
    const skipLog = logLines.join('\n')
    expect(skipLog).toMatch(/budget/i)
    expect(skipLog).toContain('sweep-budget-sig')

    // Parent task status untouched by the skip — no new lifecycle status.
    const afterSkip = await q.getTask(parentA.id)
    expect(afterSkip?.status).toBe('blocked')

    // Different parent with same signature, zero prior attempts: still
    // allowed one attempt. Falls through the budget check and lands on the
    // in-flight check (returning skipped-in-flight, not budget-exhausted).
    const third = await sw.sweepOne({
      taskId: parentB.id,
      failureSignature: 'sweep-budget-sig',
      failingStep: 'verify:typecheck',
      truncatedError: 'err',
      branch: null,
      recipeContext: defaultCtx,
    })
    expect(third.kind).not.toBe('skipped-budget-exhausted')

    cleanup()
  })

  it('skip path emits a log line containing the signature and in-flight task id', async () => {
    const { q, rc, sw } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'sweep-sig4')
    const parentA = await q.enqueueTask('task a', undefined, { skipTriage: true })
    const parentB = await q.enqueueTask('task b', undefined, { skipTriage: true })

    // First sweep: enqueues (no log expected for skip)
    const first = await sw.sweepOne({
      taskId: parentA.id,
      failureSignature: 'sweep-sig4',
      failingStep: 'verify:typecheck',
      truncatedError: 'err',
      branch: null,
      recipeContext: defaultCtx,
    })
    expect(first.kind).toBe('enqueued')
    if (first.kind !== 'enqueued') throw new Error('unreachable')

    // Second sweep: skip, collect log lines via injected logger
    const logLines: string[] = []
    const second = await sw.sweepOne(
      {
        taskId: parentB.id,
        failureSignature: 'sweep-sig4',
        failingStep: 'verify:typecheck',
        truncatedError: 'err',
        branch: null,
        recipeContext: defaultCtx,
      },
      (line) => logLines.push(line),
    )
    expect(second.kind).toBe('skipped-in-flight')

    expect(logLines.length).toBeGreaterThan(0)
    const skipLog = logLines.join('\n')
    expect(skipLog).toMatch(/skipp/i)
    expect(skipLog).toContain('sweep-sig4')
    expect(skipLog).toContain(first.fixTaskId)

    cleanup()
  })
})
