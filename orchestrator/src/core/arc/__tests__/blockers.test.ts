/**
 * Tests for `arc/blockers.ts` — the extracted blocker-edge concern.
 *
 * Exercises the exported functions directly via their `ArcStorePort` parameter,
 * using the queue module for task creation and schema bootstrap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

import type { ArcStorePort } from '../../store/arc-store-port'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface BlockersModule {
  addBlockerEdges: typeof import('../blockers').addBlockerEdges
  addPendingReviewBlockerEdges: typeof import('../blockers').addPendingReviewBlockerEdges
  removeBlockerEdge: typeof import('../blockers').removeBlockerEdge
  clearBlockerEdges: typeof import('../blockers').clearBlockerEdges
  failAndClearBlockerEdges: typeof import('../blockers').failAndClearBlockerEdges
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-arc-blockers-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; b: BlockersModule; store: ArcStorePort }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const b = (await import('../blockers')) as unknown as BlockersModule
  const storeModule = await import('../../store/arc-store-port')
  const store = await storeModule.getDefaultArcStore()
  return { q, b, store }
}

/** Count edges where `taskId` is the dependent. */
const countEdges = async (q: QueueModule, taskId: string): Promise<number> => {
  const r = await q.resolveQueueClient().execute({
    sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ?`,
    args: [taskId],
  })
  return Number((r.rows[0] as unknown as { n: number | bigint }).n)
}

/** Read task status. */
const getStatus = async (q: QueueModule, taskId: string): Promise<string> => {
  const r = await q.resolveQueueClient().execute({
    sql: `SELECT status FROM tasks WHERE id = ?`,
    args: [taskId],
  })
  return (r.rows[0] as unknown as { status: string }).status
}

describe('arc/blockers — addBlockerEdges', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('inserts confirmed edges for valid task ids', async () => {
    const { q, b, store } = await loadModules(repo)
    const parent = await q.enqueueTask('parent', undefined, { skipTriage: true })
    const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })

    await b.addBlockerEdges(store, parent.id, [blocker.id])
    expect(await countEdges(q, parent.id)).toBe(1)
  })

  it('deduplicates repeated blocker ids', async () => {
    const { q, b, store } = await loadModules(repo)
    const parent = await q.enqueueTask('parent', undefined, { skipTriage: true })
    const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })

    await b.addBlockerEdges(store, parent.id, [blocker.id, blocker.id, blocker.id])
    expect(await countEdges(q, parent.id)).toBe(1)
  })

  it('silently drops self-blocking edges', async () => {
    const { q, b, store } = await loadModules(repo)
    const task = await q.enqueueTask('solo', undefined, { skipTriage: true })

    await b.addBlockerEdges(store, task.id, [task.id])
    expect(await countEdges(q, task.id)).toBe(0)
  })

  it('throws when the dependent task does not exist', async () => {
    const { q, b, store } = await loadModules(repo)
    const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })

    await expect(
      b.addBlockerEdges(store, 'nonexistent', [blocker.id]),
    ).rejects.toThrow('task nonexistent not found')
  })

  it('throws when a blocker task does not exist', async () => {
    const { q, b, store } = await loadModules(repo)
    const parent = await q.enqueueTask('parent', undefined, { skipTriage: true })

    await expect(
      b.addBlockerEdges(store, parent.id, ['ghost']),
    ).rejects.toThrow('blocker ghost not found')
  })

  it('is idempotent (ON CONFLICT DO NOTHING)', async () => {
    const { q, b, store } = await loadModules(repo)
    const parent = await q.enqueueTask('parent', undefined, { skipTriage: true })
    const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })

    await b.addBlockerEdges(store, parent.id, [blocker.id])
    await b.addBlockerEdges(store, parent.id, [blocker.id])
    expect(await countEdges(q, parent.id)).toBe(1)
  })

  it('no-ops on an empty blocker list', async () => {
    const { q, b, store } = await loadModules(repo)
    const task = await q.enqueueTask('lonely', undefined, { skipTriage: true })

    await b.addBlockerEdges(store, task.id, [])
    expect(await countEdges(q, task.id)).toBe(0)
  })
})

describe('arc/blockers — removeBlockerEdge', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('removes an existing edge and reports removed: true', async () => {
    const { q, b, store } = await loadModules(repo)
    const parent = await q.enqueueTask('parent', undefined, { skipTriage: true })
    const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })

    await b.addBlockerEdges(store, parent.id, [blocker.id])
    const result = await b.removeBlockerEdge(store, parent.id, blocker.id)
    expect(result.removed).toBe(true)
    expect(await countEdges(q, parent.id)).toBe(0)
  })

  it('reports removed: false when no such edge exists', async () => {
    const { q, b, store } = await loadModules(repo)
    const parent = await q.enqueueTask('parent', undefined, { skipTriage: true })
    const other = await q.enqueueTask('other', undefined, { skipTriage: true })

    const result = await b.removeBlockerEdge(store, parent.id, other.id)
    expect(result.removed).toBe(false)
  })
})

describe('arc/blockers — clearBlockerEdges', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('removes all outbound edges for a task', async () => {
    const { q, b, store } = await loadModules(repo)
    const parent = await q.enqueueTask('parent', undefined, { skipTriage: true })
    const b1 = await q.enqueueTask('b1', undefined, { skipTriage: true })
    const b2 = await q.enqueueTask('b2', undefined, { skipTriage: true })

    await b.addBlockerEdges(store, parent.id, [b1.id, b2.id])
    expect(await countEdges(q, parent.id)).toBe(2)

    await b.clearBlockerEdges(store, parent.id)
    expect(await countEdges(q, parent.id)).toBe(0)
  })
})

describe('arc/blockers — failAndClearBlockerEdges', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('fails a blocked task, clears its edges, and returns outcome unblocked', async () => {
    const { q, b, store } = await loadModules(repo)
    const parent = await q.enqueueTask('parent', undefined, { skipTriage: true })
    const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })

    // Manually set status to blocked + add an edge
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [parent.id],
    })
    await b.addBlockerEdges(store, parent.id, [blocker.id])

    const result = await b.failAndClearBlockerEdges(parent.id)
    expect(result.outcome).toBe('unblocked')
    expect(result.previousStatus).toBe('blocked')
    expect(await getStatus(q, parent.id)).toBe('failed')
    expect(await countEdges(q, parent.id)).toBe(0)
  })

  it('returns noop for a task not in blocked or queued status', async () => {
    const { q, b } = await loadModules(repo)
    const task = await q.enqueueTask('task', undefined, { skipTriage: true })

    // Put the task into 'running' status
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running' WHERE id = ?`,
      args: [task.id],
    })

    const result = await b.failAndClearBlockerEdges(task.id)
    expect(result.outcome).toBe('noop')
    expect(result.previousStatus).toBe('running')
  })

  it('throws for a nonexistent task', async () => {
    await loadModules(repo)

    await expect(
      (await import('../blockers')).failAndClearBlockerEdges('nonexistent'),
    ).rejects.toThrow('task nonexistent not found')
  })
})
