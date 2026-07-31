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
  updateTask: typeof import('./queue').updateTask
  listBlockers: typeof import('./queue').listBlockers
  isDispatchableStatus: typeof import('./queue').isDispatchableStatus
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

interface DispatchHintModule {
  registerDispatchHint: typeof import('./daemon/dispatch-hint').registerDispatchHint
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-rescue-operator-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * The `db.ts` instance belonging to the CURRENT test's module registry.
 *
 * `loadModules` calls `vi.resetModules()`, so every test gets its own `db.ts`
 * with its own client registry and its own embedded-PG/PGlite instance pointed
 * at that test's temp repo. Nothing closed them, so `afterEach`'s `rmSync`
 * deleted the data directory out from under a still-open database — surfacing
 * later as `could not open file "base/5/..."` / `could not create directory
 * "base/5": File exists` on whichever test happened to run next. That made the
 * file flaky independently of what is being asserted. Captured here so
 * `afterEach` can close the right registry before deleting the directory.
 */
let currentDb: { __resetDbRegistryForTests: () => Promise<void> } | null = null

const loadModules = async (
  repo: string,
): Promise<{
  q: QueueModule
  ft: FixTasksModule
  rescue: RescueModule
  rc: RecipesModule
  hint: DispatchHintModule
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  currentDb = (await import('./lib/db')) as unknown as {
    __resetDbRegistryForTests: () => Promise<void>
  }
  const q = (await import('./queue')) as unknown as QueueModule
  await q.ensureQueueSchema()
  const ft = (await import('./queue-fix-tasks')) as unknown as FixTasksModule
  const rescue = (await import('./rescue-operator-spawn')) as unknown as RescueModule
  const rc = (await import('./lib/fix-recipes')) as unknown as RecipesModule
  // Imported through the same post-reset module registry as rescue-operator-spawn
  // so the hint registry singleton is shared with the code under test.
  const hint = (await import('./daemon/dispatch-hint')) as unknown as DispatchHintModule
  return { q, ft, rescue, rc, hint }
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

/** Read the durable rescue counter for an Arc, including proposal-slug arcs. */
const readArcRescueAttempts = async (q: QueueModule, originId: string): Promise<number> => {
  const r = await q.resolveQueueClient().execute({
    sql: `SELECT attempts FROM arc_rescue_attempts WHERE origin_id = ?`,
    args: [originId],
  })
  if (r.rows.length === 0) return 0
  return Number((r.rows[0] as unknown as { attempts: number | bigint }).attempts)
}

describe('rescue-operator-spawn', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(async () => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    // Close this test's database BEFORE deleting its directory — see currentDb.
    await currentDb?.__resetDbRegistryForTests()
    currentDb = null
    rmSync(repo, { recursive: true, force: true })
  })

  // ── (a) No-recipe origin failure → rescue enqueued ────────────────────────

  it('(a) no-recipe origin failure: rescue-operator task enqueued, durable arc counter becomes 1', async () => {
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

    // The durable arc counter is 1.
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

    // The durable arc counter stays 0.
    expect(await readArcRescueAttempts(q, task.id)).toBe(0)
  })

  // ── (c) Recovery Chore failure → rescue enqueued ──────────────────────────

  it('(c) recovery Chore failure: rescue-operator task enqueued against origin, durable arc counter becomes 1', async () => {
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

    // The durable arc counter is 1.
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

    // The durable arc counter is still 1.
    expect(await readArcRescueAttempts(q, task.id)).toBe(1)
  })

  // ── Regression: rescue tasks must be dispatchable, never stranded 'draft' ──
  //
  // The spawn path used to call `store.enqueueTask` without `skipTriage`, so the
  // row landed in `'draft'`. Nothing inside the daemon surfaces a draft for
  // triage: the triage pending set is fed by the `task.added` bus emit (fired
  // only by the `add` RPC handler, i.e. `mars task add`) and by the poll-fallback
  // tick, which returns early unless the daemon is completely idle. A rescue is
  // spawned exactly when the daemon is busy failing tasks, so those rows were
  // never triaged, never promoted, and accumulated forever
  // (mars-984c9c64 / mars-42271532, 7 minutes apart).
  //
  // The rescue prompt tells the agent to "choose and execute exactly one of the
  // three permitted actions" — autonomous work, not a draft awaiting a human. It
  // must therefore be dispatchable the moment it is created.

  it('rescue-operator task spawned by the self-heal path is dispatchable, not stranded in draft', async () => {
    const { q, ft } = await loadModules(repo)
    const task = await q.enqueueTask('do a thing', undefined, { skipTriage: true })

    // 'code/unclassified' has no registered recipe — the arc dead-ends and the
    // self-heal path spawns a rescue-operator.
    await ft.handleTaskFailureWithFixTask({
      taskId: task.id,
      failingStep: 'code',
      errorOutput: 'something went wrong (unclassified)',
    })

    const rescueRows = await q.resolveQueueClient().execute({
      sql: `SELECT id FROM tasks WHERE tags_json LIKE '%rescue-operator%'`,
      args: [],
    })
    expect(rescueRows.rows).toHaveLength(1)
    const rescueId = (rescueRows.rows[0] as unknown as { id: string }).id

    const rescueTask = await q.getTask(rescueId)
    expect(rescueTask).not.toBeNull()
    // The core assertion: 'queued', never 'draft'.
    expect(rescueTask!.status).toBe('queued')
    expect(q.isDispatchableStatus(rescueTask!.status)).toBe(true)

    // And genuinely eligible: no blocker edge holds it back. (ADR-0040 keeps
    // rescue tasks out of the blocker graph; a stray edge would park it
    // 'blocked' on the next dispatch pass.)
    expect(await q.listBlockers(rescueId)).toEqual([])
  })

  // The other half of the leak. `skipTriage` fixes the persisted status, but the
  // daemon's drain() loop only picks work from an in-memory pending set that the
  // spawn path cannot reach. Before the dispatch-hint seam, the only things that
  // ever pushed these ids into that set were the `reseed-dispatch` reconciler
  // (startup only) and the poll-fallback tick (idle-daemon only) — which is why
  // both stranded rows entered triage within seconds of a `mars daemon restart`
  // and not before. This asserts the task is scheduled at CREATION time, with no
  // restart and no reconcile: a test that only exercised the reconcile path would
  // have passed with the bug present.

  it('registers the rescue task for dispatch at creation time, without a daemon restart or reconcile', async () => {
    const { q, ft, hint } = await loadModules(repo)
    const task = await q.enqueueTask('do a thing', undefined, { skipTriage: true })

    const hinted: Array<{ taskId: string; kind: string }> = []
    const unregister = hint.registerDispatchHint((taskId, kind) => {
      hinted.push({ taskId, kind })
    })

    let rescueId: string
    try {
      await ft.handleTaskFailureWithFixTask({
        taskId: task.id,
        failingStep: 'code',
        errorOutput: 'something went wrong (unclassified)',
      })

      const rescueRows = await q.resolveQueueClient().execute({
        sql: `SELECT id FROM tasks WHERE tags_json LIKE '%rescue-operator%'`,
        args: [],
      })
      expect(rescueRows.rows).toHaveLength(1)
      rescueId = (rescueRows.rows[0] as unknown as { id: string }).id
    } finally {
      unregister()
    }

    // The spawn path told the dispatch loop about the task itself. 'implement'
    // (not 'triage') because the row is already 'queued'.
    expect(hinted).toContainEqual({ taskId: rescueId, kind: 'implement' })
  })

  it('deregistering the dispatch hint stops delivery', async () => {
    const { q, rescue, hint } = await loadModules(repo)
    const task = await q.enqueueTask('do a thing', undefined, { skipTriage: true })
    const loaded = await q.getTask(task.id)
    if (!loaded) throw new Error('task not found')

    const hinted: string[] = []
    const unregister = hint.registerDispatchHint((taskId) => hinted.push(taskId))
    unregister()

    const result = await rescue.maybeSpawnRescueOperator({
      failedTask: loaded,
      failureSignature: 'code/unclassified',
    })

    // Spawn still succeeds — the hint is a nudge, never a gate.
    expect(result.spawned).toBe(true)
    expect(hinted).toEqual([])
  })

  it('rescue-operator task spawned directly is queued rather than draft', async () => {
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
    expect(rescueTask!.status).toBe('queued')
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

  it('does not respawn a failed rescue for a proposal-slug arc', async () => {
    const { q, rescue } = await loadModules(repo)

    const proposalSlug = 'abc123-test-proposal-slug'
    const task = await q.enqueueTask('slice task do a thing', undefined, {
      skipTriage: true,
      originId: proposalSlug,
    })

    const loaded = await q.getTask(task.id)
    if (!loaded) throw new Error('task not found')

    const first = await rescue.maybeSpawnRescueOperator({
      failedTask: loaded,
      failureSignature: 'code/unclassified',
    })
    expect(first.spawned).toBe(true)
    await q.updateTask(first.rescueTaskId!, { status: 'failed' })

    const second = await rescue.maybeSpawnRescueOperator({
      failedTask: loaded,
      failureSignature: 'code/unclassified',
    })
    const third = await rescue.maybeSpawnRescueOperator({
      failedTask: loaded,
      failureSignature: 'code/unclassified',
    })
    expect(second.spawned).toBe(false)
    expect(third.spawned).toBe(false)
    expect(await countRescueTasks(q)).toBe(1)
    expect(await readArcRescueAttempts(q, proposalSlug)).toBe(1)
  })

  it('does not respawn a failed rescue for a task-id arc', async () => {
    const { q, rescue } = await loadModules(repo)
    const task = await q.enqueueTask('do a thing', undefined, { skipTriage: true })
    const loaded = await q.getTask(task.id)
    if (!loaded) throw new Error('task not found')

    const first = await rescue.maybeSpawnRescueOperator({
      failedTask: loaded,
      failureSignature: 'code/unclassified',
    })
    expect(first.spawned).toBe(true)
    await q.updateTask(first.rescueTaskId!, { status: 'failed' })

    await expect(
      rescue.maybeSpawnRescueOperator({ failedTask: loaded, failureSignature: 'code/unclassified' }),
    ).resolves.toEqual({ spawned: false })
    await expect(
      rescue.maybeSpawnRescueOperator({ failedTask: loaded, failureSignature: 'code/unclassified' }),
    ).resolves.toEqual({ spawned: false })
    expect(await countRescueTasks(q)).toBe(1)
  })

  it('does not respawn a dropped rescue task', async () => {
    const { q, rescue } = await loadModules(repo)
    const task = await q.enqueueTask('do a thing', undefined, { skipTriage: true })
    const loaded = await q.getTask(task.id)
    if (!loaded) throw new Error('task not found')

    const first = await rescue.maybeSpawnRescueOperator({
      failedTask: loaded,
      failureSignature: 'code/unclassified',
    })
    await q.updateTask(first.rescueTaskId!, { status: 'dropped' })

    await expect(
      rescue.maybeSpawnRescueOperator({ failedTask: loaded, failureSignature: 'code/unclassified' }),
    ).resolves.toEqual({ spawned: false })
    expect(await countRescueTasks(q)).toBe(1)
  })

  it('atomically admits only one rescue when failures arrive concurrently', async () => {
    const { q, rescue } = await loadModules(repo)
    const task = await q.enqueueTask('do a thing', undefined, { skipTriage: true })
    const loaded = await q.getTask(task.id)
    if (!loaded) throw new Error('task not found')

    const results = await Promise.all([
      rescue.maybeSpawnRescueOperator({ failedTask: loaded, failureSignature: 'code/unclassified' }),
      rescue.maybeSpawnRescueOperator({ failedTask: loaded, failureSignature: 'code/unclassified' }),
    ])

    expect(results.filter((result) => result.spawned)).toHaveLength(1)
    expect(await countRescueTasks(q)).toBe(1)
  })
})
