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

interface FixTasksModule {
  upsertFixTask: typeof import('../../queue-fix-tasks').upsertFixTask
  handleTaskFailureWithFixTask: typeof import('../../queue-fix-tasks').handleTaskFailureWithFixTask
}

interface BlockerModule {
  onBlockerTaskCompleted: typeof import('../../blocker-resolution').onBlockerTaskCompleted
  recoverBlockedTasksByBlockerTable: typeof import('../../blocker-resolution').recoverBlockedTasksByBlockerTable
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-fix-tasks-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; ft: FixTasksModule; br: BlockerModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const ft = (await import('../../queue-fix-tasks')) as unknown as FixTasksModule
  const br = (await import(
    '../../blocker-resolution'
  )) as unknown as BlockerModule
  return { q, ft, br }
}

describe('queue-fix-tasks', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  it('upsertFixTask creates a queued task and a task_blockers row in one transaction', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })

    const r = await ft.upsertFixTask({
      sourceTaskId: t.id,
      failureSignature: 'sig1',
      failingStep: 'verify:typecheck',
      truncatedError: 'TS2304',
      branch: 'task/x',
    })
    expect(r.created).toBe(true)
    expect(r.fixTaskId).toBeTruthy()

    const fix = await q.getTask(r.fixTaskId)
    expect(fix?.status).toBe('queued')
    expect(fix?.fixForTaskId).toBe(t.id)
    expect(fix?.failureSignature).toBe('sig1')
    expect(fix?.author?.kind).toBe('agent')

    const blockers = await q.getClient().execute({
      sql: `SELECT task_id, blocker_task_id FROM task_blockers WHERE task_id = ?`,
      args: [t.id],
    })
    expect(blockers.rows).toHaveLength(1)
    expect((blockers.rows[0] as unknown as { blocker_task_id: string }).blocker_task_id).toBe(r.fixTaskId)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('blocked')
    expect(reloaded?.retryCount).toBe(1)
  })

  it('idempotent: calling upsertFixTask twice with same (sourceTaskId, failureSignature) reuses the existing fix task', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })

    const a = await ft.upsertFixTask({
      sourceTaskId: t.id,
      failureSignature: 'sig-dup',
      failingStep: 'verify:typecheck',
      truncatedError: 'errA',
      branch: null,
    })
    const b = await ft.upsertFixTask({
      sourceTaskId: t.id,
      failureSignature: 'sig-dup',
      failingStep: 'verify:typecheck',
      truncatedError: 'errA',
      branch: null,
    })
    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    expect(b.fixTaskId).toBe(a.fixTaskId)

    const r = await q.getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ? AND failure_signature = ?`,
      args: [t.id, 'sig-dup'],
    })
    expect(Number((r.rows[0] as unknown as { n: number }).n)).toBe(1)
  })

  it('handleTaskFailureWithFixTask transitions source to blocked with retry_count++', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })

    const r = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
      branch: 'task/x',
    })
    expect(r.outcome).toBe('blocked')
    expect(r.fixTaskId).toBeTruthy()
    expect(r.retryCount).toBe(1)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('blocked')
    expect(reloaded?.retryCount).toBe(1)
  })

  it('drops source task and creates no fix task when retry_count >= MARS_FIX_RETRY_BUDGET', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '0'
    const { q, ft } = await loadModules(repo)
    process.env.MARS_FIX_RETRY_BUDGET = '0'
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })

    const r = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'errA',
    })
    expect(r.outcome).toBe('dropped')

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('dropped')

    const fixTasks = await q.getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
      args: [t.id],
    })
    expect(Number((fixTasks.rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  it('daemon trigger: when a fix task lands done, the source task it blocks transitions back to queued', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, br } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    const f = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'err',
    })
    expect(f.outcome).toBe('blocked')

    // Fix task lands done.
    await q.updateTask(f.fixTaskId!, { status: 'done' })

    const result = await br.onBlockerTaskCompleted(f.fixTaskId!)
    expect(result.outcomes).toHaveLength(1)
    expect(result.outcomes[0].outcome).toBe('queued')

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('multiple tasks blocked on the same fix task all unblock atomically', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, br } = await loadModules(repo)
    const t1 = await q.enqueueTask('a', undefined, { skipTriage: true })
    const t2 = await q.enqueueTask('b', undefined, { skipTriage: true })

    const f1 = await ft.upsertFixTask({
      sourceTaskId: t1.id,
      failureSignature: 'shared',
      failingStep: 'verify',
      truncatedError: 'shared err',
      branch: null,
    })
    // Manually wire t2 to the same fix task to simulate a shared blocker.
    const now = new Date().toISOString()
    await q.getClient().execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)`,
      args: [t2.id, f1.fixTaskId, now],
    })
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'blocked', retry_count = 1, updated_at = ? WHERE id = ?`,
      args: [now, t2.id],
    })

    await q.updateTask(f1.fixTaskId, { status: 'done' })
    const result = await br.onBlockerTaskCompleted(f1.fixTaskId)
    const queuedIds = result.outcomes
      .filter((o) => o.outcome === 'queued')
      .map((o) => o.taskId)
      .sort()
    expect(queuedIds).toEqual([t1.id, t2.id].sort())

    expect((await q.getTask(t1.id))?.status).toBe('queued')
    expect((await q.getTask(t2.id))?.status).toBe('queued')
  })

  it('drops dependent task at unblock time when retry budget already exhausted', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '1'
    const { q, ft, br } = await loadModules(repo)
    const t = await q.enqueueTask('a', undefined, { skipTriage: true })
    const f = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'err',
    })
    expect(f.outcome).toBe('blocked')
    expect(f.retryCount).toBe(1)

    await q.updateTask(f.fixTaskId!, { status: 'done' })
    const result = await br.onBlockerTaskCompleted(f.fixTaskId!)
    expect(result.outcomes).toHaveLength(1)
    expect(result.outcomes[0].outcome).toBe('dropped')

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('dropped')
  })

  it('recoverBlockedTasksByBlockerTable unblocks tasks whose blocker task was already done', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, br } = await loadModules(repo)
    const t = await q.enqueueTask('a', undefined, { skipTriage: true })
    const f = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify',
      errorOutput: 'err',
    })

    // Fix task lands done while daemon was down (no unblock event ran).
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?`,
      args: [new Date().toISOString(), f.fixTaskId!],
    })

    const recovered = await br.recoverBlockedTasksByBlockerTable()
    expect(recovered).toHaveLength(1)
    expect(recovered[0].outcomes[0].outcome).toBe('queued')

    expect((await q.getTask(t.id))?.status).toBe('queued')
  })
})
