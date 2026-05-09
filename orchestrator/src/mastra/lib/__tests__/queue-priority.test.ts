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
  initQueue: typeof import('../../queue').initQueue
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
  await mod.initQueue()
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

  it('setTaskPriority rejects when task is not queued', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('pending', undefined, { skipTriage: true })
    // Push it out of queued.
    await q.updateTask(t.id, { status: 'running' })
    await expect(q.setTaskPriority(t.id, 2)).rejects.toThrow(
      /only queued tasks can be reprioritized/,
    )
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

  it('setTaskPriority rejects out-of-range values', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('queued one', undefined, { skipTriage: true })
    await expect(q.setTaskPriority(t.id, -1)).rejects.toThrow(/priority/)
    await expect(q.setTaskPriority(t.id, 4)).rejects.toThrow(/priority/)
  })
})
