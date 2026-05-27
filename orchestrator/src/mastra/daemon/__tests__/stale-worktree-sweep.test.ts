import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getClient: typeof import('../../queue').getClient
  initQueue: typeof import('../../queue').initQueue
  updateTask: typeof import('../../queue').updateTask
}

interface InboxModule {
  listInboxItems: typeof import('../../lib/inbox').listInboxItems
  getInboxItem: typeof import('../../lib/inbox').getInboxItem
}

interface SweepModule {
  detectAndRaiseStaleWorktrees: typeof import('../stale-worktree-sweep').detectAndRaiseStaleWorktrees
  buildNextActionBody: typeof import('../stale-worktree-sweep').buildNextActionBody
  STALE_WORKTREE_KIND: typeof import('../stale-worktree-sweep').STALE_WORKTREE_KIND
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-stale-sweep-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/** Two days ago — always older than the 24h default threshold. */
const OLD_UPDATED_AT = new Date(Date.now() - 2 * 24 * 3_600_000).toISOString()

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; inbox: InboxModule; sweep: SweepModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  process.env.MARS_STALE_WORKTREE_HOURS = '24'
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const inbox = (await import('../../lib/inbox')) as unknown as InboxModule
  const sweep = (await import('../stale-worktree-sweep')) as unknown as SweepModule
  return { q, inbox, sweep }
}

