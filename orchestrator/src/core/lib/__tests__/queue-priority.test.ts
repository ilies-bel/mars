import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface Queue {
  enqueueTask: typeof import('../../queue').enqueueTask
  listTasks: typeof import('../../queue').listTasks
  getTask: typeof import('../../queue').getTask
  setTaskPriority: typeof import('../../queue').setTaskPriority
  updateTask: typeof import('../../queue').updateTask
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadQueue = async (repo: string): Promise<Queue> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = await import('../../queue')
  await mod.migrateQueueSchema()
  return mod as unknown as Queue
}

describe('task priority', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('enqueueTask with priority=2 stores priority=2', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('high', undefined, {
      skipTriage: true,
      priority: 2,
    })
    expect(t.priority).toBe(2)
    const fetched = await q.getTask(t.id)
    expect(fetched?.priority).toBe(2)
  })

  it('enqueueTask defaults priority to 0 when not provided', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('normal', undefined, { skipTriage: true })
    expect(t.priority).toBe(0)
  })

  it('listTasks returns mixed-priority queue ordered priority DESC, createdAt ASC', async () => {
    const q = await loadQueue(repo)
    // Insert in temporal order: P0 (oldest), P2 (newer), P1 (newest).
    const p0 = await q.enqueueTask('p0-old', undefined, {
      skipTriage: true,
      priority: 0,
    })
    await new Promise((r) => setTimeout(r, 10))
    const p2 = await q.enqueueTask('p2-mid', undefined, {
      skipTriage: true,
      priority: 2,
    })
    await new Promise((r) => setTimeout(r, 10))
    const p1 = await q.enqueueTask('p1-new', undefined, {
      skipTriage: true,
      priority: 1,
    })

    const queued = await q.listTasks('queued')
    expect(queued.map((t) => t.id)).toEqual([p2.id, p1.id, p0.id])
  })

  it('enqueueTask rejects priority outside 0..3', async () => {
    const q = await loadQueue(repo)
    await expect(
      q.enqueueTask('bad-low', undefined, { skipTriage: true, priority: -1 }),
    ).rejects.toThrow(/priority/)
    await expect(
      q.enqueueTask('bad-high', undefined, { skipTriage: true, priority: 4 }),
    ).rejects.toThrow(/priority/)
  })

  it('setTaskPriority on a queued task updates the value', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('queued one', undefined, { skipTriage: true })
    expect(t.priority).toBe(0)
    const updated = await q.setTaskPriority(t.id, 3)
    expect(updated.priority).toBe(3)
    const fetched = await q.getTask(t.id)
    expect(fetched?.priority).toBe(3)
  })

  it('setTaskPriority on a draft task persists the value', async () => {
    const q = await loadQueue(repo)
    // skipTriage: false → status starts as 'draft'
    const t = await q.enqueueTask('draft task', undefined, {
      skipTriage: false,
    })
    expect(t.status).toBe('draft')
    const updated = await q.setTaskPriority(t.id, 2)
    expect(updated.priority).toBe(2)
    const fetched = await q.getTask(t.id)
    expect(fetched?.priority).toBe(2)
  })

  it('setTaskPriority on a blocked task persists and survives transition to queued', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('will-block', undefined, { skipTriage: true })
    await q.updateTask(t.id, { status: 'blocked' })
    // Priority set while blocked
    const updated = await q.setTaskPriority(t.id, 3)
    expect(updated.priority).toBe(3)
    // Simulate blocker resolution: task transitions back to queued
    await q.updateTask(t.id, { status: 'queued' })
    const fetched = await q.getTask(t.id)
    expect(fetched?.status).toBe('queued')
    expect(fetched?.priority).toBe(3)
  })

  it('setTaskPriority rejects terminal states with a state-specific message', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('will-done', undefined, { skipTriage: true })
    await q.updateTask(t.id, { status: 'done' })
    await expect(q.setTaskPriority(t.id, 2)).rejects.toThrow(
      /is done; priority has no effect on terminal tasks/,
    )

    const t2 = await q.enqueueTask('will-fail', undefined, { skipTriage: true })
    await q.updateTask(t2.id, { status: 'failed' })
    await expect(q.setTaskPriority(t2.id, 2)).rejects.toThrow(
      /is failed; priority has no effect on terminal tasks/,
    )

    const t3 = await q.enqueueTask('will-drop', undefined, { skipTriage: true })
    await q.updateTask(t3.id, { status: 'dropped' })
    await expect(q.setTaskPriority(t3.id, 2)).rejects.toThrow(
      /is dropped; priority has no effect on terminal tasks/,
    )
  })

  it('setTaskPriority rejects in-flight states with a state-specific message', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('will-run', undefined, { skipTriage: true })
    await q.updateTask(t.id, { status: 'running' })
    await expect(q.setTaskPriority(t.id, 2)).rejects.toThrow(
      /is running; priority cannot be changed while the task is in-flight/,
    )

    const t2 = await q.enqueueTask('will-verify', undefined, { skipTriage: true })
    await q.updateTask(t2.id, { status: 'verifying' })
    await expect(q.setTaskPriority(t2.id, 2)).rejects.toThrow(
      /is verifying; priority cannot be changed while the task is in-flight/,
    )

    const t3 = await q.enqueueTask('will-merge', undefined, { skipTriage: true })
    await q.updateTask(t3.id, { status: 'merging' })
    await expect(q.setTaskPriority(t3.id, 2)).rejects.toThrow(
      /is merging; priority cannot be changed while the task is in-flight/,
    )
  })

  it('setTaskPriority rejects out-of-range values', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('queued one', undefined, { skipTriage: true })
    await expect(q.setTaskPriority(t.id, -1)).rejects.toThrow(/priority/)
    await expect(q.setTaskPriority(t.id, 4)).rejects.toThrow(/priority/)
  })
})
