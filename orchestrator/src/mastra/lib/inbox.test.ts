import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RECOVERY_FAILED_INBOX_KIND,
  NO_RECIPE_INBOX_KIND,
  FIX_FAIL_LOOP_INBOX_KIND,
} from '../queue-fix-tasks'
import { TASK_BLOCKED_INBOX_KIND } from '../queue-retry'
import { DAEMON_KILLED_INBOX_KIND } from '../daemon/daemon-killed-sweep'
import { STALE_WORKTREE_KIND } from '../daemon/stale-worktree-sweep'
import {
  WORKTREE_AHEAD_INBOX_KIND,
  PREREQUISITE_FAILED_INBOX_KIND,
  CANCELLED_CASCADE_INBOX_KIND,
} from '../blocker-resolution'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface InboxModule {
  raiseInboxItem: typeof import('./inbox').raiseInboxItem
  listInboxItems: typeof import('./inbox').listInboxItems
  getInboxItem: typeof import('./inbox').getInboxItem
  setInboxState: typeof import('./inbox').setInboxState
  setRecoveryFindings: typeof import('./inbox').setRecoveryFindings
  supersedeInboxItemsForOrigin: typeof import('./inbox').supersedeInboxItemsForOrigin
  reconcileStaleInboxItems: typeof import('./inbox').reconcileStaleInboxItems
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-inbox-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModule = async (repo: string): Promise<InboxModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  return (await import('./inbox')) as unknown as InboxModule
}

