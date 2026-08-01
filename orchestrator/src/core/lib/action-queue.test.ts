import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RECOVERY_FAILED_ACTION_QUEUE_KIND,
  UNKNOWN_FAILURE_ACTION_QUEUE_KIND,
  FIX_FAIL_LOOP_ACTION_QUEUE_KIND,
} from '../queue-fix-tasks'
import { TASK_BLOCKED_ACTION_QUEUE_KIND } from '../queue-retry'
import { DAEMON_KILLED_ACTION_QUEUE_KIND } from '../daemon/daemon-killed-sweep'
import { STALE_WORKTREE_KIND } from '../daemon/stale-worktree-sweep'
import {
  WORKTREE_AHEAD_ACTION_QUEUE_KIND,
  PREREQUISITE_FAILED_ACTION_QUEUE_KIND,
  CANCELLED_CASCADE_ACTION_QUEUE_KIND,
} from '../blocker-resolution'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface ActionQueueModule {
  raiseActionQueueItem: typeof import('./action-queue').raiseActionQueueItem
  listActionQueueItems: typeof import('./action-queue').listActionQueueItems
  listVisibleActionQueueItems: typeof import('./action-queue').listVisibleActionQueueItems
  getActionQueueItem: typeof import('./action-queue').getActionQueueItem
  setActionQueueState: typeof import('./action-queue').setActionQueueState
  setRecoveryFindings: typeof import('./action-queue').setRecoveryFindings
  supersedeActionQueueItemsForOrigin: typeof import('./action-queue').supersedeActionQueueItemsForOrigin
  reconcileStaleActionQueueItems: typeof import('./action-queue').reconcileStaleActionQueueItems
  supersedeObsoletePreflightDirtyMainRows: typeof import('./action-queue').supersedeObsoletePreflightDirtyMainRows
  supersedeOrphanedHitlActionQueueRows: typeof import('./action-queue').supersedeOrphanedHitlActionQueueRows
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-actionQueue-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModule = async (repo: string): Promise<ActionQueueModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  return (await import('./action-queue')) as unknown as ActionQueueModule
}

const baseItem = (overrides: Partial<Parameters<ActionQueueModule['raiseActionQueueItem']>[0]> = {}) => ({
  kind: 'failed' as const,
  category: 'orchestrator' as const,
  priority: 'normal' as const,
  title: 'Worktree cleanup failed',
  body: 'Could not remove worktree',
  payload: {},
  context: { task_id: 'abc123' },
  raisedBy: 'orchestrator:merge-step',
  signature: 'sig-1',
  ...overrides,
})

