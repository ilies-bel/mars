/**
 * Verifies that a dirty merge target (merge:preflight/uncommitted-changes) is
 * treated as an operator/environment condition rather than a task defect:
 *
 *  - The arc's single recovery budget is NOT consumed (no fix task is spawned).
 *  - A dedicated operator action-queue item is raised with clear instructions.
 *  - The task ends up in `failed` status with `failedPhase='merge'` so
 *    `mars continue <id>` can re-attempt just the merge step once the operator
 *    has cleaned the integration branch — the committed work on the task branch
 *    is preserved.
 *  - Calling `handleTaskFailureWithFixTask` for a real code failure (different
 *    signature) still spawns a fix task normally — the existing path is intact.
 *
 * Implementation note: the merge step in implement-workflow.ts directly calls
 * updateTask + raiseActionQueueItem for the dirty-target case, deliberately
 * bypassing handleTaskFailureWithFixTask. These tests verify the resulting DB
 * state matches the design intent without instantiating the full workflow.
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
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface ActionQueueModule {
  raiseActionQueueItem: typeof import('../action-queue').raiseActionQueueItem
  initActionQueue: typeof import('../action-queue').initActionQueue
  listActionQueueItems: typeof import('../action-queue').listActionQueueItems
}

interface FixTasksModule {
  handleTaskFailureWithFixTask: typeof import('../../queue-fix-tasks').handleTaskFailureWithFixTask
}

interface RecipesModule {
  recipes: typeof import('../fix-recipes').recipes
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-merge-dirty-target-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

let templateRepo: string

const cloneTemplateDbs = (destRepo: string): void => {
  for (const file of ['queue.db', 'state.db'] as const) {
    const src = resolve(templateRepo, '.mars', file)
    if (!existsSync(src)) continue
    copyFileSync(src, resolve(destRepo, '.mars', file))
  }
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; aq: ActionQueueModule; ft: FixTasksModule; rc: RecipesModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const aq = (await import('../action-queue')) as unknown as ActionQueueModule
  const ft = (await import('../../queue-fix-tasks')) as unknown as FixTasksModule
  const rc = (await import('../fix-recipes')) as unknown as RecipesModule
  return { q, aq, ft, rc }
}

describe('merge:preflight/uncommitted-changes — dirty merge target hold', () => {
  let repo: string

  beforeAll(async () => {
    // Build a fully-migrated template repo once. Per-test repos clone these files.
    templateRepo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = templateRepo
    const q = (await import('../../queue')) as unknown as QueueModule
    await q.migrateQueueSchema()
    // Seed state.db (action queue schema) so the template carries it.
    const aq = (await import('../action-queue')) as unknown as ActionQueueModule
    await aq.initActionQueue()
    delete process.env.MARS_REPO
    vi.resetModules()
  }, 30_000)

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

  it('dirty merge target: task is marked failed with failedPhase=merge — no fix task spawned (recovery budget NOT consumed)', async () => {
    const { q, aq } = await loadModules(repo)
    const task = await q.enqueueTask('implement some feature', undefined, { skipTriage: true })

    // Simulate what the merge step in implement-workflow.ts does when it detects
    // a dirty target: updateTask to failed + raiseActionQueueItem, NO
    // handleTaskFailureWithFixTask call (that would consume recovery budget).
    const DIRTY_TARGET_SIGNATURE = 'merge:preflight/uncommitted-changes'
    const statusOutput = 'M orchestrator/src/core/workers/index.ts'
    const targetPath = '/repo'
    const integrationBranch = 'main'
    const taskBranch = `task/${task.id}`
    const errorMsg = `merge target ${targetPath} has uncommitted changes blocking fast-forward\ntracked changes on paths the fast-forward would update:\n${statusOutput}`

    await q.updateTask(task.id, {
      status: 'failed',
      error: errorMsg,
      failedPhase: 'merge',
      failureReason: DIRTY_TARGET_SIGNATURE,
      failureReasonCode: DIRTY_TARGET_SIGNATURE,
      failureSignature: DIRTY_TARGET_SIGNATURE,
    })

    await aq.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: `Merge blocked: ${integrationBranch} has uncommitted changes — clean and continue ${task.id}`,
      body: [
        `Task \`${task.id}\` reached the merge step with committed work on branch \`${taskBranch}\`, but the merge target (\`${integrationBranch}\`) has uncommitted tracked changes.`,
        '',
        `**To unblock:** clean \`${integrationBranch}\`, then run \`mars continue ${task.id}\`.`,
      ].join('\n'),
      payload: {
        taskId: task.id,
        branch: taskBranch,
        integrationBranch,
        targetPath,
        statusOutput,
      },
      context: { repoRoot: repo },
      raisedBy: 'merge:preflight:dirty-target',
      signature: `${task.id}:${DIRTY_TARGET_SIGNATURE}`,
      originTaskId: task.id,
      occurrence: {
        at: new Date().toISOString(),
        taskId: task.id,
        integrationBranch,
      },
    })

    // Assert: task is failed with failedPhase=merge (continuable via `mars continue`)
    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failedPhase).toBe('merge')
    expect(reloaded?.failureSignature).toBe(DIRTY_TARGET_SIGNATURE)

    // Assert: NO fix-task row created (recovery budget NOT consumed).
    const fixTasks = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [task.id],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(0)

    // Assert: action-queue item raised (operator can see it).
    const items = await aq.listActionQueueItems('open')
    const dirtyItem = items.find(
      (i) => i.signature === `${task.id}:${DIRTY_TARGET_SIGNATURE}`,
    )
    expect(dirtyItem).toBeDefined()
    expect(dirtyItem?.kind).toBe('failed')
    expect(dirtyItem?.priority).toBe('high')
    expect(dirtyItem?.title).toContain('clean and continue')
  })

  it('dirty merge target: task has failedPhase=merge, which mars continue requires to re-enter the merge step', async () => {
    const { q, aq } = await loadModules(repo)
    const task = await q.enqueueTask('fix something', undefined, { skipTriage: true })

    const DIRTY_TARGET_SIGNATURE = 'merge:preflight/uncommitted-changes'
    await q.updateTask(task.id, {
      status: 'failed',
      error: 'dirty target',
      failedPhase: 'merge',
      failureSignature: DIRTY_TARGET_SIGNATURE,
    })
    await aq.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: `Merge blocked — ${task.id}`,
      body: 'dirty target',
      payload: { taskId: task.id },
      context: {},
      raisedBy: 'merge:preflight:dirty-target',
      signature: `${task.id}:${DIRTY_TARGET_SIGNATURE}`,
      originTaskId: task.id,
    })

    const reloaded = await q.getTask(task.id)
    // `mars continue` checks task.status === 'failed' && task.failedPhase === 'merge'
    // to determine it can re-enter at the merge step (engine checkpoint-resume).
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failedPhase).toBe('merge')
  })

  it('dirty merge target repeated raises: action-queue item seenCount increments, no duplicate rows', async () => {
    const { q, aq } = await loadModules(repo)
    const task = await q.enqueueTask('do work', undefined, { skipTriage: true })

    const DIRTY_TARGET_SIGNATURE = 'merge:preflight/uncommitted-changes'
    const signature = `${task.id}:${DIRTY_TARGET_SIGNATURE}`
    const raiseArgs = {
      kind: 'failed' as const,
      category: 'orchestrator' as const,
      priority: 'high' as const,
      title: `Merge blocked — ${task.id}`,
      body: 'dirty target',
      payload: { taskId: task.id },
      context: {},
      raisedBy: 'merge:preflight:dirty-target',
      signature,
      originTaskId: task.id,
      occurrence: { at: new Date().toISOString(), taskId: task.id },
    }

    await aq.raiseActionQueueItem(raiseArgs)
    await aq.raiseActionQueueItem(raiseArgs)
    await aq.raiseActionQueueItem(raiseArgs)

    const items = await aq.listActionQueueItems('open')
    const matching = items.filter((i) => i.signature === signature)
    // Deduped on signature → exactly one row.
    expect(matching).toHaveLength(1)
    expect(matching[0]!.seenCount).toBe(3)

    // Still no fix tasks.
    const fixTasks = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [task.id],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  it('recovery task hitting dirty merge target: task becomes failed+continuable, not recovery-failed (arc not terminal)', async () => {
    /**
     * This is the exact scenario from the task brief: a fix/recovery task that
     * DID its work and committed it, but failed at the merge step because main
     * was dirty. With handleTaskFailureWithFixTask, this would have escalated
     * to "recovery-failed" — terminal-failing the entire arc.
     *
     * With the new path: the recovery task is marked failed+failedPhase=merge
     * (NOT via handleTaskFailureWithFixTask), so `mars continue <recovery_id>`
     * re-attempts just the merge step. The arc is recoverable.
     */
    const { q, aq } = await loadModules(repo)
    const originTask = await q.enqueueTask('original work', undefined, { skipTriage: true })
    const recoveryTask = await q.enqueueTask('fix original work', undefined, { skipTriage: true })

    // Make recoveryTask a fix/recovery task (fix_for_task_id set).
    const client = q.resolveQueueClient()
    await client.execute({
      sql: `UPDATE tasks SET fix_for_task_id = ?, status = 'running', branch = ?, worktree_path = ? WHERE id = ?`,
      args: [originTask.id, `task/${recoveryTask.id}`, `/tmp/worktree-${recoveryTask.id}`, recoveryTask.id],
    })

    const DIRTY_TARGET_SIGNATURE = 'merge:preflight/uncommitted-changes'
    const statusOutput = 'M orchestrator/src/core/workers/index.ts'

    // New merge step behavior: update to failed+failedPhase=merge, raise action-queue item.
    await q.updateTask(recoveryTask.id, {
      status: 'failed',
      error: `merge target has uncommitted changes\n${statusOutput}`,
      failedPhase: 'merge',
      failureReason: DIRTY_TARGET_SIGNATURE,
      failureReasonCode: DIRTY_TARGET_SIGNATURE,
      failureSignature: DIRTY_TARGET_SIGNATURE,
    })
    await aq.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: `Merge blocked: main has uncommitted changes — clean and continue ${recoveryTask.id}`,
      body: 'dirty target — clean main, then mars continue to retry the merge',
      payload: { taskId: recoveryTask.id, statusOutput },
      context: {},
      raisedBy: 'merge:preflight:dirty-target',
      signature: `${recoveryTask.id}:${DIRTY_TARGET_SIGNATURE}`,
      originTaskId: recoveryTask.id,
      occurrence: { at: new Date().toISOString() },
    })

    // Assert: the recovery task is failed+continuable, NOT terminal.
    const reloaded = await q.getTask(recoveryTask.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failedPhase).toBe('merge')
    expect(reloaded?.failureSignature).toBe(DIRTY_TARGET_SIGNATURE)

    // Assert: NO "recovery-failed" escalation — the action-queue item is a
    // "clean and continue" notification, not a terminal "fix and retry or abandon".
    const items = await aq.listActionQueueItems('open')
    const operatorItem = items.find(
      (i) => i.signature === `${recoveryTask.id}:${DIRTY_TARGET_SIGNATURE}`,
    )
    expect(operatorItem).toBeDefined()
    expect(operatorItem?.title).toContain('clean and continue')
    // Must NOT contain the terminal "abandon" language.
    expect(operatorItem?.body).not.toContain('abandon')

    // Assert: NO fix task was spawned (recovery budget NOT consumed).
    const fixTasks = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [recoveryTask.id],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  it('regression: real code failure (non-dirty-target) still spawns a fix task via handleTaskFailureWithFixTask', async () => {
    /**
     * Guard that the dirty-target change doesn't break the normal recovery path.
     * A verify:typecheck failure (not dirty-target) should still spawn a fix task.
     */
    const { q, ft, rc } = await loadModules(repo)

    // Register a synthetic recipe so handleTaskFailureWithFixTask finds one.
    const sig = 'verify:typecheck/typecheck-cannot-find-name'
    ;(rc.recipes as Record<string, unknown>)[sig] = {
      signature: sig,
      title: () => 'Test recipe',
      buildPrompt: () => 'Fix the typecheck error',
    }

    const task = await q.enqueueTask('implement feature', undefined, { skipTriage: true })
    const result = await ft.handleTaskFailureWithFixTask({
      taskId: task.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
      branch: `task/${task.id}`,
    })

    // Normal path: fix task IS spawned (recovery budget IS consumed — expected).
    expect(result.outcome).toBe('blocked')
    expect(result.fixTaskId).toBeTruthy()

    const fixTasks = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [task.id],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(1)

    delete (rc.recipes as Record<string, unknown>)[sig]
  })
})