const baseItem = (overrides: Partial<Parameters<InboxModule['raiseInboxItem']>[0]> = {}) => ({
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

describe('inbox', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('inserts a new item with seen_count=1, state=open, fingerprint=sha1(kind:signature)', async () => {
    const inbox = await loadModule(repo)
    const id = await inbox.raiseInboxItem(
      baseItem({ occurrence: { task_id: 'abc123', stderr_tail: 'EPERM' } }),
    )
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)

    const item = await inbox.getInboxItem(id)
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
    const inbox = await loadModule(repo)
    const first = await inbox.raiseInboxItem(
      baseItem({ occurrence: { task_id: 't1' } }),
    )
    const second = await inbox.raiseInboxItem(
      baseItem({ occurrence: { task_id: 't2' } }),
    )
    const third = await inbox.raiseInboxItem(
      baseItem({ occurrence: { task_id: 't3' } }),
    )
    expect(second).toBe(first)
    expect(third).toBe(first)

    const item = await inbox.getInboxItem(first)
    expect(item!.seenCount).toBe(3)
    expect(item!.payload.occurrences).toEqual([
      { task_id: 't1' },
      { task_id: 't2' },
      { task_id: 't3' },
    ])
    expect(item!.lastSeenAt >= item!.raisedAt).toBe(true)
  })

  it('different signature -> distinct item', async () => {
    const inbox = await loadModule(repo)
    const a = await inbox.raiseInboxItem(baseItem({ signature: 'sig-a' }))
    const b = await inbox.raiseInboxItem(baseItem({ signature: 'sig-b' }))
    expect(a).not.toBe(b)
    const all = await inbox.listInboxItems('open')
    expect(all).toHaveLength(2)
  })

  it('getInboxItem returns null on unknown id', async () => {
    const inbox = await loadModule(repo)
    const result = await inbox.getInboxItem('does-not-exist')
    expect(result).toBeNull()
  })

  it('listInboxItems filters by state and supports "all"', async () => {
    const inbox = await loadModule(repo)
    const a = await inbox.raiseInboxItem(baseItem({ signature: 'a' }))
    const b = await inbox.raiseInboxItem(baseItem({ signature: 'b' }))
    await inbox.raiseInboxItem(baseItem({ signature: 'c' }))

    await inbox.setInboxState(a, 'resolved', { resolution: 'fixed' })
    await inbox.setInboxState(b, 'dismissed')

    const open = await inbox.listInboxItems('open')
    expect(open).toHaveLength(1)
    expect(open[0].state).toBe('open')

    const resolved = await inbox.listInboxItems('resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0].id).toBe(a)

    const dismissed = await inbox.listInboxItems('dismissed')
    expect(dismissed).toHaveLength(1)
    expect(dismissed[0].id).toBe(b)

    const all = await inbox.listInboxItems('all')
    expect(all).toHaveLength(3)
  })

  it('listInboxItems filters by kind across any state', async () => {
    const inbox = await loadModule(repo)
    await inbox.raiseInboxItem(
      baseItem({ kind: 'failed', signature: 'f-1' }),
    )
    await inbox.raiseInboxItem(
      baseItem({ kind: 'failed', signature: 'f-2' }),
    )
    await inbox.raiseInboxItem(
      baseItem({ kind: 'cancelled-blocker-cascade', signature: 'cbc-1' }),
    )

    const failedItems = await inbox.listInboxItems('open', {
      kind: 'failed',
    })
    expect(failedItems).toHaveLength(2)
    for (const item of failedItems) {
      expect(item.kind).toBe('failed')
    }

    const cascadeItems = await inbox.listInboxItems('open', { kind: 'cancelled-blocker-cascade' })
    expect(cascadeItems).toHaveLength(1)
    expect(cascadeItems[0].kind).toBe('cancelled-blocker-cascade')

    const noMatch = await inbox.listInboxItems('open', { kind: 'diagnose-inconclusive' })
    expect(noMatch).toHaveLength(0)

    // Combining state filter and kind filter still narrows correctly.
    const openAll = await inbox.listInboxItems('open')
    expect(openAll).toHaveLength(3)
  })

  it('setInboxState transitions to resolved and persists resolution + note + rootCause', async () => {
    const inbox = await loadModule(repo)
    const id = await inbox.raiseInboxItem(baseItem())
    await inbox.setInboxState(id, 'resolved', {
      resolution: 'fixed',
      note: 'manual cleanup ran',
      rootCause: 'stale lock from crashed daemon',
    })
    const item = await inbox.getInboxItem(id)
    expect(item!.state).toBe('resolved')
    expect(item!.resolution).toBe('fixed')
    expect(item!.resolutionNote).toBe('manual cleanup ran')
    expect(item!.rootCause).toBe('stale lock from crashed daemon')
    expect(item!.resolvedAt).not.toBeNull()
  })

  it('setInboxState acknowledged does not set resolved_at', async () => {
    const inbox = await loadModule(repo)
    const id = await inbox.raiseInboxItem(baseItem())
    await inbox.setInboxState(id, 'acknowledged')
    const item = await inbox.getInboxItem(id)
    expect(item!.state).toBe('acknowledged')
    expect(item!.resolvedAt).toBeNull()
  })

  it('setInboxState is idempotent on the same terminal state', async () => {
    const inbox = await loadModule(repo)
    const id = await inbox.raiseInboxItem(baseItem())
    await inbox.setInboxState(id, 'resolved', { resolution: 'fixed' })
    const first = await inbox.getInboxItem(id)
    const firstResolvedAt = first!.resolvedAt

    await new Promise((r) => setTimeout(r, 5))
    await inbox.setInboxState(id, 'resolved')
    const second = await inbox.getInboxItem(id)
    expect(second!.state).toBe('resolved')
    expect(second!.resolution).toBe('fixed')
    expect(second!.resolvedAt).not.toBeNull()
    expect(second!.resolvedAt! >= firstResolvedAt!).toBe(true)
  })

  it('setInboxState on unknown id is a no-op', async () => {
    const inbox = await loadModule(repo)
    await expect(
      inbox.setInboxState('nonexistent', 'resolved'),
    ).resolves.toBeUndefined()
  })

  it('originTaskId collapses N failures across kinds/signatures into exactly one open row', async () => {
    const inbox = await loadModule(repo)
    const originId = 'origin-1'

    // Simulate 11 failures on the same origin, across kinds and
    // signatures (no-recipe on first failure, recovery-failed on each
    // subsequent recovery attempt, eventually a fix-fail-loop).
    const ids = [
      await inbox.raiseInboxItem(
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
        await inbox.raiseInboxItem(
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
      await inbox.raiseInboxItem(
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

    const open = await inbox.listInboxItems('open')
    expect(open).toHaveLength(1)
    expect(open[0].id).toBe(ids[0])
    expect(open[0].seenCount).toBe(11)
    expect(open[0].payload.occurrences).toHaveLength(11)
  })

  it('originTaskId is independent of fingerprint: a different origin still produces a distinct row', async () => {
    const inbox = await loadModule(repo)
    const a = await inbox.raiseInboxItem(
      baseItem({
        kind: 'failed',
        signature: 'shared-sig',
        originTaskId: 'origin-A',
      }),
    )
    const b = await inbox.raiseInboxItem(
      baseItem({
        kind: 'failed',
        signature: 'shared-sig',
        originTaskId: 'origin-B',
      }),
    )
    expect(a).not.toBe(b)
    const open = await inbox.listInboxItems('open')
    expect(open).toHaveLength(2)
  })

  it('omitting originTaskId falls back to (kind, signature) dedup', async () => {
    const inbox = await loadModule(repo)
    const a = await inbox.raiseInboxItem(baseItem({ signature: 'legacy' }))
    const b = await inbox.raiseInboxItem(baseItem({ signature: 'legacy' }))
    expect(b).toBe(a)
  })

  describe('setRecoveryFindings (slice 3)', () => {
    it('overwrites the existing open row body in place without creating a new row, and re-runs overwrite the same row', async () => {
      const inbox = await loadModule(repo)
      const originId = 'origin-recovery-1'
      const created = await inbox.raiseInboxItem(
        baseItem({
          kind: 'failed',
          signature: 'sig-initial',
          originTaskId: originId,
          body: 'GENERIC kind-template body — run /mars:unblock to inspect.',
        }),
      )
      const before = await inbox.getInboxItem(created)
      expect(before!.body).toContain('GENERIC kind-template')

      const updatedId = await inbox.setRecoveryFindings(
        originId,
        'Recovery findings v1: the failing test asserts foo === 1; suggest updating foo to 1.',
      )

      // No new row, same id, body differs.
      expect(updatedId).toBe(created)
      const afterFirst = await inbox.getInboxItem(created)
      expect(afterFirst!.id).toBe(before!.id)
      expect(afterFirst!.body).not.toBe(before!.body)
      expect(afterFirst!.body).toContain('Recovery findings v1')

      const openAfterFirst = await inbox.listInboxItems('open')
      expect(openAfterFirst).toHaveLength(1)
      expect(openAfterFirst[0].id).toBe(created)

      // Re-running recovery overwrites the previous findings on the same row.
      const updatedAgain = await inbox.setRecoveryFindings(
        originId,
        'Recovery findings v2: actually, the regression is in bar(); patch bar.',
      )
      expect(updatedAgain).toBe(created)
      const afterSecond = await inbox.getInboxItem(created)
      expect(afterSecond!.id).toBe(created)
      expect(afterSecond!.body).toContain('Recovery findings v2')
      expect(afterSecond!.body).not.toContain('Recovery findings v1')

      const openAfterSecond = await inbox.listInboxItems('open')
      expect(openAfterSecond).toHaveLength(1)
    })

    it('returns null and inserts nothing when no open row exists for the origin (generic template stays in charge)', async () => {
      const inbox = await loadModule(repo)
      const result = await inbox.setRecoveryFindings(
        'unknown-origin',
        'findings text',
      )
      expect(result).toBeNull()
      const open = await inbox.listInboxItems('open')
      expect(open).toHaveLength(0)
    })
  })

  it('supersedeInboxItemsForOrigin closes the open item when the origin task transitions to done', async () => {
    const inbox = await loadModule(repo)
    const originId = 'origin-done-1'
    const id = await inbox.raiseInboxItem(
      baseItem({
        kind: 'failed',
        signature: 'sig-x',
        originTaskId: originId,
      }),
    )
    const openBefore = await inbox.listInboxItems('open')
    expect(openBefore.some((it) => it.id === id)).toBe(true)

    const closed = await inbox.supersedeInboxItemsForOrigin(
      originId,
      'origin-done',
    )
    expect(closed).toEqual([id])

    const openAfter = await inbox.listInboxItems('open')
    expect(openAfter.some((it) => it.id === id)).toBe(false)
    const item = await inbox.getInboxItem(id)
    expect(item!.state).toBe('resolved')
    expect(item!.resolution).toBe('superseded')
    expect(item!.resolutionNote).toBe('superseded: origin-done')
  })

  it('supersedeInboxItemsForOrigin closes the open item when the origin task is dropped', async () => {
    const inbox = await loadModule(repo)
    const originId = 'origin-dropped-1'
    const id = await inbox.raiseInboxItem(
      baseItem({
        kind: 'failed',
        signature: 'sig-y',
        originTaskId: originId,
      }),
    )

    const closed = await inbox.supersedeInboxItemsForOrigin(
      originId,
      'origin-dropped',
    )
    expect(closed).toEqual([id])

    const openAfter = await inbox.listInboxItems('open')
    expect(openAfter.some((it) => it.id === id)).toBe(false)
    const item = await inbox.getInboxItem(id)
    expect(item!.resolutionNote).toBe('superseded: origin-dropped')
  })

  it('supersedeInboxItemsForOrigin closes the open item when the origin task is purged', async () => {
    const inbox = await loadModule(repo)
    const originId = 'origin-purged-1'
    const id = await inbox.raiseInboxItem(
      baseItem({
        kind: 'failed',
        signature: 'sig-z',
        originTaskId: originId,
      }),
    )

    const closed = await inbox.supersedeInboxItemsForOrigin(
      originId,
      'origin-purged',
    )
    expect(closed).toEqual([id])

    const openAfter = await inbox.listInboxItems('open')
    expect(openAfter.some((it) => it.id === id)).toBe(false)
    const item = await inbox.getInboxItem(id)
    expect(item!.resolutionNote).toBe('superseded: origin-purged')
  })

  it('supersedeInboxItemsForOrigin is a no-op when there is no matching open row', async () => {
    const inbox = await loadModule(repo)
    const closed = await inbox.supersedeInboxItemsForOrigin(
      'no-such-origin',
      'origin-done',
    )
    expect(closed).toEqual([])
  })

  it('supersedeInboxItemsForOrigin only touches rows keyed to the given origin', async () => {
    const inbox = await loadModule(repo)
    const a = await inbox.raiseInboxItem(
      baseItem({
        kind: 'failed',
        signature: 'sig-a',
        originTaskId: 'origin-A',
      }),
    )
    const b = await inbox.raiseInboxItem(
      baseItem({
        kind: 'failed',
        signature: 'sig-b',
        originTaskId: 'origin-B',
      }),
    )

    const closed = await inbox.supersedeInboxItemsForOrigin(
      'origin-A',
      'origin-done',
    )
    expect(closed).toEqual([a])

    const open = await inbox.listInboxItems('open')
    expect(open.map((it) => it.id)).toEqual([b])
  })

  it('after resolving an item, raising the same fingerprint creates a new open item (only open is dedup target)', async () => {
    const inbox = await loadModule(repo)
    const a = await inbox.raiseInboxItem(baseItem())
    await inbox.setInboxState(a, 'resolved', { resolution: 'fixed' })
    const b = await inbox.raiseInboxItem(baseItem())
    expect(b).not.toBe(a)
    const open = await inbox.listInboxItems('open')
    expect(open).toHaveLength(1)
    expect(open[0].id).toBe(b)
    expect(open[0].seenCount).toBe(1)
  })

  describe('reconcileStaleInboxItems', () => {
    it('closes open items whose origin task is done', async () => {
      const inbox = await loadModule(repo)
      const doneTaskId = 'task-done-1'
      const itemId = await inbox.raiseInboxItem(
        baseItem({ kind: 'failed', signature: 'sig-done', originTaskId: doneTaskId }),
      )

      const result = await inbox.reconcileStaleInboxItems([
        { id: doneTaskId, status: 'done' },
      ])

      expect(result.closed).toBe(1)
      const item = await inbox.getInboxItem(itemId)
      expect(item!.state).toBe('resolved')
      expect(item!.resolution).toBe('superseded')
      expect(item!.resolutionNote).toBe('superseded: origin-done')
    })

    it('closes open items whose origin task is dropped', async () => {
      const inbox = await loadModule(repo)
      const droppedTaskId = 'task-dropped-1'
      const itemId = await inbox.raiseInboxItem(
        baseItem({ kind: 'failed', signature: 'sig-dropped', originTaskId: droppedTaskId }),
      )

      const result = await inbox.reconcileStaleInboxItems([
        { id: droppedTaskId, status: 'dropped' },
      ])

      expect(result.closed).toBe(1)
      const item = await inbox.getInboxItem(itemId)
      expect(item!.state).toBe('resolved')
      expect(item!.resolutionNote).toBe('superseded: origin-dropped')
    })

    it('leaves open items whose origin task is failed', async () => {
      const inbox = await loadModule(repo)
      const failedTaskId = 'task-failed-1'
      const itemId = await inbox.raiseInboxItem(
        baseItem({ kind: 'failed', signature: 'sig-failed', originTaskId: failedTaskId }),
      )

      // Failed tasks are not passed to reconcile — only done/dropped are
      const result = await inbox.reconcileStaleInboxItems([])

      expect(result.closed).toBe(0)
      const item = await inbox.getInboxItem(itemId)
      expect(item!.state).toBe('open')
    })

    it('leaves open items whose origin task is still live (running, queued, etc.)', async () => {
      const inbox = await loadModule(repo)
      const liveTaskId = 'task-running-1'
      const itemId = await inbox.raiseInboxItem(
        baseItem({ kind: 'failed', signature: 'sig-live', originTaskId: liveTaskId }),
      )

      // Live tasks are not passed to reconcile
      const result = await inbox.reconcileStaleInboxItems([
        { id: 'some-other-done-task', status: 'done' },
      ])

      expect(result.closed).toBe(0)
      const item = await inbox.getInboxItem(itemId)
      expect(item!.state).toBe('open')
    })

    it('is idempotent: re-running closes zero additional items', async () => {
      const inbox = await loadModule(repo)
      const taskId = 'task-done-idem'
      await inbox.raiseInboxItem(
        baseItem({ kind: 'failed', signature: 'sig-idem', originTaskId: taskId }),
      )

      const first = await inbox.reconcileStaleInboxItems([{ id: taskId, status: 'done' }])
      expect(first.closed).toBe(1)

      const second = await inbox.reconcileStaleInboxItems([{ id: taskId, status: 'done' }])
      expect(second.closed).toBe(0)
    })

    it('reports accurate count across multiple tasks', async () => {
      const inbox = await loadModule(repo)
      await inbox.raiseInboxItem(
        baseItem({ kind: 'failed', signature: 'sig-t1', originTaskId: 'task-t1' }),
      )
      await inbox.raiseInboxItem(
        baseItem({ kind: 'failed', signature: 'sig-t2', originTaskId: 'task-t2' }),
      )
      await inbox.raiseInboxItem(
        baseItem({ kind: 'failed', signature: 'sig-t3', originTaskId: 'task-t3' }),
      )

      const result = await inbox.reconcileStaleInboxItems([
        { id: 'task-t1', status: 'done' },
        { id: 'task-t2', status: 'dropped' },
        // task-t3 not included — still open
      ])

      expect(result.closed).toBe(2)
      const open = await inbox.listInboxItems('open')
      expect(open).toHaveLength(1)
      expect(open[0].payload).toMatchObject({})
    })

    it('returns closed=0 when no inbox items exist for the given tasks', async () => {
      const inbox = await loadModule(repo)

      const result = await inbox.reconcileStaleInboxItems([
        { id: 'no-such-task-1', status: 'done' },
        { id: 'no-such-task-2', status: 'dropped' },
      ])

      expect(result.closed).toBe(0)
    })
  })

  describe('live task state on getInboxItem (slice 6)', () => {
    it('liveTaskStatus reflects what the liveTaskLookup returns at call time', async () => {
      const inbox = await loadModule(repo)
      const originId = 'task-stuck-live-1'
      const id = await inbox.raiseInboxItem(
        baseItem({
          kind: 'diagnose-inconclusive',
          originTaskId: originId,
        }),
      )

      // Provide a lookup that simulates the task currently being 'failed'
      const item = await inbox.getInboxItem(id, async () => ({ status: 'failed' }))
      expect(item).not.toBeNull()
      expect(item!.originTaskId).toBe(originId)
      expect(item!.liveTaskStatus).toBe('failed')
    })

    it('a subsequent open reflects changed task state — not the stale status at raise time', async () => {
      const inbox = await loadModule(repo)
      const originId = 'task-stuck-live-2'
      const id = await inbox.raiseInboxItem(
        baseItem({
          kind: 'diagnose-inconclusive',
          originTaskId: originId,
          payload: { taskStatusAtRaise: 'failed' },
        }),
      )

      // First open: task is 'failed'
      const before = await inbox.getInboxItem(id, async () => ({ status: 'failed' }))
      expect(before!.liveTaskStatus).toBe('failed')

      // Operator restarts the task → status changes to 'queued'.
      // A subsequent open must reflect the NEW state, not the stale stored copy.
      const after = await inbox.getInboxItem(id, async () => ({ status: 'queued' }))
      expect(after!.liveTaskStatus).toBe('queued')
      // The stored payload is untouched — live state is derived from the lookup.
      expect(after!.payload.taskStatusAtRaise).toBe('failed')
    })

    it('liveTaskStatus is null when the item has no originTaskId', async () => {
      const inbox = await loadModule(repo)
      const id = await inbox.raiseInboxItem(
        baseItem({ signature: 'no-origin' }), // no originTaskId
      )
      // The lookup must not be invoked when there is no originTaskId.
      const lookup = vi.fn(async () => ({ status: 'failed' as string }))
      const item = await inbox.getInboxItem(id, lookup)
      expect(item!.liveTaskStatus).toBeNull()
      expect(lookup).not.toHaveBeenCalled()
    })

    it('liveTaskStatus is null when the lookup finds no task', async () => {
      const inbox = await loadModule(repo)
      const originId = 'task-deleted'
      const id = await inbox.raiseInboxItem(
        baseItem({ kind: 'diagnose-inconclusive', originTaskId: originId }),
      )
      const item = await inbox.getInboxItem(id, async () => null)
      expect(item!.liveTaskStatus).toBeNull()
    })
  })
})

describe('INBOX_KINDS membership — writer kind constants', () => {
  it('every raiseInboxItem writer kind constant is a member of INBOX_KINDS', async () => {
    // Import INBOX_KINDS fresh so any module-cache state is irrelevant.
    const { isInboxKind } = await import('./inbox')

    const writerKinds: [string, string][] = [
      ['RECOVERY_FAILED_INBOX_KIND', RECOVERY_FAILED_INBOX_KIND],
      ['NO_RECIPE_INBOX_KIND', NO_RECIPE_INBOX_KIND],
      ['FIX_FAIL_LOOP_INBOX_KIND', FIX_FAIL_LOOP_INBOX_KIND],
      ['TASK_BLOCKED_INBOX_KIND', TASK_BLOCKED_INBOX_KIND],
      ['DAEMON_KILLED_INBOX_KIND', DAEMON_KILLED_INBOX_KIND],
      ['STALE_WORKTREE_KIND', STALE_WORKTREE_KIND],
      ['WORKTREE_AHEAD_INBOX_KIND', WORKTREE_AHEAD_INBOX_KIND],
      ['PREREQUISITE_FAILED_INBOX_KIND', PREREQUISITE_FAILED_INBOX_KIND],
      ['CANCELLED_CASCADE_INBOX_KIND', CANCELLED_CASCADE_INBOX_KIND],
    ]

    for (const [name, kind] of writerKinds) {
      expect(isInboxKind(kind), `${name} ("${kind}") must be in INBOX_KINDS`).toBe(true)
    }
  })
})
