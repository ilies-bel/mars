import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Client } from '@libsql/client'
import type { EventName, EventPayload } from '../../../bus/events.js'

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
}

interface ActionQueueModule {
  raiseActionQueueItem: typeof import('../../lib/action-queue').raiseActionQueueItem
  getActionQueueItem: typeof import('../../lib/action-queue').getActionQueueItem
}

interface AlertDismisserModule {
  ALERT_DISMISSER_SUBSCRIBER: typeof import('../alert-dismisser').ALERT_DISMISSER_SUBSCRIBER
  ensureAlertDismisser: typeof import('../alert-dismisser').ensureAlertDismisser
  drainAlertDismissals: typeof import('../alert-dismisser').drainAlertDismissals
}

interface PublisherModule {
  publishWithRetry: typeof import('../../../bus/publisher').publishWithRetry
}

interface SubscribersModule {
  getCursor: typeof import('../../../bus/subscribers').getCursor
}

interface Loaded {
  q: QueueModule
  actionQueue: ActionQueueModule
  ad: AlertDismisserModule
  pub: PublisherModule
  subs: SubscribersModule
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-alert-dismisser-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * Load every module against the same temp repo. `MARS_REPO` makes
 * `resolveContext()` resolve `stateDbPath`/`queueDbPath` to one
 * `.mars/mars.db`, so the events table (migrateQueueSchema) and
 * action_queue_items share a single libsql client.
 */
const loadModules = async (repo: string): Promise<Loaded> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  const ad = (await import('../alert-dismisser')) as unknown as AlertDismisserModule
  const pub = (await import('../../../bus/publisher')) as unknown as PublisherModule
  const subs = (await import(
    '../../../bus/subscribers'
  )) as unknown as SubscribersModule
  return { q, actionQueue, ad, pub, subs }
}

/**
 * Verify that the `events` table contains a row of type `eventType` with
 * a payload containing `{ taskId }`. Returns true if found.
 */
const findEventRow = async (
  client: Client,
  eventType: string,
  taskId: string,
): Promise<boolean> => {
  const result = await client.execute({
    sql: `SELECT payload FROM events WHERE type = ? ORDER BY id DESC LIMIT 10`,
    args: [eventType],
  })
  return result.rows.some((r) => {
    try {
      const p = JSON.parse((r as unknown as { payload: string }).payload) as { taskId?: string }
      return p.taskId === taskId
    } catch { return false }
  })
}

/** Raise a single open, origin-keyed actionQueue item for `taskId`. */
const raiseOpenItemFor = async (
  actionQueue: ActionQueueModule,
  taskId: string,
): Promise<string> =>
  actionQueue.raiseActionQueueItem({
    kind: 'failed',
    category: 'orchestrator',
    priority: 'normal',
    title: `Task ${taskId} needs a human`,
    body: 'stuck',
    payload: {},
    context: { task_id: taskId },
    raisedBy: 'orchestrator:test',
    signature: `sig-${taskId}`,
    originTaskId: taskId,
  })

const publish = async <T extends EventName>(
  pub: PublisherModule,
  client: Client,
  type: T,
  payload: EventPayload<T>,
): Promise<void> => {
  await pub.publishWithRetry(client, type, payload)
}