describe('action-queue', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('lists only action items that are currently visible to an operator', async () => {
    const actionQueue = await loadModule(repo)
    const visibleId = await actionQueue.raiseActionQueueItem(baseItem({ signature: 'visible' }))
    const resolvedId = await actionQueue.raiseActionQueueItem(baseItem({ signature: 'resolved' }))
    await actionQueue.setActionQueueState(resolvedId, 'resolved')

    const visible = await actionQueue.listVisibleActionQueueItems()

    expect(visible.map((item) => item.id)).toEqual([visibleId])
    expect(visible[0]?.history).toEqual([])
  })

  it('inserts a new item with seen_count=1, state=open, fingerprint=sha1(kind:signature)', async () => {
    const actionQueue = await loadModule(repo)
    const id = await actionQueue.raiseActionQueueItem(
      baseItem({ occurrence: { task_id: 'abc123', stderr_tail: 'EPERM' } }),
    )
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)

    const item = await actionQueue.getActionQueueItem(id)
    expect(item).not.toBeNull()
    expect(item!.id).toBe(id)
    expect(item!.kind).toBe('failed')
    expect(item!.state).toBe('open')
    expect(item!.seenCount).toBe(1)
    expect(item!.raisedBy).toBe('orchestrator:merge-step')
    expect(item!.context).toEqual({ task_id: 'abc123' })
    expect(item!.payload.occurrences).toEqual([
      { task_id: 'abc123', stderr_tail: 'EPERM' },
    ])
    expect(item!.fingerprint).toMatch(/^[a-f0-9]{40}$/)
    expect(item!.raisedAt).toBe(item!.lastSeenAt)
    expect(item!.resolvedAt).toBeNull()
  })

  it('dedups by fingerprint: bumps seen_count and appends occurrences', async () => {
    const actionQueue = await loadModule(repo)
    const first = await actionQueue.raiseActionQueueItem(
      baseItem({ occurrence: { task_id: 't1' } }),
    )
    const second = await actionQueue.raiseActionQueueItem(
      baseItem({ occurrence: { task_id: 't2' } }),
    )
    const third = await actionQueue.raiseActionQueueItem(
      baseItem({ occurrence: { task_id: 't3' } }),
    )
    expect(second).toBe(first)
    expect(third).toBe(first)

    const item = await actionQueue.getActionQueueItem(first)
    expect(item!.seenCount).toBe(3)
    expect(item!.payload.occurrences).toEqual([
      { task_id: 't1' },
      { task_id: 't2' },
      { task_id: 't3' },
    ])
    expect(item!.lastSeenAt >= item!.raisedAt).toBe(true)
  })

  it('different signature -> distinct item', async () => {
    const actionQueue = await loadModule(repo)
    const a = await actionQueue.raiseActionQueueItem(baseItem({ signature: 'sig-a' }))
    const b = await actionQueue.raiseActionQueueItem(baseItem({ signature: 'sig-b' }))
    expect(a).not.toBe(b)
    const all = await actionQueue.listActionQueueItems('open')
    expect(all).toHaveLength(2)
  })

  it('getActionQueueItem returns null on unknown id', async () => {
    const actionQueue = await loadModule(repo)
    const result = await actionQueue.getActionQueueItem('does-not-exist')
    expect(result).toBeNull()
  })

  it('listActionQueueItems filters by state and supports "all"', async () => {
    const actionQueue = await loadModule(repo)
    const a = await actionQueue.raiseActionQueueItem(baseItem({ signature: 'a' }))
    await actionQueue.raiseActionQueueItem(baseItem({ signature: 'b' }))
    await actionQueue.raiseActionQueueItem(baseItem({ signature: 'c' }))

    await actionQueue.setActionQueueState(a, 'resolved', { resolution: 'fixed' })

    const open = await actionQueue.listActionQueueItems('open')
    expect(open).toHaveLength(2)
    expect(open.every((i) => i.state === 'open')).toBe(true)

    const resolved = await actionQueue.listActionQueueItems('resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0].id).toBe(a)

    const all = await actionQueue.listActionQueueItems('all')
    expect(all).toHaveLength(3)
  })

  it('listActionQueueItems filters by kind across any state', async () => {
    const actionQueue = await loadModule(repo)
    await actionQueue.raiseActionQueueItem(
      baseItem({ kind: 'failed', signature: 'f-1' }),
    )
    await actionQueue.raiseActionQueueItem(
      baseItem({ kind: 'failed', signature: 'f-2' }),
    )
    await actionQueue.raiseActionQueueItem(
      baseItem({ kind: 'cancelled-blocker-cascade', signature: 'cbc-1' }),
    )

    const failedItems = await actionQueue.listActionQueueItems('open', {
      kind: 'failed',
    })
    expect(failedItems).toHaveLength(2)
    for (const item of failedItems) {
      expect(item.kind).toBe('failed')
    }

    const cascadeItems = await actionQueue.listActionQueueItems('open', { kind: 'cancelled-blocker-cascade' })
    expect(cascadeItems).toHaveLength(1)
    expect(cascadeItems[0].kind).toBe('cancelled-blocker-cascade')

    const noMatch = await actionQueue.listActionQueueItems('open', { kind: 'diagnose-inconclusive' })
    expect(noMatch).toHaveLength(0)

    // Combining state filter and kind filter still narrows correctly.
    const openAll = await actionQueue.listActionQueueItems('open')
    expect(openAll).toHaveLength(3)
  })

  it('setActionQueueState transitions to resolved and persists resolution + note + rootCause', async () => {
    const actionQueue = await loadModule(repo)
    const id = await actionQueue.raiseActionQueueItem(baseItem())
    await actionQueue.setActionQueueState(id, 'resolved', {
      resolution: 'fixed',
      note: 'manual cleanup ran',
      rootCause: 'stale lock from crashed daemon',
    })
    const item = await actionQueue.getActionQueueItem(id)
    expect(item!.state).toBe('resolved')
    expect(item!.resolution).toBe('fixed')
    expect(item!.resolutionNote).toBe('manual cleanup ran')
    expect(item!.rootCause).toBe('stale lock from crashed daemon')
    expect(item!.resolvedAt).not.toBeNull()
  })

  it('setActionQueueState is idempotent on the same terminal state', async () => {
    const actionQueue = await loadModule(repo)
    const id = await actionQueue.raiseActionQueueItem(baseItem())
    await actionQueue.setActionQueueState(id, 'resolved', { resolution: 'fixed' })
    const first = await actionQueue.getActionQueueItem(id)
    const firstResolvedAt = first!.resolvedAt

    await new Promise((r) => setTimeout(r, 5))
    await actionQueue.setActionQueueState(id, 'resolved')
    const second = await actionQueue.getActionQueueItem(id)
    expect(second!.state).toBe('resolved')
    expect(second!.resolution).toBe('fixed')
    expect(second!.resolvedAt).not.toBeNull()
    expect(second!.resolvedAt! >= firstResolvedAt!).toBe(true)
  })

  it('setActionQueueState on unknown id is a no-op', async () => {
    const actionQueue = await loadModule(repo)
    await expect(
      actionQueue.setActionQueueState('nonexistent', 'resolved'),
    ).resolves.toBeUndefined()
  })

  it('originTaskId collapses N failures across kinds/signatures into exactly one open row', async () => {
    const actionQueue = await loadModule(repo)
    const originId = 'origin-1'

    // Simulate 11 failures on the same origin, across kinds and
    // signatures (no-recipe on first failure, recovery-failed on each
    // subsequent recovery attempt, eventually a fix-fail-loop).
    const ids = [
      await actionQueue.raiseActionQueueItem(
        baseItem({
          kind: 'failed',
          signature: 'sig-A',
          originTaskId: originId,
          occurrence: { attempt: 1 },
        }),
      ),
    ]
    for (let i = 2; i <= 10; i += 1) {
      ids.push(
        await actionQueue.raiseActionQueueItem(
          baseItem({
            kind: 'failed',
            signature: `origin-1:sig-${i}`,
            originTaskId: originId,
            occurrence: { attempt: i },
          }),
        ),
      )
    }
    ids.push(
      await actionQueue.raiseActionQueueItem(
        baseItem({
          kind: 'failed',
          signature: 'sig-Z',
          originTaskId: originId,
          occurrence: { attempt: 11 },
        }),
      ),
    )

    // Every raise returns the SAME row id.
    for (const id of ids) {
      expect(id).toBe(ids[0])
    }

    const open = await actionQueue.listActionQueueItems('open')
    expect(open).toHaveLength(1)
    expect(open[0].id).toBe(ids[0])
    expect(open[0].seenCount).toBe(11)
    expect(open[0].payload.occurrences).toHaveLength(11)
  })

  it('originTaskId is independent of fingerprint: a different origin still produces a distinct row', async () => {
    const actionQueue = await loadModule(repo)
    const a = await actionQueue.raiseActionQueueItem(
      baseItem({
        kind: 'failed',
        signature: 'shared-sig',
        originTaskId: 'origin-A',
      }),
    )
    const b = await actionQueue.raiseActionQueueItem(
      baseItem({
        kind: 'failed',
        signature: 'shared-sig',
        originTaskId: 'origin-B',
      }),
    )
    expect(a).not.toBe(b)
    const open = await actionQueue.listActionQueueItems('open')
    expect(open).toHaveLength(2)
  })

  it('omitting originTaskId falls back to (kind, signature) dedup', async () => {
    const actionQueue = await loadModule(repo)
    const a = await actionQueue.raiseActionQueueItem(baseItem({ signature: 'legacy' }))
    const b = await actionQueue.raiseActionQueueItem(baseItem({ signature: 'legacy' }))
    expect(b).toBe(a)
  })

  it('fix-task originTaskId resolves through origin_id — folds onto the arc-origin row', async () => {
    // Load action-queue first; this also resets modules and sets MARS_REPO.
    const actionQueue = await loadModule(repo)

    // Ensure the tasks table exists and insert a fix task whose origin_id
    // points to a different (origin) task.
    const { migrateQueueSchema, resolveQueueClient } = await import('../queue') as {
      migrateQueueSchema: () => Promise<void>
      resolveQueueClient: () => import('@libsql/client').Client
    }
    await migrateQueueSchema()
    const client = resolveQueueClient()
    const originId = 'arc-origin-001'
    const fixTaskId = 'fix-task-for-001'
    const now = new Date().toISOString()
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, created_at, updated_at)
            VALUES (?, ?, 'failed', ?, ?, ?)`,
      args: [fixTaskId, 'fix something', originId, now, now],
    })

    // Raise with the fix-task id — should resolve to the arc origin.
    const idA = await actionQueue.raiseActionQueueItem(
      baseItem({ originTaskId: fixTaskId, occurrence: { attempt: 1 } }),
    )
    // Raise again with the origin id directly — should hit the same row.
    const idB = await actionQueue.raiseActionQueueItem(
      baseItem({ originTaskId: originId, occurrence: { attempt: 2 } }),
    )

    expect(idB).toBe(idA)
    const open = await actionQueue.listActionQueueItems('open')
    expect(open).toHaveLength(1)
    expect(open[0].seenCount).toBe(2)
    // The stored origin_task_id should be the arc root, not the fix task.
    expect(open[0].originTaskId).toBe(originId)
  })

  it('bare proposalId with no matching task row passes through unchanged', async () => {
    // resolveOriginIdForTask returns the id verbatim when no task row exists,
    // so non-task origins (proposal ids, synthetic 'followup:' keys) should
    // still dedup correctly and never throw.
    const actionQueue = await loadModule(repo)
    const proposalId = 'prop-no-task-row-xyz'

    const idA = await actionQueue.raiseActionQueueItem(
      baseItem({ originTaskId: proposalId }),
    )
    const idB = await actionQueue.raiseActionQueueItem(
      baseItem({ originTaskId: proposalId }),
    )

    expect(idB).toBe(idA)
    const open = await actionQueue.listActionQueueItems('open')
    expect(open).toHaveLength(1)
    expect(open[0].originTaskId).toBe(proposalId)
  })

  describe('setRecoveryFindings (slice 3)', () => {
    it('overwrites the existing open row body in place without creating a new row, and re-runs overwrite the same row', async () => {
      const actionQueue = await loadModule(repo)
      const originId = 'origin-recovery-1'
      const created = await actionQueue.raiseActionQueueItem(
        baseItem({
          kind: 'failed',
          signature: 'sig-initial',
          originTaskId: originId,
          body: 'GENERIC kind-template body — run /mars:unblock to inspect.',
        }),
      )
      const before = await actionQueue.getActionQueueItem(created)
      expect(before!.body).toContain('GENERIC kind-template')

      const updatedId = await actionQueue.setRecoveryFindings(
        originId,
        'Recovery findings v1: the failing test asserts foo === 1; suggest updating foo to 1.',
      )

      // No new row, same id, body differs.
      expect(updatedId).toBe(created)
      const afterFirst = await actionQueue.getActionQueueItem(created)
      expect(afterFirst!.id).toBe(before!.id)
      expect(afterFirst!.body).not.toBe(before!.body)
      expect(afterFirst!.body).toContain('Recovery findings v1')

      const openAfterFirst = await actionQueue.listActionQueueItems('open')
      expect(openAfterFirst).toHaveLength(1)
      expect(openAfterFirst[0].id).toBe(created)

      // Re-running recovery overwrites the previous findings on the same row.
      const updatedAgain = await actionQueue.setRecoveryFindings(
        originId,
        'Recovery findings v2: actually, the regression is in bar(); patch bar.',
      )
      expect(updatedAgain).toBe(created)
      const afterSecond = await actionQueue.getActionQueueItem(created)
      expect(afterSecond!.id).toBe(created)
      expect(afterSecond!.body).toContain('Recovery findings v2')
      expect(afterSecond!.body).not.toContain('Recovery findings v1')

      const openAfterSecond = await actionQueue.listActionQueueItems('open')
      expect(openAfterSecond).toHaveLength(1)
    })

    it('returns null and inserts nothing when no open row exists for the origin (generic template stays in charge)', async () => {
      const actionQueue = await loadModule(repo)
      const result = await actionQueue.setRecoveryFindings(
        'unknown-origin',
        'findings text',
      )
      expect(result).toBeNull()
      const open = await actionQueue.listActionQueueItems('open')
      expect(open).toHaveLength(0)
    })
  })

  it('supersedeActionQueueItemsForOrigin closes the open item when the origin task transitions to done', async () => {
    const actionQueue = await loadModule(repo)
    const originId = 'origin-done-1'
    const id = await actionQueue.raiseActionQueueItem(
      baseItem({
        kind: 'failed',
        signature: 'sig-x',
        originTaskId: originId,
      }),
    )
    const openBefore = await actionQueue.listActionQueueItems('open')
    expect(openBefore.some((it) => it.id === id)).toBe(true)

    const closed = await actionQueue.supersedeActionQueueItemsForOrigin(
      originId,
      'origin-done',
    )
    expect(closed).toEqual([id])

    const openAfter = await actionQueue.listActionQueueItems('open')
    expect(openAfter.some((it) => it.id === id)).toBe(false)
    const item = await actionQueue.getActionQueueItem(id)
    expect(item!.state).toBe('resolved')
    expect(item!.resolution).toBe('superseded')
    expect(item!.resolutionNote).toBe('superseded: origin-done')
  })

  it('supersedeActionQueueItemsForOrigin closes the open item when the origin task is dropped', async () => {
    const actionQueue = await loadModule(repo)
    const originId = 'origin-dropped-1'
    const id = await actionQueue.raiseActionQueueItem(
      baseItem({
        kind: 'failed',
        signature: 'sig-y',
        originTaskId: originId,
      }),
    )

    const closed = await actionQueue.supersedeActionQueueItemsForOrigin(
      originId,
      'origin-dropped',
    )
    expect(closed).toEqual([id])

    const openAfter = await actionQueue.listActionQueueItems('open')
    expect(openAfter.some((it) => it.id === id)).toBe(false)
    const item = await actionQueue.getActionQueueItem(id)
    expect(item!.resolutionNote).toBe('superseded: origin-dropped')
  })

  it('supersedeActionQueueItemsForOrigin closes the open item when the origin task is purged', async () => {
    const actionQueue = await loadModule(repo)
    const originId = 'origin-purged-1'
    const id = await actionQueue.raiseActionQueueItem(
      baseItem({
        kind: 'failed',
        signature: 'sig-z',
        originTaskId: originId,
      }),
    )

    const closed = await actionQueue.supersedeActionQueueItemsForOrigin(
      originId,
      'origin-purged',
    )
    expect(closed).toEqual([id])

    const openAfter = await actionQueue.listActionQueueItems('open')
    expect(openAfter.some((it) => it.id === id)).toBe(false)
    const item = await actionQueue.getActionQueueItem(id)
    expect(item!.resolutionNote).toBe('superseded: origin-purged')
  })

  it('supersedeActionQueueItemsForOrigin is a no-op when there is no matching open row', async () => {
    const actionQueue = await loadModule(repo)
    const closed = await actionQueue.supersedeActionQueueItemsForOrigin(
      'no-such-origin',
      'origin-done',
    )
    expect(closed).toEqual([])
  })

  it('supersedeActionQueueItemsForOrigin only touches rows keyed to the given origin', async () => {
    const actionQueue = await loadModule(repo)
    const a = await actionQueue.raiseActionQueueItem(
      baseItem({
        kind: 'failed',
        signature: 'sig-a',
        originTaskId: 'origin-A',
      }),
    )
    const b = await actionQueue.raiseActionQueueItem(
      baseItem({
        kind: 'failed',
        signature: 'sig-b',
        originTaskId: 'origin-B',
      }),
    )

    const closed = await actionQueue.supersedeActionQueueItemsForOrigin(
      'origin-A',
      'origin-done',
    )
    expect(closed).toEqual([a])

    const open = await actionQueue.listActionQueueItems('open')
    expect(open.map((it) => it.id)).toEqual([b])
  })

  it('after resolving an item, raising the same fingerprint creates a new open item (only open is dedup target)', async () => {
    const actionQueue = await loadModule(repo)
    const a = await actionQueue.raiseActionQueueItem(baseItem())
    await actionQueue.setActionQueueState(a, 'resolved', { resolution: 'fixed' })
    const b = await actionQueue.raiseActionQueueItem(baseItem())
    expect(b).not.toBe(a)
    const open = await actionQueue.listActionQueueItems('open')
    expect(open).toHaveLength(1)
    expect(open[0].id).toBe(b)
    expect(open[0].seenCount).toBe(1)
  })

  describe('reconcileStaleActionQueueItems', () => {
    it('closes open items whose origin task is done', async () => {
      const actionQueue = await loadModule(repo)
      const doneTaskId = 'task-done-1'
      const itemId = await actionQueue.raiseActionQueueItem(
        baseItem({ kind: 'failed', signature: 'sig-done', originTaskId: doneTaskId }),
      )

      const result = await actionQueue.reconcileStaleActionQueueItems([
        { id: doneTaskId, status: 'done' },
      ])

      expect(result.closed).toBe(1)
      const item = await actionQueue.getActionQueueItem(itemId)
      expect(item!.state).toBe('resolved')
      expect(item!.resolution).toBe('superseded')
      expect(item!.resolutionNote).toBe('superseded: origin-done')
    })

    it('closes open items whose origin task is dropped', async () => {
      const actionQueue = await loadModule(repo)
      const droppedTaskId = 'task-dropped-1'
      const itemId = await actionQueue.raiseActionQueueItem(
        baseItem({ kind: 'failed', signature: 'sig-dropped', originTaskId: droppedTaskId }),
      )

      const result = await actionQueue.reconcileStaleActionQueueItems([
        { id: droppedTaskId, status: 'dropped' },
      ])

      expect(result.closed).toBe(1)
      const item = await actionQueue.getActionQueueItem(itemId)
      expect(item!.state).toBe('resolved')
      expect(item!.resolutionNote).toBe('superseded: origin-dropped')
    })

    it('leaves open items whose origin task is failed', async () => {
      const actionQueue = await loadModule(repo)
      const failedTaskId = 'task-failed-1'
      const itemId = await actionQueue.raiseActionQueueItem(
        baseItem({ kind: 'failed', signature: 'sig-failed', originTaskId: failedTaskId }),
      )

      // Failed tasks are not passed to reconcile — only done/dropped are
      const result = await actionQueue.reconcileStaleActionQueueItems([])

      expect(result.closed).toBe(0)
      const item = await actionQueue.getActionQueueItem(itemId)
      expect(item!.state).toBe('open')
    })

    it('leaves open items whose origin task is still live (running, queued, etc.)', async () => {
      const actionQueue = await loadModule(repo)
      const liveTaskId = 'task-running-1'
      const itemId = await actionQueue.raiseActionQueueItem(
        baseItem({ kind: 'failed', signature: 'sig-live', originTaskId: liveTaskId }),
      )

      // Live tasks are not passed to reconcile
      const result = await actionQueue.reconcileStaleActionQueueItems([
        { id: 'some-other-done-task', status: 'done' },
      ])

      expect(result.closed).toBe(0)
      const item = await actionQueue.getActionQueueItem(itemId)
      expect(item!.state).toBe('open')
    })

    it('is idempotent: re-running closes zero additional items', async () => {
      const actionQueue = await loadModule(repo)
      const taskId = 'task-done-idem'
      await actionQueue.raiseActionQueueItem(
        baseItem({ kind: 'failed', signature: 'sig-idem', originTaskId: taskId }),
      )

      const first = await actionQueue.reconcileStaleActionQueueItems([{ id: taskId, status: 'done' }])
      expect(first.closed).toBe(1)

      const second = await actionQueue.reconcileStaleActionQueueItems([{ id: taskId, status: 'done' }])
      expect(second.closed).toBe(0)
    })

    it('reports accurate count across multiple tasks', async () => {
      const actionQueue = await loadModule(repo)
      await actionQueue.raiseActionQueueItem(
        baseItem({ kind: 'failed', signature: 'sig-t1', originTaskId: 'task-t1' }),
      )
      await actionQueue.raiseActionQueueItem(
        baseItem({ kind: 'failed', signature: 'sig-t2', originTaskId: 'task-t2' }),
      )
      await actionQueue.raiseActionQueueItem(
        baseItem({ kind: 'failed', signature: 'sig-t3', originTaskId: 'task-t3' }),
      )

      const result = await actionQueue.reconcileStaleActionQueueItems([
        { id: 'task-t1', status: 'done' },
        { id: 'task-t2', status: 'dropped' },
        // task-t3 not included — still open
      ])

      expect(result.closed).toBe(2)
      const open = await actionQueue.listActionQueueItems('open')
      expect(open).toHaveLength(1)
      expect(open[0].payload).toMatchObject({})
    })

    it('returns closed=0 when no actionQueue items exist for the given tasks', async () => {
      const actionQueue = await loadModule(repo)

      const result = await actionQueue.reconcileStaleActionQueueItems([
        { id: 'no-such-task-1', status: 'done' },
        { id: 'no-such-task-2', status: 'dropped' },
      ])

      expect(result.closed).toBe(0)
    })
  })

  describe('supersedeObsoletePreflightDirtyMainRows (slice K cleanup)', () => {
    it('supersedes rows whose payload references the legacy signature', async () => {
      const actionQueue = await loadModule(repo)
      const id = await actionQueue.raiseActionQueueItem(
        baseItem({
          kind: 'failed',
          signature: 'setup:preflight/dirty-main',
          payload: { failureSignature: 'setup:preflight/dirty-main' },
        }),
      )

      const closed = await actionQueue.supersedeObsoletePreflightDirtyMainRows()
      expect(closed).toContain(id)

      const item = await actionQueue.getActionQueueItem(id)
      expect(item!.state).toBe('resolved')
      expect(item!.resolution).toBe('superseded')
      expect(item!.resolutionNote).toBe(
        'superseded by slice K: preflight code path retired',
      )
    })

    it('supersedes rows whose payload references the recovery_exhausted wrapper', async () => {
      const actionQueue = await loadModule(repo)
      const id = await actionQueue.raiseActionQueueItem(
        baseItem({
          kind: 'failed',
          signature: 'rb-1',
          payload: {
            lastErrorSignature:
              'recovery_exhausted:setup:preflight/dirty-main',
          },
        }),
      )

      const closed = await actionQueue.supersedeObsoletePreflightDirtyMainRows()
      expect(closed).toContain(id)

      const item = await actionQueue.getActionQueueItem(id)
      expect(item!.state).toBe('resolved')
    })

    it('supersedes rows whose body literally contains the legacy phrase', async () => {
      const actionQueue = await loadModule(repo)
      const id = await actionQueue.raiseActionQueueItem(
        baseItem({
          kind: 'failed',
          signature: 'body-1',
          body: 'Task parked with setup:preflight/dirty-main; merge target dirty.',
          payload: {},
        }),
      )

      const closed = await actionQueue.supersedeObsoletePreflightDirtyMainRows()
      expect(closed).toContain(id)
    })

    it('leaves untouched rows that do not reference the legacy strings', async () => {
      const actionQueue = await loadModule(repo)
      const id = await actionQueue.raiseActionQueueItem(
        baseItem({
          kind: 'failed',
          signature: 'verify:main-dirty',
          body: 'integration branch dirty; main-commiter recovery spawned.',
          payload: { failureSignature: 'verify:main-dirty' },
        }),
      )

      const closed = await actionQueue.supersedeObsoletePreflightDirtyMainRows()
      expect(closed).not.toContain(id)

      const item = await actionQueue.getActionQueueItem(id)
      expect(item!.state).toBe('open')
    })

    it('is idempotent: rerunning closes zero additional rows', async () => {
      const actionQueue = await loadModule(repo)
      await actionQueue.raiseActionQueueItem(
        baseItem({
          kind: 'failed',
          signature: 'setup:preflight/dirty-main',
          payload: { failureSignature: 'setup:preflight/dirty-main' },
        }),
      )

      const first = await actionQueue.supersedeObsoletePreflightDirtyMainRows()
      expect(first.length).toBe(1)

      const second = await actionQueue.supersedeObsoletePreflightDirtyMainRows()
      expect(second).toEqual([])
    })

    it('is a silent no-op when no rows match', async () => {
      const actionQueue = await loadModule(repo)
      const closed = await actionQueue.supersedeObsoletePreflightDirtyMainRows()
      expect(closed).toEqual([])
    })

    it('does not touch rows that are already resolved', async () => {
      const actionQueue = await loadModule(repo)
      const id = await actionQueue.raiseActionQueueItem(
        baseItem({
          kind: 'failed',
          signature: 'setup:preflight/dirty-main',
          payload: { failureSignature: 'setup:preflight/dirty-main' },
        }),
      )
      // Pre-resolve via a different path.
      await actionQueue.setActionQueueState(id, 'resolved', { resolution: 'fixed' })

      const closed = await actionQueue.supersedeObsoletePreflightDirtyMainRows()
      expect(closed).toEqual([])

      const item = await actionQueue.getActionQueueItem(id)
      // Original resolution preserved.
      expect(item!.resolution).toBe('fixed')
    })
  })

  describe('live task state on getActionQueueItem (slice 6)', () => {
    it('liveTaskStatus reflects what the liveTaskLookup returns at call time', async () => {
      const actionQueue = await loadModule(repo)
      const originId = 'task-stuck-live-1'
      const id = await actionQueue.raiseActionQueueItem(
        baseItem({
          kind: 'diagnose-inconclusive',
          originTaskId: originId,
        }),
      )

      // Provide a lookup that simulates the task currently being 'failed'
      const item = await actionQueue.getActionQueueItem(id, async () => ({ status: 'failed' }))
      expect(item).not.toBeNull()
      expect(item!.originTaskId).toBe(originId)
      expect(item!.liveTaskStatus).toBe('failed')
    })

    it('a subsequent open reflects changed task state — not the stale status at raise time', async () => {
      const actionQueue = await loadModule(repo)
      const originId = 'task-stuck-live-2'
      const id = await actionQueue.raiseActionQueueItem(
        baseItem({
          kind: 'diagnose-inconclusive',
          originTaskId: originId,
          payload: { taskStatusAtRaise: 'failed' },
        }),
      )

      // First open: task is 'failed'
      const before = await actionQueue.getActionQueueItem(id, async () => ({ status: 'failed' }))
      expect(before!.liveTaskStatus).toBe('failed')

      // Operator restarts the task → status changes to 'queued'.
      // A subsequent open must reflect the NEW state, not the stale stored copy.
      const after = await actionQueue.getActionQueueItem(id, async () => ({ status: 'queued' }))
      expect(after!.liveTaskStatus).toBe('queued')
      // The stored payload is untouched — live state is derived from the lookup.
      expect(after!.payload.taskStatusAtRaise).toBe('failed')
    })

    it('liveTaskStatus is null when the item has no originTaskId', async () => {
      const actionQueue = await loadModule(repo)
      const id = await actionQueue.raiseActionQueueItem(
        baseItem({ signature: 'no-origin' }), // no originTaskId
      )
      // The lookup must not be invoked when there is no originTaskId.
      const lookup = vi.fn(async () => ({ status: 'failed' as string }))
      const item = await actionQueue.getActionQueueItem(id, lookup)
      expect(item!.liveTaskStatus).toBeNull()
      expect(lookup).not.toHaveBeenCalled()
    })

    it('liveTaskStatus is null when the lookup finds no task', async () => {
      const actionQueue = await loadModule(repo)
      const originId = 'task-deleted'
      const id = await actionQueue.raiseActionQueueItem(
        baseItem({ kind: 'diagnose-inconclusive', originTaskId: originId }),
      )
      const item = await actionQueue.getActionQueueItem(id, async () => null)
      expect(item!.liveTaskStatus).toBeNull()
    })
  })
})

describe('supersedeOrphanedHitlActionQueueRows — orphan sweep', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('supersedes an open hitl-slice-needs-operator item with no backing HITL task', async () => {
    const actionQueue = await loadModule(repo)

    // Raise a hitl-slice-needs-operator item with no task in the tasks table.
    await actionQueue.raiseActionQueueItem({
      kind: 'hitl-slice-needs-operator',
      category: 'orchestrator',
      priority: 'normal',
      title: 'HITL: Manual smoke test',
      body: 'Run the smoke test manually',
      payload: { proposalId: 'prop-orphan-1', sliceIndex: 3, subTaskId: 'sub-1' },
      context: {},
      raisedBy: 'slicer',
      signature: 'prop-orphan-1:hitl:3',
    })

    // Confirm it is open before sweep.
    const before = await actionQueue.listActionQueueItems('open')
    expect(before.some((i) => i.kind === 'hitl-slice-needs-operator')).toBe(true)

    const swept = await actionQueue.supersedeOrphanedHitlActionQueueRows()
    expect(swept).toHaveLength(1)

    // Should no longer appear as open.
    const after = await actionQueue.listActionQueueItems('open')
    expect(after.every((i) => i.kind !== 'hitl-slice-needs-operator')).toBe(true)
  })

  it('does NOT supersede a hitl-slice-needs-operator item that has a backing HITL task', async () => {
    const actionQueue = await loadModule(repo)

    // Insert a tasks row with slice_kind='hitl' matching the signature.
    const { migrateQueueSchema, resolveQueueClient } = await import('../queue') as {
      migrateQueueSchema: () => Promise<void>
      resolveQueueClient: () => import('@libsql/client').Client
    }
    await migrateQueueSchema()
    const client = resolveQueueClient()
    const now = new Date().toISOString()
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, slice_index, slice_kind, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['hitl-task-1', 'Manual HITL step', 'blocked', 'prop-backed-1', 5, 'hitl', now, now],
    })

    // Raise the corresponding actionQueue item.
    await actionQueue.raiseActionQueueItem({
      kind: 'hitl-slice-needs-operator',
      category: 'orchestrator',
      priority: 'normal',
      title: 'HITL: Backed step',
      body: 'This one has a backing task',
      payload: { proposalId: 'prop-backed-1', sliceIndex: 5, subTaskId: 'sub-2' },
      context: {},
      raisedBy: 'slicer',
      signature: 'prop-backed-1:hitl:5',
    })

    const swept = await actionQueue.supersedeOrphanedHitlActionQueueRows()
    // The item has a backing task — must NOT be swept.
    expect(swept).toHaveLength(0)

    // Still open.
    const open = await actionQueue.listActionQueueItems('open')
    expect(open.some((i) => i.kind === 'hitl-slice-needs-operator')).toBe(true)
  })

  it('is idempotent — a second call after sweep supersedes nothing', async () => {
    const actionQueue = await loadModule(repo)

    await actionQueue.raiseActionQueueItem({
      kind: 'hitl-slice-needs-operator',
      category: 'orchestrator',
      priority: 'normal',
      title: 'HITL: Idempotent check',
      body: 'Run twice',
      payload: { proposalId: 'prop-idem-1', sliceIndex: 1, subTaskId: 'sub-3' },
      context: {},
      raisedBy: 'slicer',
      signature: 'prop-idem-1:hitl:1',
    })

    const first = await actionQueue.supersedeOrphanedHitlActionQueueRows()
    expect(first).toHaveLength(1)

    const second = await actionQueue.supersedeOrphanedHitlActionQueueRows()
    expect(second).toHaveLength(0)
  })
})


describe('ACTION_QUEUE_KINDS membership — writer kind constants', () => {
  it('every raiseActionQueueItem writer kind constant is a member of ACTION_QUEUE_KINDS', async () => {
    // Import ACTION_QUEUE_KINDS fresh so any module-cache state is irrelevant.
    const { isActionQueueKind } = await import('./action-queue-kinds')

    const writerKinds: [string, string][] = [
      ['RECOVERY_FAILED_ACTION_QUEUE_KIND', RECOVERY_FAILED_ACTION_QUEUE_KIND],
      ['UNKNOWN_FAILURE_ACTION_QUEUE_KIND', UNKNOWN_FAILURE_ACTION_QUEUE_KIND],
      ['FIX_FAIL_LOOP_ACTION_QUEUE_KIND', FIX_FAIL_LOOP_ACTION_QUEUE_KIND],
      ['TASK_BLOCKED_ACTION_QUEUE_KIND', TASK_BLOCKED_ACTION_QUEUE_KIND],
      ['DAEMON_KILLED_ACTION_QUEUE_KIND', DAEMON_KILLED_ACTION_QUEUE_KIND],
      ['STALE_WORKTREE_KIND', STALE_WORKTREE_KIND],
      ['WORKTREE_AHEAD_ACTION_QUEUE_KIND', WORKTREE_AHEAD_ACTION_QUEUE_KIND],
      ['PREREQUISITE_FAILED_ACTION_QUEUE_KIND', PREREQUISITE_FAILED_ACTION_QUEUE_KIND],
      ['CANCELLED_CASCADE_ACTION_QUEUE_KIND', CANCELLED_CASCADE_ACTION_QUEUE_KIND],
    ]

    for (const [name, kind] of writerKinds) {
      expect(isActionQueueKind(kind), `${name} ("${kind}") must be in ACTION_QUEUE_KINDS`).toBe(true)
    }
  })
})
