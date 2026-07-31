import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  RESCUE_TRIAGE_PROMPT_TOKEN_BUDGET,
  estimateRescueTriagePromptTokens,
} from './workers/rescue-operator'

interface QueueModule {
  enqueueTask: typeof import('./queue').enqueueTask
  getTask: typeof import('./queue').getTask
  resolveQueueClient: typeof import('./queue').resolveQueueClient
  ensureQueueSchema: typeof import('./queue').ensureQueueSchema
}

interface FixTasksModule {
  handleTaskFailureWithFixTask: typeof import('./queue-fix-tasks').handleTaskFailureWithFixTask
  upsertFixTask: typeof import('./queue-fix-tasks').upsertFixTask
}

interface RescueModule {
  maybeSpawnRescueOperator: typeof import('./rescue-operator-spawn').maybeSpawnRescueOperator
}

interface RecipesModule {
  recipes: typeof import('./lib/fix-recipes').recipes
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-rescue-operator-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{
  q: QueueModule
  ft: FixTasksModule
  rescue: RescueModule
  rc: RecipesModule
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('./queue')) as unknown as QueueModule
  await q.ensureQueueSchema()
  const ft = (await import('./queue-fix-tasks')) as unknown as FixTasksModule
  const rescue = (await import('./rescue-operator-spawn')) as unknown as RescueModule
  const rc = (await import('./lib/fix-recipes')) as unknown as RecipesModule
  return { q, ft, rescue, rc }
}

/**
 * Register a synthetic recipe under `signature` for the duration of a test.
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

/** Count tasks tagged with 'rescue-operator' in the live DB. */
const countRescueTasks = async (q: QueueModule): Promise<number> => {
  const r = await q.resolveQueueClient().execute({
    sql: `SELECT COUNT(*) AS n FROM tasks WHERE tags_json LIKE '%rescue-operator%'`,
    args: [],
  })
  return Number((r.rows[0] as unknown as { n: number | bigint }).n)
}

/** Read the arc_rescue_attempts counter for the given origin task id. */
const readArcRescueAttempts = async (q: QueueModule, taskId: string): Promise<number> => {
  const r = await q.resolveQueueClient().execute({
    sql: `SELECT arc_rescue_attempts FROM tasks WHERE id = ?`,
    args: [taskId],
  })
  if (r.rows.length === 0) throw new Error(`task ${taskId} not found`)
  return Number((r.rows[0] as unknown as { arc_rescue_attempts: number | bigint }).arc_rescue_attempts)
}

