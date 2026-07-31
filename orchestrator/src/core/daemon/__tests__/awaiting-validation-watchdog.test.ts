import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  updateTask: typeof import('../../queue').updateTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface ActionQueueModule {
  raiseActionQueueItem: typeof import('../../lib/action-queue').raiseActionQueueItem
  listActionQueueItems: typeof import('../../lib/action-queue').listActionQueueItems
}

interface WatchdogModule {
  runAwaitingValidationSweep: typeof import('../awaiting-validation-watchdog').runAwaitingValidationSweep
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-awaiting-validation-watchdog-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string): Promise<{
  q: QueueModule
  actionQueue: ActionQueueModule
  watchdog: WatchdogModule
}> => {
  const { vi } = await import('vitest')
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  const watchdog = (await import('../awaiting-validation-watchdog')) as unknown as WatchdogModule
  return { q, actionQueue, watchdog }
}

const parkAtClosedPreview = async (
  q: QueueModule,
  actionQueue: ActionQueueModule,
  nowMs: number,
  ageMs = 0,
): Promise<string> => {
  const task = await q.enqueueTask('review the preview', undefined, { skipTriage: true })
  await q.updateTask(task.id, {
    status: 'awaiting-validation',
    devServerUrl: 'http://127.0.0.1:1',
    devServerPid: null,
  })
  await q.resolveQueueClient().execute({
    sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
    args: [new Date(nowMs - ageMs).toISOString(), task.id],
  })
  await actionQueue.raiseActionQueueItem({
    kind: 'awaiting-validation',
    category: 'task',
    priority: 'high',
    title: `Validate ${task.id}`,
    body: 'Preview ready: http://127.0.0.1:1',
    payload: { taskId: task.id, devServerUrl: 'http://127.0.0.1:1' },
    context: { taskId: task.id },
    raisedBy: 'test',
    signature: task.id,
    originTaskId: task.id,
  })
  return task.id
}

describe('runAwaitingValidationSweep', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_AWAITING_VALIDATION_MAX_AGE_MS
    rmSync(repo, { recursive: true, force: true })
  })

  it('keeps a task awaiting a decision but demotes its action when its preview port is closed', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const taskId = await parkAtClosedPreview(q, actionQueue, nowMs)

    const result = await watchdog.runAwaitingValidationSweep({ nowMs })

    expect(result.demoted).toEqual([taskId])
    expect((await q.getTask(taskId))?.status).toBe('awaiting-validation')
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'awaiting-validation-preview-gone',
      priority: 'normal',
    })
    expect(items[0].title).toContain('Preview unavailable')
  })

  it('fails an expired task after its preview is unreachable', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const taskId = await parkAtClosedPreview(q, actionQueue, nowMs, 49 * 60 * 60_000)

    const result = await watchdog.runAwaitingValidationSweep({ nowMs })

    expect(result.failed).toEqual([taskId])
    expect((await q.getTask(taskId))).toMatchObject({
      status: 'failed',
      failureReason: 'awaiting-validation:preview-gone',
    })
    expect(await actionQueue.listActionQueueItems('open')).toHaveLength(0)
  })
})
