import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Client } from '@libsql/client'
import type { EventName, EventPayload } from '../../../bus/events.js'

interface QueueModule {
  initQueue: typeof import('../../queue').initQueue
  getClient: typeof import('../../queue').getClient
}

interface InboxModule {
  raiseInboxItem: typeof import('../../lib/inbox').raiseInboxItem
  getInboxItem: typeof import('../../lib/inbox').getInboxItem
}

interface DismissalsModule {
  dismissEntity: typeof import('../../lib/inbox-dismissals').dismissEntity
  isEntityDismissed: typeof import('../../lib/inbox-dismissals').isEntityDismissed
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
  inbox: InboxModule
  dismissals: DismissalsModule
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
 * `.mars/mars.db`, so the events table (initQueue), inbox_items, and
 * inbox_dismissals all share a single libsql client.
 */
const loadModules = async (repo: string): Promise<Loaded> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const inbox = (await import('../../lib/inbox')) as unknown as InboxModule
  const dismissals = (await import(
    '../../lib/inbox-dismissals'
  )) as unknown as DismissalsModule
  const ad = (await import('../alert-dismisser')) as unknown as AlertDismisserModule
  const pub = (await import('../../../bus/publisher')) as unknown as PublisherModule
  const subs = (await import(
    '../../../bus/subscribers'
  )) as unknown as SubscribersModule
  return { q, inbox, dismissals, ad, pub, subs }
}

/** Raise a single open, origin-keyed inbox item for `taskId`. */
const raiseOpenItemFor = async (
  inbox: InboxModule,
  taskId: string,
): Promise<string> =>
  inbox.raiseInboxItem({
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

const dismissalExists = async (
  client: Client,
  entityId: string,
): Promise<boolean> => {
  const r = await client.execute({
    sql: `SELECT 1 FROM inbox_dismissals WHERE entity_kind = 'task' AND entity_id = ? LIMIT 1`,
    args: [entityId],
  })
  return r.rows.length > 0
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

  it('clears an open alert and the dismissal row on a task.terminal{done} event', async () => {
    const { q, inbox, dismissals, ad, pub } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-done'

    const itemId = await raiseOpenItemFor(inbox, taskId)
    await dismissals.dismissEntity('task', taskId, { by: 'op' })
    expect(await dismissalExists(client, taskId)).toBe(true)

    // Register first (replay: false starts the cursor at the current head),
    // then publish — mirrors the daemon, where the subscriber is registered
    // at boot and transition events arrive afterwards.
    await ad.ensureAlertDismisser(client)
    await publish(pub, client, 'task.terminal', { taskId, reason: 'done' })

    const { processed } = await ad.drainAlertDismissals(client)

    expect(processed).toBe(1)
    const item = await inbox.getInboxItem(itemId)
    expect(item).not.toBeNull()
    expect(item!.state).toBe('resolved')
    expect(await dismissalExists(client, taskId)).toBe(false)
    expect(await dismissals.isEntityDismissed('task', taskId)).toBe(false)
  })

  it('KEEPS an open alert on task.terminal{failed} (ADR-0028: failed needs a human)', async () => {
    const { q, inbox, dismissals, ad, pub } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-failed'

    const itemId = await raiseOpenItemFor(inbox, taskId)
    await dismissals.dismissEntity('task', taskId, { by: 'op' })

    await ad.ensureAlertDismisser(client)
    // Both the discrete failure event and the terminal{failed} event must
    // leave the actionable row untouched.
    await publish(pub, client, 'task.failed', { taskId, error: 'boom' })
    await publish(pub, client, 'task.terminal', { taskId, reason: 'failed' })

    const { processed } = await ad.drainAlertDismissals(client)

    // Neither event is a closing trigger, so nothing is processed and the
    // operator's row + dismissal survive.
    expect(processed).toBe(0)
    expect((await inbox.getInboxItem(itemId))!.state).toBe('open')
    expect(await dismissalExists(client, taskId)).toBe(true)
  })

  it('clears open alerts on task.terminal{done}, task.terminal{purged}, and task.unblocked', async () => {
    const { q, inbox, ad, pub } = await loadModules(repo)
    const client = q.getClient()

    const completedId = await raiseOpenItemFor(inbox, 'T-completed')
    const purgedId = await raiseOpenItemFor(inbox, 'T-purged')
    const unblockedId = await raiseOpenItemFor(inbox, 'T-unblocked')

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
    expect((await inbox.getInboxItem(completedId))!.state).toBe('resolved')
    expect((await inbox.getInboxItem(purgedId))!.state).toBe('resolved')
    expect((await inbox.getInboxItem(unblockedId))!.state).toBe('resolved')
  })

  it('treats an unmapped event as a no-op but still advances the cursor', async () => {
    const { q, inbox, ad, pub, subs } = await loadModules(repo)
    const client = q.getClient()

    const itemId = await raiseOpenItemFor(inbox, 'T-prio')

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
    expect((await inbox.getInboxItem(itemId))!.state).toBe('open')
    // ...but the cursor moved past the unmapped event so it never stalls.
    expect(cursorAfter).toBeGreaterThan(cursorBefore)
  })

  it('is idempotent: a second drain processes nothing (cursor already past)', async () => {
    const { q, inbox, ad, pub } = await loadModules(repo)
    const client = q.getClient()

    await raiseOpenItemFor(inbox, 'T-once')
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