describe('rescue-operator-spawn', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  // ── (a) No-recipe origin failure → rescue enqueued ────────────────────────

  it('(a) no-recipe origin failure: rescue-operator task enqueued, arc_rescue_attempts becomes 1', async () => {
    const { q, ft } = await loadModules(repo)
    const task = await q.enqueueTask('do a thing', undefined, { skipTriage: true })

    // 'code/unclassified' has no registered recipe — rescue must fire
    const r = await ft.handleTaskFailureWithFixTask({
      taskId: task.id,
      failingStep: 'code',
      errorOutput: 'something went wrong (unclassified)',
    })

    expect(r.outcome).toBe('blocked') // generic fix task still spawns

    // Exactly one rescue-operator task in DB
    expect(await countRescueTasks(q)).toBe(1)

    // origin_id of rescue task points at the origin
    const rescueRows = await q.resolveQueueClient().execute({
      sql: `SELECT origin_id FROM tasks WHERE tags_json LIKE '%rescue-operator%'`,
      args: [],
    })
    expect(rescueRows.rows).toHaveLength(1)
    const rescueRow = rescueRows.rows[0] as unknown as { origin_id: string }
    expect(rescueRow.origin_id).toBe(task.id)

    // arc_rescue_attempts is 1 on the origin task
    expect(await readArcRescueAttempts(q, task.id)).toBe(1)
  })

  // ── (b) Recipe-backed origin failure → NO rescue enqueued ─────────────────

  it('(b) recipe-backed origin failure: no rescue-operator task enqueued', async () => {
    const { q, ft } = await loadModules(repo)
    const task = await q.enqueueTask('do a thing', undefined, { skipTriage: true })

    // TS2339 → classifies as 'typecheck-property-not-exist' → registered recipe exists
    const r = await ft.handleTaskFailureWithFixTask({
      taskId: task.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2339: Property "foo" does not exist on type "Bar".',
    })

    expect(r.outcome).toBe('blocked') // fix task via registered recipe

    // No rescue-operator tasks
    expect(await countRescueTasks(q)).toBe(0)

    // arc_rescue_attempts stays 0
    expect(await readArcRescueAttempts(q, task.id)).toBe(0)
  })

  // ── (c) Recovery Chore failure → rescue enqueued ──────────────────────────

  it('(c) recovery Chore failure: rescue-operator task enqueued against origin, arc_rescue_attempts becomes 1', async () => {
    const { q, ft, rc } = await loadModules(repo)

    // Create origin task and a fix task for it
    const origin = await q.enqueueTask('original work', undefined, { skipTriage: true })
    const cleanup = registerTestRecipe(rc, 'test/recipe-for-setup')
    let fixTaskId: string
    try {
      const fix = await ft.upsertFixTask({
        sourceTaskId: origin.id,
        failureSignature: 'test/recipe-for-setup',
        failingStep: 'code',
        truncatedError: 'initial failure',
        branch: null,
        recipeContext: {
          targetPath: '/tmp/test',
          statusOutput: '',
          targetBranch: 'main',
          originalPrompt: 'original work',
        },
      })
      fixTaskId = fix.fixTaskId
    } finally {
      cleanup()
    }

    // Now the fix task (recovery Chore) itself fails
    const r = await ft.handleTaskFailureWithFixTask({
      taskId: fixTaskId,
      failingStep: 'code',
      errorOutput: 'recovery also failed',
    })

    expect(r.outcome).toBe('escalated') // recovery chore failure path

    // Rescue-operator task must be enqueued
    expect(await countRescueTasks(q)).toBe(1)

    // Rescue task's origin_id must be the ORIGIN (not the fix task)
    const rescueRows = await q.resolveQueueClient().execute({
      sql: `SELECT origin_id FROM tasks WHERE tags_json LIKE '%rescue-operator%'`,
      args: [],
    })
    const rescueRow = rescueRows.rows[0] as unknown as { origin_id: string }
    expect(rescueRow.origin_id).toBe(origin.id)

    // arc_rescue_attempts is 1 on the origin task
    expect(await readArcRescueAttempts(q, origin.id)).toBe(1)
  })

  // ── (d) Second dead-end on same Arc → no second rescue ────────────────────

  it('(d) second dead-end on same Arc: maybeSpawnRescueOperator is a no-op after first rescue', async () => {
    const { q, rescue } = await loadModules(repo)
    const task = await q.enqueueTask('do a thing', undefined, { skipTriage: true })

    const loaded = await q.getTask(task.id)
    if (!loaded) throw new Error('task not found')

    // First rescue — should spawn
    const first = await rescue.maybeSpawnRescueOperator({
      failedTask: loaded,
      failureSignature: 'code/unclassified',
    })
    expect(first.spawned).toBe(true)
    expect(first.rescueTaskId).toBeDefined()

    // Second rescue on the same arc — must be a no-op
    const second = await rescue.maybeSpawnRescueOperator({
      failedTask: loaded,
      failureSignature: 'code/unclassified',
    })
    expect(second.spawned).toBe(false)
    expect(second.rescueTaskId).toBeUndefined()

    // Still exactly one rescue task
    expect(await countRescueTasks(q)).toBe(1)

    // arc_rescue_attempts is still 1
    expect(await readArcRescueAttempts(q, task.id)).toBe(1)
  })

  // ── Additional: rescue task has the right tag marker ─────────────────────

  it('rescue-operator task is enqueued with the rescue-operator tag', async () => {
    const { q, rescue } = await loadModules(repo)
    const task = await q.enqueueTask('do a thing', undefined, { skipTriage: true })

    const loaded = await q.getTask(task.id)
    if (!loaded) throw new Error('task not found')
    const result = await rescue.maybeSpawnRescueOperator({
      failedTask: loaded,
      failureSignature: 'code/unclassified',
    })

    expect(result.spawned).toBe(true)
    const rescueTask = await q.getTask(result.rescueTaskId!)
    expect(rescueTask).not.toBeNull()
    expect(rescueTask!.tags).toContain('rescue-operator')
  })

  it('keeps a large arc rescue prompt below the triage worker budget before it dispatches', async () => {
    const { q, rescue } = await loadModules(repo)
    const rawTranscriptLikePrompt = 'full transcript material that must stay out of triage '.repeat(1_000)
    const origin = await q.enqueueTask(rawTranscriptLikePrompt, undefined, { skipTriage: true })
    for (let index = 0; index < 11; index += 1) {
      await q.enqueueTask(rawTranscriptLikePrompt, undefined, {
        skipTriage: true,
        originId: origin.id,
      })
    }

    const loaded = await q.getTask(origin.id)
    if (!loaded) throw new Error('origin task not found')
    const result = await rescue.maybeSpawnRescueOperator({
      failedTask: loaded,
      failureSignature: 'verify:test/unclassified',
    })

    const rescueTask = await q.getTask(result.rescueTaskId!)
    expect(rescueTask).not.toBeNull()
    expect(estimateRescueTriagePromptTokens(rescueTask!.prompt)).toBeLessThanOrEqual(
      RESCUE_TRIAGE_PROMPT_TOKEN_BUDGET,
    )
    expect(rescueTask!.prompt).not.toContain('full transcript material that must stay out of triage')
  })

  // ── (e) Proposal-based arc → no second rescue after first ─────────────────
  // For arcs whose origin_id is a proposal slug (no task row), arc_rescue_attempts
  // is always 0 and incrementArcRescueAttempts is a no-op. Without the secondary
  // guard, maybeSpawnRescueOperator would spawn a new rescue on every failure.

  it('(e) proposal-based arc: second call to maybeSpawnRescueOperator is a no-op', async () => {
    const { q, rescue } = await loadModules(repo)

    // Create a task whose origin_id is a proposal slug (no task row for that id).
    const proposalSlug = 'abc123-test-proposal-slug'
    const task = await q.enqueueTask('slice task do a thing', undefined, {
      skipTriage: true,
      originId: proposalSlug,
    })

    const loaded = await q.getTask(task.id)
    if (!loaded) throw new Error('task not found')

    // First rescue — should spawn
    const first = await rescue.maybeSpawnRescueOperator({
      failedTask: loaded,
      failureSignature: 'code/unclassified',
    })
    expect(first.spawned).toBe(true)
    expect(first.rescueTaskId).toBeDefined()

    // Second rescue on the same proposal-based arc — must be a no-op
    const second = await rescue.maybeSpawnRescueOperator({
      failedTask: loaded,
      failureSignature: 'code/unclassified',
    })
    expect(second.spawned).toBe(false)
    expect(second.rescueTaskId).toBeUndefined()

    // Still exactly one rescue task
    expect(await countRescueTasks(q)).toBe(1)
  })
})
