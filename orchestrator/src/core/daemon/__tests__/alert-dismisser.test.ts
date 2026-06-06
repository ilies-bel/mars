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
})
