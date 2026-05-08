import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
  getClient: typeof import('../../queue').getClient
  initQueue: typeof import('../../queue').initQueue
}

interface FixModule {
  handleTaskFailure: typeof import('../../queue-fix-suggestions').handleTaskFailure
}

interface BlockerModule {
  resolveBlockerForSuggestion: typeof import('../../blocker-resolution').resolveBlockerForSuggestion
  onChildTaskCompleted: typeof import('../../blocker-resolution').onChildTaskCompleted
  recoverBlockedTasks: typeof import('../../blocker-resolution').recoverBlockedTasks
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-blocker-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; fix: FixModule; br: BlockerModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const fix = (await import(
    '../../queue-fix-suggestions'
  )) as unknown as FixModule
  const br = (await import(
    '../../blocker-resolution'
  )) as unknown as BlockerModule
  return { q, fix, br }
}

const insertChildSuggestionLink = async (
  q: QueueModule,
  suggestionId: string,
  childTaskId: string,
  status: 'promoted' | 'accepted' | 'proposed' = 'promoted',
): Promise<void> => {
  await q.getClient().execute({
    sql: `UPDATE task_suggestions SET created_task_id = ?, status = ? WHERE id = ?`,
    args: [childTaskId, status, suggestionId],
  })
}

describe('blocker-resolution', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  it('suggestion accepted -> blocked tasks transition to queued with retry_count preserved', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, fix, br } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    const failure = await fix.handleTaskFailure({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304',
    })
    expect(failure.outcome).toBe('blocked')

    const result = await br.resolveBlockerForSuggestion(failure.suggestionId!)
    expect(result.outcomes).toHaveLength(1)
    expect(result.outcomes[0].outcome).toBe('queued')
    expect(result.outcomes[0].retryCount).toBe(1)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
    expect(reloaded?.retryCount).toBe(1)
    expect(reloaded?.blockerId).toBe(failure.suggestionId)
  })

  it('multiple tasks blocked on same suggestion all unblock together', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, fix, br } = await loadModules(repo)
    const t1 = await q.enqueueTask('a', undefined, { skipTriage: true })
    const t2 = await q.enqueueTask('b', undefined, { skipTriage: true })

    const f1 = await fix.handleTaskFailure({
      taskId: t1.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'shared error',
    })
    // Manually point t2 at the same suggestion to simulate two tasks sharing
    // the same blocker.
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'blocked', blocker_id = ?, retry_count = 1 WHERE id = ?`,
      args: [f1.suggestionId!, t2.id],
    })

    const result = await br.resolveBlockerForSuggestion(f1.suggestionId!)
    const queuedIds = result.outcomes
      .filter((o) => o.outcome === 'queued')
      .map((o) => o.taskId)
      .sort()
    expect(queuedIds).toEqual([t1.id, t2.id].sort())

    const r1 = await q.getTask(t1.id)
    const r2 = await q.getTask(t2.id)
    expect(r1?.status).toBe('queued')
    expect(r2?.status).toBe('queued')
  })

  it('drops task with retry_count >= MARS_FIX_RETRY_BUDGET at unblock time', async () => {
    // Budget=1, force retry_count=1 on a blocked task -> should drop on unblock.
    process.env.MARS_FIX_RETRY_BUDGET = '1'
    const { q, fix, br } = await loadModules(repo)
    const t = await q.enqueueTask('a', undefined, { skipTriage: true })
    const f = await fix.handleTaskFailure({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'err',
    })
    expect(f.outcome).toBe('blocked')
    // After first failure, retry_count=1, budget=1 -> drop on unblock.

    const result = await br.resolveBlockerForSuggestion(f.suggestionId!)
    expect(result.outcomes).toHaveLength(1)
    expect(result.outcomes[0].outcome).toBe('dropped')
    expect(result.outcomes[0].dropReason).toBe(
      'retry_budget_exhausted_at_unblock',
    )

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('dropped')
    expect(reloaded?.dropReason).toBe('retry_budget_exhausted_at_unblock')
  })

  it('is idempotent: running unblock twice does not double-queue', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, fix, br } = await loadModules(repo)
    const t = await q.enqueueTask('a', undefined, { skipTriage: true })
    const f = await fix.handleTaskFailure({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'err',
    })

    const first = await br.resolveBlockerForSuggestion(f.suggestionId!)
    expect(first.acceptedNow).toBe(true)
    expect(first.outcomes[0].outcome).toBe('queued')

    const second = await br.resolveBlockerForSuggestion(f.suggestionId!)
    expect(second.acceptedNow).toBe(false)
    // Already past 'blocked' (now 'queued'), so noop.
    expect(second.outcomes).toHaveLength(0)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('onChildTaskCompleted resolves blocker via the suggestion->child link', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, fix, br } = await loadModules(repo)
    const sourceTask = await q.enqueueTask('src', undefined, {
      skipTriage: true,
    })
    const f = await fix.handleTaskFailure({
      taskId: sourceTask.id,
      failingStep: 'verify',
      errorOutput: 'err',
    })
    const childTask = await q.enqueueTask('fix it', undefined, {
      skipTriage: true,
    })
    await insertChildSuggestionLink(q, f.suggestionId!, childTask.id)

    const r = await br.onChildTaskCompleted(childTask.id)
    expect(r).not.toBeNull()
    expect(r!.suggestionId).toBe(f.suggestionId)
    expect(r!.outcomes[0].outcome).toBe('queued')

    const reloaded = await q.getTask(sourceTask.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('onChildTaskCompleted returns null when the task is not linked to a fix suggestion', async () => {
    const { q, br } = await loadModules(repo)
    const t = await q.enqueueTask('plain', undefined, { skipTriage: true })
    const r = await br.onChildTaskCompleted(t.id)
    expect(r).toBeNull()
  })

  it('recoverBlockedTasks unblocks tasks whose suggestion was already accepted while daemon was down', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, fix, br } = await loadModules(repo)
    const sourceTask = await q.enqueueTask('src', undefined, {
      skipTriage: true,
    })
    const f = await fix.handleTaskFailure({
      taskId: sourceTask.id,
      failingStep: 'verify',
      errorOutput: 'err',
    })
    // Simulate: the suggestion's child task already completed, but the
    // daemon died before running the unblock side-effects. Mark suggestion
    // accepted directly.
    await q.getClient().execute({
      sql: `UPDATE task_suggestions SET status = 'accepted' WHERE id = ?`,
      args: [f.suggestionId!],
    })
    const beforeRecover = await q.getTask(sourceTask.id)
    expect(beforeRecover?.status).toBe('blocked')

    const recovered = await br.recoverBlockedTasks()
    expect(recovered).toHaveLength(1)
    expect(recovered[0].suggestionId).toBe(f.suggestionId)
    expect(recovered[0].outcomes[0].outcome).toBe('queued')

    const reloaded = await q.getTask(sourceTask.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('recoverBlockedTasks unblocks tasks whose linked child task is already done', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, fix, br } = await loadModules(repo)
    const sourceTask = await q.enqueueTask('src', undefined, {
      skipTriage: true,
    })
    const f = await fix.handleTaskFailure({
      taskId: sourceTask.id,
      failingStep: 'verify',
      errorOutput: 'err',
    })
    const childTask = await q.enqueueTask('fix it', undefined, {
      skipTriage: true,
    })
    await insertChildSuggestionLink(q, f.suggestionId!, childTask.id, 'promoted')
    // Child completes but unblock never ran (daemon was down).
    await q.updateTask(childTask.id, { status: 'done' })

    const recovered = await br.recoverBlockedTasks()
    expect(recovered).toHaveLength(1)
    expect(recovered[0].outcomes[0].outcome).toBe('queued')

    const reloaded = await q.getTask(sourceTask.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('recoverBlockedTasks is a no-op when blocker is still unresolved', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, fix, br } = await loadModules(repo)
    const sourceTask = await q.enqueueTask('src', undefined, {
      skipTriage: true,
    })
    await fix.handleTaskFailure({
      taskId: sourceTask.id,
      failingStep: 'verify',
      errorOutput: 'err',
    })
    // Suggestion still 'proposed', no child task.
    const recovered = await br.recoverBlockedTasks()
    expect(recovered).toHaveLength(0)

    const reloaded = await q.getTask(sourceTask.id)
    expect(reloaded?.status).toBe('blocked')
  })
})
