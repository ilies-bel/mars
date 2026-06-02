import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface Queue {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
  listTasks: typeof import('../../queue').listTasks
  addBlockers: typeof import('../../queue').addBlockers
  clearBlockers: typeof import('../../queue').clearBlockers
  listBlockers: typeof import('../../queue').listBlockers
  removeBlocker: typeof import('../../queue').removeBlocker
  hasIncompleteBlockers: typeof import('../../queue').hasIncompleteBlockers
  promoteDraftToQueued: typeof import('../../queue').promoteDraftToQueued
  initQueue: typeof import('../../queue').initQueue
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-test-'))
  // queue.ts requires a git repo for context resolution
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

describe('queue blockers + draft promotion', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('enqueueTask defaults to draft status', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('do thing')
    expect(t.status).toBe('draft')
  })

  it('enqueueTask with skipTriage=true lands in queued', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    expect(t.status).toBe('queued')
  })

  it('addBlockers is idempotent and ignores self-blocks', async () => {
    const q = await loadQueue(repo)
    const a = await q.enqueueTask('a')
    const b = await q.enqueueTask('b')
    await q.addBlockers(a.id, [b.id, b.id, a.id])
    const blockers = await q.listBlockers(a.id)
    expect(blockers).toEqual([b.id])
  })

  it('listBlockers excludes done blockers', async () => {
    const q = await loadQueue(repo)
    const a = await q.enqueueTask('a')
    const b = await q.enqueueTask('b')
    const c = await q.enqueueTask('c')
    await q.addBlockers(a.id, [b.id, c.id])
    expect(await q.listBlockers(a.id)).toHaveLength(2)
    await q.updateTask(b.id, { status: 'done' })
    const remaining = await q.listBlockers(a.id)
    expect(remaining).toEqual([c.id])
  })

  it('promoteDraftToQueued is no-op while blockers remain', async () => {
    const q = await loadQueue(repo)
    const a = await q.enqueueTask('a')
    const b = await q.enqueueTask('b')
    await q.addBlockers(a.id, [b.id])
    const promoted = await q.promoteDraftToQueued(a.id)
    expect(promoted).toBeNull()
    const reloaded = await q.getTask(a.id)
    expect(reloaded?.status).toBe('draft')
  })

  it('promoteDraftToQueued succeeds when no blockers', async () => {
    const q = await loadQueue(repo)
    const a = await q.enqueueTask('a')
    const promoted = await q.promoteDraftToQueued(a.id)
    expect(promoted?.status).toBe('queued')
  })

  it('promoteDraftToQueued is no-op when status is not draft', async () => {
    const q = await loadQueue(repo)
    const a = await q.enqueueTask('a', undefined, { skipTriage: true })
    const promoted = await q.promoteDraftToQueued(a.id)
    expect(promoted).toBeNull()
  })

  it('marking a blocker done auto-promotes the dependent draft', async () => {
    const q = await loadQueue(repo)
    const a = await q.enqueueTask('a')
    const b = await q.enqueueTask('b')
    await q.addBlockers(a.id, [b.id])
    expect((await q.getTask(a.id))?.status).toBe('draft')
    await q.updateTask(b.id, { status: 'done' })
    expect((await q.getTask(a.id))?.status).toBe('queued')
  })

  it('hasIncompleteBlockers returns true for a task with a not-done blocker', async () => {
    const q = await loadQueue(repo)
    const a = await q.enqueueTask('a')
    const b = await q.enqueueTask('b')
    await q.addBlockers(a.id, [b.id])
    expect(await q.hasIncompleteBlockers(a.id)).toBe(true)
  })

  it('hasIncompleteBlockers returns false for a task with all blockers done', async () => {
    const q = await loadQueue(repo)
    const a = await q.enqueueTask('a')
    const b = await q.enqueueTask('b')
    const c = await q.enqueueTask('c')
    await q.addBlockers(a.id, [b.id, c.id])
    await q.updateTask(b.id, { status: 'done' })
    await q.updateTask(c.id, { status: 'done' })
    expect(await q.hasIncompleteBlockers(a.id)).toBe(false)
  })

  it('hasIncompleteBlockers returns false for a task with no blockers', async () => {
    const q = await loadQueue(repo)
    const a = await q.enqueueTask('a')
    expect(await q.hasIncompleteBlockers(a.id)).toBe(false)
  })

  it('clearBlockers removes all blocker rows for a task', async () => {
    const q = await loadQueue(repo)
    const a = await q.enqueueTask('a')
    const b = await q.enqueueTask('b')
    const c = await q.enqueueTask('c')
    await q.addBlockers(a.id, [b.id, c.id])
    await q.clearBlockers(a.id)
    expect(await q.listBlockers(a.id)).toEqual([])
  })

  it('addBlockers inserts multiple edges and is idempotent on duplicate (task, blocker) pairs', async () => {
    const q = await loadQueue(repo)
    const a = await q.enqueueTask('a')
    const b = await q.enqueueTask('b')
    const c = await q.enqueueTask('c')
    await q.addBlockers(a.id, [b.id, c.id])
    expect((await q.listBlockers(a.id)).sort()).toEqual([b.id, c.id].sort())
    // Re-inserting the same pairs should not duplicate or error.
    await q.addBlockers(a.id, [b.id, c.id])
    expect((await q.listBlockers(a.id)).sort()).toEqual([b.id, c.id].sort())
  })

  it('addBlockers rejects when any blocker id does not reference a real task', async () => {
    const q = await loadQueue(repo)
    const a = await q.enqueueTask('a')
    const b = await q.enqueueTask('b')
    await expect(
      q.addBlockers(a.id, [b.id, 'nonexistent-id']),
    ).rejects.toThrow(/blocker nonexistent-id not found/)
    // Nothing inserted on failure (validation runs before the batch).
    expect(await q.listBlockers(a.id)).toEqual([])
  })

  it('addBlockers rejects when the task id does not exist', async () => {
    const q = await loadQueue(repo)
    const b = await q.enqueueTask('b')
    await expect(
      q.addBlockers('nonexistent-task', [b.id]),
    ).rejects.toThrow(/task nonexistent-task not found/)
  })

  it('removeBlocker removes a single edge and reports removed:false on a non-existent pair', async () => {
    const q = await loadQueue(repo)
    const a = await q.enqueueTask('a')
    const b = await q.enqueueTask('b')
    const c = await q.enqueueTask('c')
    await q.addBlockers(a.id, [b.id, c.id])

    const r1 = await q.removeBlocker(a.id, b.id)
    expect(r1.removed).toBe(true)
    expect(await q.listBlockers(a.id)).toEqual([c.id])

    // Removing the same pair again is a no-op and reports removed:false.
    const r2 = await q.removeBlocker(a.id, b.id)
    expect(r2.removed).toBe(false)

    // Non-existent pair (different blocker id) also reports removed:false.
    const r3 = await q.removeBlocker(a.id, 'never-existed')
    expect(r3.removed).toBe(false)
  })
})
