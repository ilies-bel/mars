/**
 * E2E tests for `landWorkForTask` — the `land-work` action handler.
 *
 * Acceptance criteria:
 *   1. Fast-forward merge path: when HEAD (integration) is an ancestor of the
 *      task branch, `git merge --ff-only` advances integration to the task tip,
 *      and the worktree-ahead action-queue row is resolved.
 *   2. Cherry-pick path: when FF fails, the ahead commits are cherry-picked
 *      oldest-first onto integration, and the row is resolved.
 *   3. NOT_FOUND error: calling with a non-existent task ID throws with
 *      code: 'NOT_FOUND'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface ActionQueueModule {
  raiseActionQueueItem: typeof import('../../lib/action-queue').raiseActionQueueItem
  listActionQueueItems: typeof import('../../lib/action-queue').listActionQueueItems
}

interface LandWorkModule {
  landWorkForTask: typeof import('../land-work').landWorkForTask
}

/** Create a temp git repo with an initial commit on the `integration` branch. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-land-work-'))
  execFileSync('git', ['init', '-q', '-b', 'integration'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  writeFileSync(resolve(repo, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repo })
  return repo
}

const headSha = (repo: string, ref: string): string =>
  execFileSync('git', ['rev-parse', ref], { cwd: repo }).toString().trim()

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; actionQueue: ActionQueueModule; landWork: LandWorkModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  process.env.INTEGRATION_BRANCH = 'integration'
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  const landWork = (await import('../land-work')) as unknown as LandWorkModule
  return { q, actionQueue, landWork }
}

describe('landWorkForTask', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.INTEGRATION_BRANCH
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Criterion 1: fast-forward merge path ─────────────────────────────────

  it('fast-forward merges task branch onto integration and resolves the action-queue row', async () => {
    const { q, actionQueue, landWork } = await loadModules(repo)
    const taskId = 'mars-lw01'
    const branch = `task/${taskId}`

    // Create 2 commits ahead of integration on the task branch
    execFileSync('git', ['checkout', '-b', branch], { cwd: repo })
    writeFileSync(resolve(repo, 'work1.txt'), 'work 1\n')
    execFileSync('git', ['add', 'work1.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'work commit 1'], { cwd: repo })
    writeFileSync(resolve(repo, 'work2.txt'), 'work 2\n')
    execFileSync('git', ['add', 'work2.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'work commit 2'], { cwd: repo })
    const taskTip = headSha(repo, branch)

    // Return to integration so HEAD is on the integration branch
    execFileSync('git', ['checkout', 'integration'], { cwd: repo })

    // Persist a task row with the branch set
    const task = await q.enqueueTask('land-work test task', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET branch = ?, status = 'failed' WHERE id = ?`,
      args: [branch, task.id],
    })

    // Raise a worktree-ahead action-queue row
    await actionQueue.raiseActionQueueItem({
      kind: 'worktree-ahead',
      category: 'orchestrator',
      priority: 'high',
      title: 'Task branch is ahead of integration',
      body: `Branch ${branch} has commits ahead of integration`,
      payload: { taskId: task.id, branch },
      context: {},
      raisedBy: 'test',
      originTaskId: task.id,
      signature: `worktree-ahead:${task.id}`,
    })

    // Act: land the work
    await landWork.landWorkForTask(task.id)

    // Assert: integration HEAD advanced to the task branch tip
    expect(headSha(repo, 'integration')).toBe(taskTip)

    // Assert: the action-queue row was resolved
    const rows = await actionQueue.listActionQueueItems('all', { kind: 'worktree-ahead' })
    const row = rows.find((r) => r.originTaskId === task.id)
    expect(row).toBeDefined()
    expect(row!.state).toBe('resolved')
  })

  // ── Criterion 2: cherry-pick path ────────────────────────────────────────

  it('cherry-picks ahead commits oldest-first when fast-forward is not possible', async () => {
    const { q, actionQueue, landWork } = await loadModules(repo)
    const taskId = 'mars-lw02'
    const branch = `task/${taskId}`

    // Create the task branch from integration with one commit ahead
    execFileSync('git', ['checkout', '-b', branch], { cwd: repo })
    writeFileSync(resolve(repo, 'task-work.txt'), 'task work\n')
    execFileSync('git', ['add', 'task-work.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'task: add task-work.txt'], { cwd: repo })
    execFileSync('git', ['checkout', 'integration'], { cwd: repo })

    // Diverge integration so FF is impossible
    writeFileSync(resolve(repo, 'hotfix.txt'), 'hotfix\n')
    execFileSync('git', ['add', 'hotfix.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'hotfix on integration'], { cwd: repo })

    // Persist task row
    const task = await q.enqueueTask('cherry-pick test task', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET branch = ?, status = 'failed' WHERE id = ?`,
      args: [branch, task.id],
    })

    // Raise action-queue row
    await actionQueue.raiseActionQueueItem({
      kind: 'worktree-ahead',
      category: 'orchestrator',
      priority: 'high',
      title: 'Task branch is ahead of integration',
      body: `Branch ${branch} has commits ahead of integration`,
      payload: { taskId: task.id, branch },
      context: {},
      raisedBy: 'test',
      originTaskId: task.id,
      signature: `worktree-ahead:${task.id}`,
    })

    // Act: land the work (cherry-pick path because FF is blocked)
    await landWork.landWorkForTask(task.id)

    // Assert: integration has the task commit cherry-picked (log includes the subject)
    const log = execFileSync('git', ['log', '--format=%s', 'integration'], { cwd: repo })
      .toString()
      .trim()
    expect(log).toContain('task: add task-work.txt')

    // Assert: row resolved
    const rows = await actionQueue.listActionQueueItems('all', { kind: 'worktree-ahead' })
    const row = rows.find((r) => r.originTaskId === task.id)
    expect(row).toBeDefined()
    expect(row!.state).toBe('resolved')
  })

  // ── Criterion 3: NOT_FOUND error ─────────────────────────────────────────

  it('throws NOT_FOUND when the task does not exist', async () => {
    const { landWork } = await loadModules(repo)

    await expect(landWork.landWorkForTask('no-such-task')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})
