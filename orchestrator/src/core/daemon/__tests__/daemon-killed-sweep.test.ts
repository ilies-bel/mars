import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
}

interface ActionQueueModule {
  listActionQueueItems: typeof import('../../lib/action-queue').listActionQueueItems
}

interface SweepModule {
  detectAndRaiseDaemonKilled: typeof import('../daemon-killed-sweep').detectAndRaiseDaemonKilled
  buildDaemonKilledBody: typeof import('../daemon-killed-sweep').buildDaemonKilledBody
  DAEMON_KILLED_ACTION_QUEUE_KIND: typeof import('../daemon-killed-sweep').DAEMON_KILLED_ACTION_QUEUE_KIND
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-daemon-killed-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; actionQueue: ActionQueueModule; sweep: SweepModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  const sweep = (await import('../daemon-killed-sweep')) as unknown as SweepModule
  return { q, actionQueue, sweep }
}

describe('detectAndRaiseDaemonKilled', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('raises exactly one alert per daemon-killed task and does NOT requeue it', async () => {
    const { q, actionQueue, sweep } = await loadModules(repo)

    const task = await q.enqueueTask('killed work', undefined, { skipTriage: true })
    await q.updateTask(task.id, {
      status: 'failed',
      error: 'killed by `mars daemon kill`',
      failureSignature: 'daemon-killed',
    })

    const raised = await sweep.detectAndRaiseDaemonKilled()
    expect(raised).toHaveLength(1)

    // Alert-only: status must remain 'failed', never auto-flipped to queued.
    const after = await q.getTask(task.id)
    expect(after?.status).toBe('failed')

    const items = await actionQueue.listActionQueueItems()
    const ours = items.filter((i) => i.kind === sweep.DAEMON_KILLED_ACTION_QUEUE_KIND)
    expect(ours).toHaveLength(1)
    expect(ours[0]?.title).toContain(task.id)
  })

  it('ignores failed tasks without the daemon-killed signature', async () => {
    const { q, sweep } = await loadModules(repo)

    const task = await q.enqueueTask('ordinary failure', undefined, {
      skipTriage: true,
    })
    await q.updateTask(task.id, { status: 'failed', error: 'verify failed' })

    const raised = await sweep.detectAndRaiseDaemonKilled()
    expect(raised).toHaveLength(0)
  })

  it('dedupes on re-detection (one row, bumped) rather than inserting siblings', async () => {
    const { q, actionQueue, sweep } = await loadModules(repo)

    const task = await q.enqueueTask('killed work', undefined, { skipTriage: true })
    await q.updateTask(task.id, {
      status: 'failed',
      failureSignature: 'daemon-killed',
    })

    await sweep.detectAndRaiseDaemonKilled()
    await sweep.detectAndRaiseDaemonKilled()

    const items = await actionQueue.listActionQueueItems()
    const ours = items.filter((i) => i.kind === sweep.DAEMON_KILLED_ACTION_QUEUE_KIND)
    expect(ours).toHaveLength(1)
    expect(ours[0]?.seenCount).toBeGreaterThanOrEqual(2)
  })

  it('body lists the registry recovery action labels', async () => {
    const { sweep } = await loadModules(repo)
    const body = sweep.buildDaemonKilledBody('mars-abc')
    expect(body).toContain('mars-abc')
    expect(body).toContain('Requeue now')
    expect(body).toContain('Restart daemon')
  })

  it('payload records branch=null for a task killed in setup phase (no branch assigned yet)', async () => {
    const { q, actionQueue, sweep } = await loadModules(repo)

    // Task killed in setup: no branch was ever assigned (branch stays null).
    const task = await q.enqueueTask('killed work', undefined, { skipTriage: true })
    await q.updateTask(task.id, {
      status: 'failed',
      error: 'killed by `mars daemon kill`',
      failureSignature: 'daemon-killed',
      // branch intentionally not set — simulates a kill before setup completes
    })

    await sweep.detectAndRaiseDaemonKilled()

    const items = await actionQueue.listActionQueueItems()
    const item = items.find((i) => i.kind === sweep.DAEMON_KILLED_ACTION_QUEUE_KIND)
    expect(item).toBeDefined()
    expect(item!.payload['branch']).toBeNull()
    expect(item!.payload['errorKind']).toBe('daemon-killed')
    expect(item!.payload['prompt']).toBe('killed work')
  })

  it('payload records the branch string for a task killed after the branch was created', async () => {
    const { q, actionQueue, sweep } = await loadModules(repo)

    const task = await q.enqueueTask('mid-run work', undefined, { skipTriage: true })
    await q.updateTask(task.id, {
      status: 'failed',
      error: 'killed by `mars daemon kill`',
      failureSignature: 'daemon-killed',
      branch: 'task/mars-abc123',
    })

    await sweep.detectAndRaiseDaemonKilled()

    const items = await actionQueue.listActionQueueItems()
    const item = items.find((i) => i.kind === sweep.DAEMON_KILLED_ACTION_QUEUE_KIND)
    expect(item).toBeDefined()
    expect(item!.payload['branch']).toBe('task/mars-abc123')
  })

  it('raises a separate alert for each daemon-killed task', async () => {
    const { q, actionQueue, sweep } = await loadModules(repo)

    const taskA = await q.enqueueTask('work-a', undefined, { skipTriage: true })
    const taskB = await q.enqueueTask('work-b', undefined, { skipTriage: true })
    await q.updateTask(taskA.id, { status: 'failed', failureSignature: 'daemon-killed' })
    await q.updateTask(taskB.id, { status: 'failed', failureSignature: 'daemon-killed' })

    const raised = await sweep.detectAndRaiseDaemonKilled()
    expect(raised).toHaveLength(2)

    const items = await actionQueue.listActionQueueItems()
    const ours = items.filter((i) => i.kind === sweep.DAEMON_KILLED_ACTION_QUEUE_KIND)
    expect(ours).toHaveLength(2)

    const titles = ours.map((i) => i.title)
    expect(titles.some((t) => t.includes(taskA.id))).toBe(true)
    expect(titles.some((t) => t.includes(taskB.id))).toBe(true)
  })

  it('alert context contains the taskId for routing', async () => {
    const { q, actionQueue, sweep } = await loadModules(repo)

    const task = await q.enqueueTask('killed work', undefined, { skipTriage: true })
    await q.updateTask(task.id, {
      status: 'failed',
      failureSignature: 'daemon-killed',
    })

    await sweep.detectAndRaiseDaemonKilled()

    const items = await actionQueue.listActionQueueItems()
    const item = items.find((i) => i.kind === sweep.DAEMON_KILLED_ACTION_QUEUE_KIND)
    expect(item).toBeDefined()
    expect(item!.context['taskId']).toBe(task.id)
  })
})
