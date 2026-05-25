import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  addBlockers: typeof import('../../queue').addBlockers
}

interface DerivedModule {
  listDerivedInbox: typeof import('../derived-inbox').listDerivedInbox
  getDerivedInboxRow: typeof import('../derived-inbox').getDerivedInboxRow
}

interface DismissalsModule {
  dismissEntity: typeof import('../inbox-dismissals').dismissEntity
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-derived-inbox-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{
  queue: QueueModule
  derived: DerivedModule
  dismissals: DismissalsModule
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = (await import('../../queue')) as unknown as QueueModule
  const derived = (await import('../derived-inbox')) as unknown as DerivedModule
  const dismissals = (await import(
    '../inbox-dismissals'
  )) as unknown as DismissalsModule
  return { queue, derived, dismissals }
}

describe('derived-inbox', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('is empty when nothing is stuck', async () => {
    const { queue, derived } = await loadModules(repo)
    await queue.enqueueTask('a queued task', undefined, { skipTriage: true })
    const rows = await derived.listDerivedInbox()
    expect(rows).toEqual([])
  })

  it('surfaces a failed task as one high-priority row with a stable id', async () => {
    const { queue, derived } = await loadModules(repo)
    const t = await queue.enqueueTask('do the thing', undefined, {
      skipTriage: true,
    })
    await queue.updateTask(t.id, { status: 'failed' })
    const rows = await derived.listDerivedInbox()
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('failed-task')
    expect(rows[0].priority).toBe('high')
    expect(rows[0].id).toBe(`failed-task:${t.id}`)
    expect(rows[0].entityId).toBe(t.id)
  })

  it('surfaces a blocked task with its blocker DAG', async () => {
    const { queue, derived } = await loadModules(repo)
    const blocker = await queue.enqueueTask('blocker', undefined, {
      skipTriage: true,
    })
    const blocked = await queue.enqueueTask('blocked', undefined, {
      skipTriage: true,
    })
    await queue.addBlockers(blocked.id, [blocker.id])
    await queue.updateTask(blocked.id, { status: 'blocked' })

    const rows = await derived.listDerivedInbox()
    const row = rows.find((r) => r.entityId === blocked.id)
    expect(row?.kind).toBe('blocked-task')
    expect(row?.dag?.blockers.map((b) => b.id)).toContain(blocker.id)
    // The blocker task itself, being `queued`, is not in the inbox.
    expect(rows.find((r) => r.entityId === blocker.id)).toBeUndefined()
  })

  it('flags a worktree on disk whose task is terminal, not one whose task is live', async () => {
    const { queue, derived } = await loadModules(repo)
    const done = await queue.enqueueTask('done task', undefined, {
      skipTriage: true,
    })
    await queue.updateTask(done.id, { status: 'done' })
    const live = await queue.enqueueTask('live task', undefined, {
      skipTriage: true,
    })
    void live
    mkdirSync(resolve(repo, '.mars/worktrees', done.id), { recursive: true })
    mkdirSync(resolve(repo, '.mars/worktrees', live.id), { recursive: true })

    const rows = await derived.listDerivedInbox()
    expect(rows.find((r) => r.id === `stale-worktree:${done.id}`)).toBeDefined()
    expect(
      rows.find((r) => r.id === `stale-worktree:${live.id}`),
    ).toBeUndefined()
  })

  it('hides a dismissed row under the default filter and resurfaces it on status change', async () => {
    const { queue, derived, dismissals } = await loadModules(repo)
    const t = await queue.enqueueTask('flaky task', undefined, {
      skipTriage: true,
    })
    await queue.updateTask(t.id, { status: 'failed' })

    await dismissals.dismissEntity('task', t.id)
    expect(
      (await derived.listDerivedInbox()).find((r) => r.entityId === t.id),
    ).toBeUndefined()
    expect(
      (await derived.listDerivedInbox({ filter: 'all' })).find(
        (r) => r.entityId === t.id && r.dismissed,
      ),
    ).toBeDefined()

    // A status change clears the dismissal (updateTask hook), so a later
    // failure resurfaces the row.
    await queue.updateTask(t.id, { status: 'queued' })
    await queue.updateTask(t.id, { status: 'failed' })
    expect(
      (await derived.listDerivedInbox()).find((r) => r.entityId === t.id),
    ).toBeDefined()
  })

  it('resolves a row by bare entity id via getDerivedInboxRow', async () => {
    const { queue, derived } = await loadModules(repo)
    const t = await queue.enqueueTask('lookup me', undefined, {
      skipTriage: true,
    })
    await queue.updateTask(t.id, { status: 'failed' })
    const row = await derived.getDerivedInboxRow(t.id)
    expect(row?.entityId).toBe(t.id)
    expect(row?.kind).toBe('failed-task')
  })
})