describe('detectAndRaiseStaleWorktrees', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_STALE_WORKTREE_HOURS
    rmSync(repo, { recursive: true, force: true })
  })

  it('raises exactly one stale-worktree inbox item keyed by origin task id', async () => {
    const { q, inbox, sweep } = await loadModules(repo)
    const task = await q.enqueueTask('some stale work', undefined, { skipTriage: true })

    // Age the task beyond the threshold
    await q.getClient().execute({
      sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT, task.id],
    })

    // Create the worktree directory
    mkdirSync(resolve(repo, '.mars', 'worktrees', task.id), { recursive: true })

    const raised = await sweep.detectAndRaiseStaleWorktrees(repo)

    expect(raised).toHaveLength(1)
    const items = await inbox.listInboxItems('open')
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe(sweep.STALE_WORKTREE_KIND)
    expect(items[0].context).toEqual(expect.objectContaining({ taskId: task.id }))
  })

  it('re-detecting the same stale worktree updates the existing item, not a sibling', async () => {
    const { q, inbox, sweep } = await loadModules(repo)
    const task = await q.enqueueTask('some stale work', undefined, { skipTriage: true })

    await q.getClient().execute({
      sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT, task.id],
    })

    mkdirSync(resolve(repo, '.mars', 'worktrees', task.id), { recursive: true })

    const firstRun = await sweep.detectAndRaiseStaleWorktrees(repo)
    const secondRun = await sweep.detectAndRaiseStaleWorktrees(repo)

    // Same item id returned on every detection
    expect(firstRun).toHaveLength(1)
    expect(secondRun[0]).toBe(firstRun[0])

    // Still only one open item — no sibling was created
    const items = await inbox.listInboxItems('open')
    expect(items).toHaveLength(1)

    // seen_count was bumped on the second detection
    const item = await inbox.getInboxItem(firstRun[0])
    expect(item!.seenCount).toBe(2)
  })

  it('the inbox item body describes the stale-worktree state (recovery verbs are buttons, not body text)', async () => {
    const { q, inbox, sweep } = await loadModules(repo)
    const task = await q.enqueueTask('work', undefined, { skipTriage: true })

    await q.getClient().execute({
      sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT, task.id],
    })
    mkdirSync(resolve(repo, '.mars', 'worktrees', task.id), { recursive: true })

    await sweep.detectAndRaiseStaleWorktrees(repo)

    const items = await inbox.listInboxItems('open')
    expect(items[0].body).toContain(`Task ${task.id} has a stale worktree`)
    // The button-duplicating command footer is gone.
    expect(items[0].body).not.toContain(`mars restart ${task.id}`)
    expect(items[0].body).not.toContain(`mars drop ${task.id}`)
  })

  it('does not raise an item for tasks in terminal states (done, failed, dropped)', async () => {
    const { q, inbox, sweep } = await loadModules(repo)

    const taskDone = await q.enqueueTask('done task', undefined, { skipTriage: true })
    const taskFailed = await q.enqueueTask('failed task', undefined, { skipTriage: true })
    const taskDropped = await q.enqueueTask('dropped task', undefined, { skipTriage: true })

    for (const [id, st] of [
      [taskDone.id, 'done'],
      [taskFailed.id, 'failed'],
      [taskDropped.id, 'dropped'],
    ] as const) {
      await q.getClient().execute({
        sql: `UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`,
        args: [st, OLD_UPDATED_AT, id],
      })
      mkdirSync(resolve(repo, '.mars', 'worktrees', id), { recursive: true })
    }

    const raised = await sweep.detectAndRaiseStaleWorktrees(repo)
    expect(raised).toHaveLength(0)

    const items = await inbox.listInboxItems('open')
    expect(items).toHaveLength(0)
  })

  it('does not raise an item when no worktree directory exists on disk', async () => {
    const { q, inbox, sweep } = await loadModules(repo)
    const task = await q.enqueueTask('no worktree', undefined, { skipTriage: true })

    await q.getClient().execute({
      sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT, task.id],
    })
    // Intentionally omit creating the worktree directory

    const raised = await sweep.detectAndRaiseStaleWorktrees(repo)
    expect(raised).toHaveLength(0)

    const items = await inbox.listInboxItems('open')
    expect(items).toHaveLength(0)
  })

  it('does not raise an item for a task updated within the threshold', async () => {
    const { q, inbox, sweep } = await loadModules(repo)
    const task = await q.enqueueTask('fresh task', undefined, { skipTriage: true })

    // updatedAt stays at creation time (very recent — well within 24h threshold)
    mkdirSync(resolve(repo, '.mars', 'worktrees', task.id), { recursive: true })

    const raised = await sweep.detectAndRaiseStaleWorktrees(repo)
    expect(raised).toHaveLength(0)

    const items = await inbox.listInboxItems('open')
    expect(items).toHaveLength(0)
  })

  it('closes the inbox item automatically when the origin task status changes', async () => {
    const { q, inbox, sweep } = await loadModules(repo)
    const task = await q.enqueueTask('task to complete', undefined, { skipTriage: true })

    await q.getClient().execute({
      sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT, task.id],
    })
    mkdirSync(resolve(repo, '.mars', 'worktrees', task.id), { recursive: true })

    // Sweep raises the inbox item
    await sweep.detectAndRaiseStaleWorktrees(repo)

    const openBefore = await inbox.listInboxItems('open')
    expect(openBefore).toHaveLength(1)
    const itemId = openBefore[0].id

    // Task status changes (e.g. daemon requeues it) — triggers dismissAlertsOnStatusChange
    await q.updateTask(task.id, { status: 'done' })

    // Item should now be resolved, not open
    const openAfter = await inbox.listInboxItems('open')
    expect(openAfter).toHaveLength(0)

    const item = await inbox.getInboxItem(itemId)
    expect(item!.state).toBe('resolved')
  })

  it('raises distinct items for two different stale worktrees', async () => {
    const { q, inbox, sweep } = await loadModules(repo)
    const task1 = await q.enqueueTask('stale work 1', undefined, { skipTriage: true })
    const task2 = await q.enqueueTask('stale work 2', undefined, { skipTriage: true })

    for (const id of [task1.id, task2.id]) {
      await q.getClient().execute({
        sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
        args: [OLD_UPDATED_AT, id],
      })
      mkdirSync(resolve(repo, '.mars', 'worktrees', id), { recursive: true })
    }

    const raised = await sweep.detectAndRaiseStaleWorktrees(repo)

    expect(raised).toHaveLength(2)
    expect(raised[0]).not.toBe(raised[1])

    const items = await inbox.listInboxItems('open')
    expect(items).toHaveLength(2)
  })
})
