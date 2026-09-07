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

  // ── (a) No-recipe origin failure → generic fix spawns, no redundant rescue ─
  //
  // Before the in-flight-recovery guard, a no-recipe failure spawned a
  // rescue-operator IN PARALLEL with the freshly-created generic fix task
  // (ADR: uniform failure→fix spawn always creates one). That fix task is
  // itself the arc's "automatic move" the module's own header comment
  // requires be absent before firing — and by the time the rescue agent
  // actually dispatched, the fix had advanced to 'running', so the rescue's
  // only permitted actions (restart/continue) were refused by the
  // in-flight-recovery guard those verbs carry. It could only ever no-op.
  // See the in-flight-recovery test below for the direct regression guard.

  it('(a) no-recipe origin failure: generic fix task spawns, no rescue while it is in flight', async () => {
    const { q, ft } = await loadModules(repo)
    const task = await q.enqueueTask('do a thing', undefined, { skipTriage: true })

    // 'code/unclassified' has no registered recipe — a generic fix task still
    // spawns (ADR: uniform failure→fix spawn).
    const r = await ft.handleTaskFailureWithFixTask({
      taskId: task.id,
      failingStep: 'code',
      errorOutput: 'something went wrong (unclassified)',
    })

    expect(r.outcome).toBe('blocked') // generic fix task still spawns
    expect(r.fixTaskId).toBeTruthy()

    // No rescue-operator task: the fresh fix task is itself the arc's
    // in-flight recovery, so a parallel rescue would be redundant.
    expect(await countRescueTasks(q)).toBe(0)

    // The durable arc counter stays 0 — no rescue attempt was consumed, so
    // the arc remains eligible for a genuine rescue later.
    expect(await readArcRescueAttempts(q, task.id)).toBe(0)
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

  // ── In-flight recovery → no redundant rescue ──────────────────────────────
  //
  // Observed 2026-08-17 (RESCUE-mars-3dcef8b5.md): fix-6b227c76, the standard
  // one-recovery-per-origin fix task, was already 'running' on the arc's
  // worktree — actively resuming the coder on salvageable partial work — when
  // a rescue-operator was spawned for the same arc. The rescue's only
  // permitted actions (restart/continue) are refused by the in-flight-recovery
  // guard those verbs already carry, so it could only ever enter, observe the
  // in-flight recovery, and no-op — burning a full agent run for nothing.

  it('in-flight recovery: a running fix task on the arc blocks the rescue without consuming the counter', async () => {
    const { q, ft, rescue, rc } = await loadModules(repo)

    const origin = await q.enqueueTask('original work', undefined, { skipTriage: true })
    const cleanup = registerTestRecipe(rc, 'test/recipe-for-in-flight')
    let fixTaskId: string
    try {
      const fix = await ft.upsertFixTask({
        sourceTaskId: origin.id,
        failureSignature: 'test/recipe-for-in-flight',
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

    // Simulate the fix task actively running on the arc's worktree, resuming
    // the coder on salvageable partial work — the same state fix-6b227c76 was
    // in when the wasted rescue spawned.
    await q.updateTask(fixTaskId, { status: 'running' })

    const loaded = await q.getTask(origin.id)
    if (!loaded) throw new Error('origin task not found')

    const result = await rescue.maybeSpawnRescueOperator({
      failedTask: loaded,
      // A different failure signature than the one the running fix task is
      // already handling — the origin dead-ending again while its recovery
      // is still in flight is exactly the scenario that must no-op.
      failureSignature: 'code/some-other-unclassified-failure',
    })

    expect(result.spawned).toBe(false)
    expect(result.rescueTaskId).toBeUndefined()
    expect(await countRescueTasks(q)).toBe(0)

    // The durable arc-rescue counter must stay 0: a skipped-for-redundancy
    // spawn must not consume the arc's one genuine rescue attempt. If the
    // in-flight fix task later fails, the arc must still be eligible.
    expect(await readArcRescueAttempts(q, origin.id)).toBe(0)
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
    const { q, ft, rc } = await loadModules(repo)

    // Drive the "recovery Chore itself fails" self-heal trigger: an origin's
    // fix task exists (and is terminal, having just failed), so the arc has
    // no in-flight recovery left and the rescue-operator dead-end path fires.
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
    await ft.handleTaskFailureWithFixTask({
      taskId: fixTaskId,
      failingStep: 'code',
      errorOutput: 'recovery also failed',
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
    const { q, ft, rc, hint } = await loadModules(repo)

    // Drive the "recovery Chore itself fails" self-heal trigger — see the
    // dispatchability test above for why this replaces a no-recipe origin
    // failure as the trigger fixture.
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

    const hinted: Array<{ taskId: string; kind: string }> = []
    const unregister = hint.registerDispatchHint((taskId, kind) => {
      hinted.push({ taskId, kind })
    })

    let rescueId: string
    try {
      await ft.handleTaskFailureWithFixTask({
        taskId: fixTaskId,
        failingStep: 'code',
        errorOutput: 'recovery also failed',
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

  it('rescue-operator task is routed through the read-only report pipeline', async () => {
    // Regression test: a rescue task previously dispatched through the
    // default coder/implement pipeline, which forces a verify gate and a
    // "commit before you exit" contract the rescue-operator has no legitimate
    // way to satisfy (it is denied `git commit` — RESCUE_OPERATOR_DENIED_TOOLS
    // — and its job is to mutate OTHER tasks via `mars restart`/`continue`/
    // `task add --supersede`, never to commit on its own branch). Routing
    // through `workflow: 'report'` (ADR-0056) skips verify and merge entirely.
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
    expect(rescueTask!.workflow).toBe('report')
  })

  // ── (e) Supersession: checker says superseded → origin dropped, no rescue ──

  it('(e) supersession: origin dropped and action-queue row raised when checker says superseded, no rescue spawned', async () => {
    const { q, rescue } = await loadModules(repo)
    const task = await q.enqueueTask('do the thing that was already done on main', undefined, { skipTriage: true })

    const loaded = await q.getTask(task.id)
    if (!loaded) throw new Error('task not found')

    const supersededSha = 'abc1234567890def1234567890abcdef12345678'
    const result = await rescue.maybeSpawnRescueOperator({
      failedTask: loaded,
      failureSignature: 'code/unclassified',
      supersessionChecker: async (_originId) => ({ superseded: true as const, sha: supersededSha }),
    })

    // No rescue task spawned
    expect(result.spawned).toBe(false)
    expect(result.rescueTaskId).toBeUndefined()
    expect(await countRescueTasks(q)).toBe(0)

    // Arc rescue counter stays 0 — supersession doesn't count as a rescue attempt
    expect(await readArcRescueAttempts(q, task.id)).toBe(0)

    // Origin task is now dropped with the superseded-by reason
    const dropped = await q.getTask(task.id)
    expect(dropped?.status).toBe('dropped')
    expect(dropped?.failureReason).toBe(`superseded-by:${supersededSha}`)

    // Exactly one arc-superseded-on-main action-queue row was raised
    const aqRows = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM action_queue_items WHERE kind = 'arc-superseded-on-main'`,
      args: [],
    })
    expect(Number((aqRows.rows[0] as unknown as { n: number | bigint }).n)).toBe(1)
  })

  // ── (f) Supersession: checker says not superseded → happy path unchanged ──

  it('(f) supersession: checker says not superseded → rescue operator spawned normally', async () => {
    const { q, rescue } = await loadModules(repo)
    const task = await q.enqueueTask('do the thing', undefined, { skipTriage: true })

    const loaded = await q.getTask(task.id)
    if (!loaded) throw new Error('task not found')

    const result = await rescue.maybeSpawnRescueOperator({
      failedTask: loaded,
      failureSignature: 'code/unclassified',
      supersessionChecker: async (_originId) => ({ superseded: false as const }),
    })

    // Rescue task spawned as normal
    expect(result.spawned).toBe(true)
    expect(result.rescueTaskId).toBeDefined()
    expect(await countRescueTasks(q)).toBe(1)
    expect(await readArcRescueAttempts(q, task.id)).toBe(1)

    // Origin task is NOT dropped
    const origin = await q.getTask(task.id)
    expect(origin?.status).toBe('queued')
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
    await q.updateTask(first.rescueTaskId!, { status: 'failed', error: 'simulated rescue failure' })

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
    await q.updateTask(first.rescueTaskId!, { status: 'failed', error: 'simulated rescue failure' })

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

  // ── Regression: origin already done → rescue never spawned ──────────────────
  //
  // Observed 2026-08-17: recovery fix-fc05f779 was dispatched to complete
  // rescue-operator mars-a6f6fd91, whose origin mars-2eb61bfd had ALREADY reached
  // done on its own. The recovery entered a clean worktree with nothing to do and
  // dead-ended into an awaiting-human action-queue row that a human had to resolve
  // by hand. The fix: check the arc root's status before spawning.

  it('(g) origin already done: maybeSpawnRescueOperator is a no-op, raises no action-queue row', async () => {
    const { q, rescue } = await loadModules(repo)
    const task = await q.enqueueTask('do a thing', undefined, { skipTriage: true })

    // Mark the origin done BEFORE the rescue is requested (simulates the race
    // where the origin completes on its own between failure detection and rescue dispatch)
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [task.id],
    })

    const loaded = await q.getTask(task.id)
    if (!loaded) throw new Error('task not found')

    const result = await rescue.maybeSpawnRescueOperator({
      failedTask: loaded,
      failureSignature: 'code/unclassified',
    })

    // No rescue task spawned
    expect(result.spawned).toBe(false)
    expect(result.rescueTaskId).toBeUndefined()
    expect(await countRescueTasks(q)).toBe(0)

    // Arc rescue counter stays 0 — no claim was made on the rescue slot
    expect(await readArcRescueAttempts(q, task.id)).toBe(0)

    // No action-queue row raised (no awaiting-human row)
    const aqRows = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM action_queue_items WHERE status = 'open'`,
      args: [],
    })
    expect(Number((aqRows.rows[0] as unknown as { n: number | bigint }).n)).toBe(0)
  })

  // ── Arc-recovered guard: queued / running origin → no rescue spawned ─────────
  //
  // Observed 2026-09-07: rescue mars-87b7c958 was spawned for arc
  // mars-b13ff95e even though the arc's origin had already been `mars
  // continue`'d back to 'queued' (recovered by the operator) at spawn time.
  // The rescue failed with no recorded reason because there was nothing to do.
  // The fix: check 'queued' and 'running' in addition to 'done' at spawn time.
  //
  // These tests model the production scenario correctly: `failedTask` is a FIX
  // TASK (fixForTaskId points to the origin), and the TARGET (origin) is the
  // task we check. In production, `maybeSpawnRescueOperator` is always called
  // with the recovery Chore as `failedTask`, never with the root origin task.

  it("arc-recovered: does not spawn rescue when origin is 'queued' (already continue'd)", async () => {
    const { q, ft, rc, rescue } = await loadModules(repo)

    // Create origin task + fix task, matching the production call shape.
    const origin = await q.enqueueTask('original work', undefined, { skipTriage: true })
    const cleanup = registerTestRecipe(rc, 'test/recipe-for-arc-recovered')
    let fixTaskId: string
    try {
      const fix = await ft.upsertFixTask({
        sourceTaskId: origin.id,
        failureSignature: 'test/recipe-for-arc-recovered',
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

    // Simulate operator `mars continue`'d the origin: origin is now queued again.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'queued' WHERE id = ?`,
      args: [origin.id],
    })

    const loadedFix = await q.getTask(fixTaskId)
    if (!loadedFix) throw new Error('fix task not found')
    // Fix task is 'blocked' (waiting on origin), which is the realistic state
    // at the moment the recovery Chore itself fails.

    const result = await rescue.maybeSpawnRescueOperator({
      failedTask: loadedFix,
      failureSignature: 'code/unclassified',
    })

    // No rescue: origin is queued (arc has recovered — operator already acted).
    expect(result.spawned).toBe(false)
    expect(result.rescueTaskId).toBeUndefined()
    expect(await countRescueTasks(q)).toBe(0)

    // Arc-rescue counter must stay 0: skipped-for-recovered must not consume the slot.
    expect(await readArcRescueAttempts(q, origin.id)).toBe(0)
  })

  it("arc-recovered: does not spawn rescue when origin is 'running' (already dispatched)", async () => {
    const { q, ft, rc, rescue } = await loadModules(repo)

    // Create origin task + fix task, matching the production call shape.
    const origin = await q.enqueueTask('original work', undefined, { skipTriage: true })
    const cleanup = registerTestRecipe(rc, 'test/recipe-for-arc-running')
    let fixTaskId: string
    try {
      const fix = await ft.upsertFixTask({
        sourceTaskId: origin.id,
        failureSignature: 'test/recipe-for-arc-running',
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

    // Simulate origin having been re-dispatched and actively running.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running' WHERE id = ?`,
      args: [origin.id],
    })

    const loadedFix = await q.getTask(fixTaskId)
    if (!loadedFix) throw new Error('fix task not found')

    const result = await rescue.maybeSpawnRescueOperator({
      failedTask: loadedFix,
      failureSignature: 'code/unclassified',
    })

    expect(result.spawned).toBe(false)
    expect(result.rescueTaskId).toBeUndefined()
    expect(await countRescueTasks(q)).toBe(0)
    expect(await readArcRescueAttempts(q, origin.id)).toBe(0)
  })

  // ── Regression: recovery Chore's fix target already done, in a fan-out Arc ──
  //
  // Observed 2026-08-21: fix-c92bb4e6 was the recovery Chore for mars-10a58ad1,
  // both members of the fan-out/proposal-slug Arc
  // "1e904a61-align-self-improvement-loops-with-weakes". mars-10a58ad1 reached
  // `done` on its own at 02:02, before fix-c92bb4e6's coder ran at 02:18 and
  // (correctly) produced an empty diff. Because the (g) origin-done check
  // looked up `failedTask.originId` — the Arc's synthetic proposal-slug root,
  // which is never a real task row in a fan-out Arc — it silently no-op'd and
  // still spawned a rescue (mars-fa61295d), which itself dead-ended into two
  // more empty-diff failures. The fix: check `failedTask.fixForTaskId` (the
  // task the recovery Chore actually exists to fix) ahead of `originId`.

  it('(h) recovery Chore fix target already done in a fan-out Arc: no rescue spawned', async () => {
    const { q, rescue } = await loadModules(repo)

    const proposalSlug = 'fan-out-test-proposal-slug'

    // The task the recovery Chore was created to fix — reaches `done` on its
    // own, independent of the recovery Chore, exactly as mars-10a58ad1 did.
    const target = await q.enqueueTask('original work', undefined, {
      skipTriage: true,
      originId: proposalSlug,
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [target.id],
    })

    // The recovery Chore itself: origin_id is the Arc's proposal-slug root
    // (shared by every fan-out member, never a task row), fix_for_task_id
    // points at `target`.
    const recovery = await q.enqueueTask('recover the thing', undefined, {
      skipTriage: true,
      originId: proposalSlug,
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET fix_for_task_id = ?, kind = 'fix' WHERE id = ?`,
      args: [target.id, recovery.id],
    })

    const loadedRecovery = await q.getTask(recovery.id)
    if (!loadedRecovery) throw new Error('recovery task not found')
    expect(loadedRecovery.fixForTaskId).toBe(target.id)
    expect(loadedRecovery.originId).toBe(proposalSlug)

    const result = await rescue.maybeSpawnRescueOperator({
      failedTask: loadedRecovery,
      failureSignature: 'code/empty-diff',
    })

    expect(result.spawned).toBe(false)
    expect(result.rescueTaskId).toBeUndefined()
    expect(await countRescueTasks(q)).toBe(0)
    expect(await readArcRescueAttempts(q, proposalSlug)).toBe(0)

    const aqRows = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM action_queue_items WHERE status = 'open'`,
      args: [],
    })
    expect(Number((aqRows.rows[0] as unknown as { n: number | bigint }).n)).toBe(0)
  })
})