describe('alert-dismisser outbox subscriber', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('flips an open alert to resolved on a task.terminal{done} event', async () => {
    const { q, actionQueue, ad, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-done'

    const itemId = await raiseOpenItemFor(actionQueue, taskId)

    // Register first (replay: false starts the cursor at the current head),
    // then publish — mirrors the daemon, where the subscriber is registered
    // at boot and transition events arrive afterwards.
    await ad.ensureAlertDismisser(client)
    await publish(pub, client, 'task.terminal', { taskId, reason: 'done' })

    const { processed } = await ad.drainAlertDismissals(client)

    expect(processed).toBe(1)
    const item = await actionQueue.getActionQueueItem(itemId)
    expect(item).not.toBeNull()
    expect(item!.state).toBe('resolved')
  })

  it('KEEPS an open alert on task.terminal{failed} (ADR-0028: failed needs a human)', async () => {
    const { q, actionQueue, ad, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-failed'

    const itemId = await raiseOpenItemFor(actionQueue, taskId)

    await ad.ensureAlertDismisser(client)
    // Both the discrete failure event and the terminal{failed} event must
    // leave the actionable row untouched.
    await publish(pub, client, 'task.failed', { taskId, error: 'boom' })
    await publish(pub, client, 'task.terminal', { taskId, reason: 'failed' })

    const { processed } = await ad.drainAlertDismissals(client)

    // Neither event is a closing trigger, so nothing is processed and the
    // operator's row survives.
    expect(processed).toBe(0)
    expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('open')
  })

  it('clears open alerts on task.terminal{done}, task.terminal{purged}, and task.unblocked', async () => {
    const { q, actionQueue, ad, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const completedId = await raiseOpenItemFor(actionQueue, 'T-completed')
    const purgedId = await raiseOpenItemFor(actionQueue, 'T-purged')
    const unblockedId = await raiseOpenItemFor(actionQueue, 'T-unblocked')

    await ad.ensureAlertDismisser(client)
    await publish(pub, client, 'task.terminal', {
      taskId: 'T-completed',
      reason: 'done',
    })
    await publish(pub, client, 'task.terminal', {
      taskId: 'T-purged',
      reason: 'purged',
    })
    await publish(pub, client, 'task.unblocked', {
      taskId: 'T-unblocked',
      blockerTaskId: 'B-1',
    })

    const { processed } = await ad.drainAlertDismissals(client)

    expect(processed).toBe(3)
    expect((await actionQueue.getActionQueueItem(completedId))!.state).toBe('resolved')
    expect((await actionQueue.getActionQueueItem(purgedId))!.state).toBe('resolved')
    expect((await actionQueue.getActionQueueItem(unblockedId))!.state).toBe('resolved')
  })

  it('treats an unmapped event as a no-op but still advances the cursor', async () => {
    const { q, actionQueue, ad, pub, subs } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const itemId = await raiseOpenItemFor(actionQueue, 'T-prio')

    await ad.ensureAlertDismisser(client)
    await publish(pub, client, 'task.priority_changed', {
      taskId: 'T-prio',
      priority: 2,
    })

    const cursorBefore = await subs.getCursor(
      client,
      ad.ALERT_DISMISSER_SUBSCRIBER,
    )
    const { processed } = await ad.drainAlertDismissals(client)
    const cursorAfter = await subs.getCursor(
      client,
      ad.ALERT_DISMISSER_SUBSCRIBER,
    )

    // No-op processing: the alert stays open, processed excludes it...
    expect(processed).toBe(0)
    expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('open')
    // ...but the cursor moved past the unmapped event so it never stalls.
    expect(cursorAfter).toBeGreaterThan(cursorBefore)
  })

  it('is idempotent: a second drain processes nothing (cursor already past)', async () => {
    const { q, actionQueue, ad, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()

    await raiseOpenItemFor(actionQueue, 'T-once')
    await ad.ensureAlertDismisser(client)
    await publish(pub, client, 'task.terminal', {
      taskId: 'T-once',
      reason: 'done',
    })

    const first = await ad.drainAlertDismissals(client)
    const second = await ad.drainAlertDismissals(client)

    expect(first.processed).toBe(1)
    expect(second.processed).toBe(0)
  })

  // ── Discrete event paths (task.completed / task.dropped / task.queued) ──────
  // These cover the ADR-0028 "closing policy" paths added when the Invalidator
  // was sharpened to handle discrete events alongside the legacy task.terminal
  // path. The race-condition fix (repopulator vs. Invalidator on purge) depends
  // on the Invalidator reliably closing rows when task.dropped arrives — these
  // tests pin that guarantee.

  it('resolves open alert on task.completed (discrete event)', async () => {
    // task.completed fires when a coder merges successfully. The Invalidator
    // must close all open rows so the operator never sees a stale failure alert
    // for work that finished cleanly (ADR-0028).
    const { q, actionQueue, ad, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-completed-discrete'

    const itemId = await raiseOpenItemFor(actionQueue, taskId)
    await ad.ensureAlertDismisser(client)
    await publish(pub, client, 'task.completed', { taskId, result: { status: 'done' } })

    const { processed } = await ad.drainAlertDismissals(client)

    expect(processed).toBe(1)
    expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('resolved')
  })

  it('resolves open alert on task.dropped (non-purge drop reason)', async () => {
    // task.dropped fires when an operator skips/drops a task. The Invalidator
    // must close all open rows for that task (ADR-0028). This covers the
    // discrete-event path that resolveAllRowsForTask handles — distinct from the
    // legacy task.terminal{dropped} path through dismissAlertsOnStatusChange.
    const { q, actionQueue, ad, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-dropped-skip'

    const itemId = await raiseOpenItemFor(actionQueue, taskId)
    await ad.ensureAlertDismisser(client)
    await publish(pub, client, 'task.dropped', { taskId, dropReason: 'user skipped' })

    const { processed } = await ad.drainAlertDismissals(client)

    expect(processed).toBe(1)
    expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('resolved')
  })

  it('resolves open alert on task.dropped{purged} (race-condition guard)', async () => {
    // This is the race-condition path: when a task is purged, dropTask emits
    // task.dropped{dropReason:'purged'} BEFORE deleting the task row. The
    // Invalidator must close any open rows via resolveAllRowsForTask so the
    // repopulator (which also drains task.dropped) cannot create an orphaned
    // row after the Invalidator has already closed its cursor past that event.
    const { q, actionQueue, ad, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-purge-invalidator'

    const itemId = await raiseOpenItemFor(actionQueue, taskId)
    await ad.ensureAlertDismisser(client)
    await publish(pub, client, 'task.dropped', { taskId, dropReason: 'purged' })

    const { processed } = await ad.drainAlertDismissals(client)

    expect(processed).toBe(1)
    expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('resolved')
  })

  it('resolves open alert on task.queued (task restarted/re-queued)', async () => {
    // task.queued fires when a task is re-queued (e.g. mars restart). The
    // Invalidator evicts the stale failure row via dismissAlertsOnStatusChange
    // so an operator does not see a "needs attention" card for a task that is
    // actively running again.
    const { q, actionQueue, ad, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-requeued'

    const itemId = await raiseOpenItemFor(actionQueue, taskId)
    await ad.ensureAlertDismisser(client)
    await publish(pub, client, 'task.queued', { taskId })

    const { processed } = await ad.drainAlertDismissals(client)

    expect(processed).toBe(1)
    expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('resolved')
  })

  // ── Regression: origin_task_id holds proposal id, task id in payload ────────
  // Live bug (row 40827d0c, task mars-de3e00ad): resolveAllRowsForTask used
  // WHERE origin_task_id = :taskId, but origin_task_id held the arc-resolved
  // proposal id while the actual task id lived in payload.taskId.  The UPDATE
  // matched zero rows, leaving a stale "failed task" alert for finished work.
  // Fixed by widening the predicate to also match json_extract(payload,'$.taskId').

  it('resolves a kind=failed row whose origin_task_id is a proposal id but payload.taskId is the task id (regression: leaked alert after task.completed)', async () => {
    const { q, actionQueue, ad, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const taskId = 'task-T-payload-mismatch'
    // Simulate the arc-resolution path: originTaskId is a bare proposal id
    // (not a real task row), so resolveOriginIdForTask passes it through
    // unchanged, giving origin_task_id = proposalId on the persisted row.
    const proposalId = 'proposal-0f54837a-origin'

    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'normal',
      title: `Task ${taskId} needs a human`,
      body: 'stuck',
      payload: { taskId },
      context: { task_id: taskId },
      raisedBy: 'orchestrator:test',
      signature: `sig-${taskId}`,
      originTaskId: proposalId,
    })

    await ad.ensureAlertDismisser(client)
    await publish(pub, client, 'task.completed', {
      taskId,
      result: { status: 'done' },
    })

    const { processed } = await ad.drainAlertDismissals(client)

    expect(processed).toBe(1)
    expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('resolved')
  })

  describe('ADR-0054: task.under_investigation does NOT close the alert (level-triggered)', () => {
    it('updateTask under_investigation inserts a task.under_investigation event in the outbox', async () => {
      // The event is still emitted — it just no longer drives alert dismissal.
      const { q, ad } = await loadModules(repo)
      const client = q.resolveQueueClient()

      const task = await q.enqueueTask('stale worktree task', undefined, { skipTriage: true })
      const taskId = task.id

      await ad.ensureAlertDismisser(client)
      await q.updateTask(taskId, { status: 'under_investigation' })

      const found = await findEventRow(client, 'task.under_investigation', taskId)
      expect(found).toBe(true)
    })

    it('alert stays OPEN when task flips to under_investigation — investigation is an annotation, not an entity mutation', async () => {
      // ADR-0054: the stale-worktree alert is a level-triggered projection.
      // It must clear ONLY when the underlying worktree is actually
      // mutated/removed (entity reaches terminal state), NOT because an
      // operator-investigation annotation was attached.
      const { q, actionQueue, ad, pub } = await loadModules(repo)
      const client = q.resolveQueueClient()

      const task = await q.enqueueTask('stale worktree', undefined, { skipTriage: true })
      const taskId = task.id
      const itemId = await raiseOpenItemFor(actionQueue, taskId)

      await ad.ensureAlertDismisser(client)
      await publish(pub, client, 'task.under_investigation', { taskId })

      // The Invalidator must treat task.under_investigation as a no-op.
      const { processed } = await ad.drainAlertDismissals(client)

      expect(processed).toBe(0)
      const item = await actionQueue.getActionQueueItem(itemId)
      expect(item).not.toBeNull()
      expect(item!.state).toBe('open')
    })

    it('alert DOES close when the entity mutates to done (terminal state clears the row)', async () => {
      // Confirm the positive case: the alert clears when the entity reaches
      // a terminal status, not when the investigation annotation is added.
      const { q, actionQueue, ad, pub } = await loadModules(repo)
      const client = q.resolveQueueClient()

      const task = await q.enqueueTask('stale worktree done', undefined, { skipTriage: true })
      const taskId = task.id
      const itemId = await raiseOpenItemFor(actionQueue, taskId)

      await ad.ensureAlertDismisser(client)

      // Investigation arrives first — alert must stay open.
      await publish(pub, client, 'task.under_investigation', { taskId })
      const afterInvestigation = await ad.drainAlertDismissals(client)
      expect(afterInvestigation.processed).toBe(0)
      expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('open')

      // Entity mutates to done — NOW the alert clears.
      await publish(pub, client, 'task.completed', { taskId, result: { status: 'done' } })
      const afterDone = await ad.drainAlertDismissals(client)
      expect(afterDone.processed).toBe(1)
      expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('resolved')
    })
  })
})
