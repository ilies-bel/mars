/**
 * Invalidator policy tests (ADR-0028): verifies that the alert-dismisser
 * subscriber honours the task-lifecycle clearing rules for the discrete
 * task.completed, task.dropped, and task.failed events.
 *
 * - task.completed  → resolves ALL open rows for the task AND clears the
 *                     dismissal entity row (operator never sees stale alerts
 *                     for finished work).
 * - task.dropped    → same behaviour as task.completed.
 * - task.failed     → NO-OP: the single actionable row stays open so the
 *                     operator can resolve it explicitly; the dismissal row
 *                     is preserved.
 */

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

interface ActionQueueModule {
  raiseActionQueueItem: typeof import('../../lib/action-queue').raiseActionQueueItem
  getActionQueueItem: typeof import('../../lib/action-queue').getActionQueueItem
}

interface DismissalsModule {
  dismissEntity: typeof import('../../lib/action-queue-dismissals').dismissEntity
  isEntityDismissed: typeof import('../../lib/action-queue-dismissals').isEntityDismissed
}

interface AlertDismisserModule {
  ensureAlertDismisser: typeof import('../alert-dismisser').ensureAlertDismisser
  drainAlertDismissals: typeof import('../alert-dismisser').drainAlertDismissals
}

interface PublisherModule {
  publishWithRetry: typeof import('../../../bus/publisher').publishWithRetry
}

interface Loaded {
  q: QueueModule
  actionQueue: ActionQueueModule
  dismissals: DismissalsModule
  ad: AlertDismisserModule
  pub: PublisherModule
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-invalidator-policy-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string): Promise<Loaded> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const actionQueue = (await import(
    '../../lib/action-queue'
  )) as unknown as ActionQueueModule
  const dismissals = (await import(
    '../../lib/action-queue-dismissals'
  )) as unknown as DismissalsModule
  const ad = (await import(
    '../alert-dismisser'
  )) as unknown as AlertDismisserModule
  const pub = (await import(
    '../../../bus/publisher'
  )) as unknown as PublisherModule
  return { q, actionQueue, dismissals, ad, pub }
}

/** Raise a single open, origin-keyed action-queue item for `taskId`. */
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

const dismissalExists = async (
  client: Client,
  entityId: string,
): Promise<boolean> => {
  const r = await client.execute({
    sql: `SELECT 1 FROM action_queue_dismissals WHERE entity_kind = 'task' AND entity_id = ? LIMIT 1`,
    args: [entityId],
  })
  return r.rows.length > 0
}

describe('invalidator policy — discrete lifecycle events', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('task.completed: closes all open rows AND clears the dismissal entity row', async () => {
    const { q, actionQueue, dismissals, ad, pub } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-completed'

    const itemId = await raiseOpenItemFor(actionQueue, taskId)
    await dismissals.dismissEntity('task', taskId, { by: 'op' })
    expect(await dismissalExists(client, taskId)).toBe(true)

    await ad.ensureAlertDismisser(client)
    await publish(pub, client, 'task.completed', { taskId, result: null })

    const { processed } = await ad.drainAlertDismissals(client)

    expect(processed).toBe(1)
    expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('resolved')
    expect(await dismissalExists(client, taskId)).toBe(false)
    expect(await dismissals.isEntityDismissed('task', taskId)).toBe(false)
  })

  it('task.dropped: closes all open rows AND clears the dismissal entity row', async () => {
    const { q, actionQueue, dismissals, ad, pub } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-dropped'

    const itemId = await raiseOpenItemFor(actionQueue, taskId)
    await dismissals.dismissEntity('task', taskId, { by: 'op' })
    expect(await dismissalExists(client, taskId)).toBe(true)

    await ad.ensureAlertDismisser(client)
    await publish(pub, client, 'task.dropped', {
      taskId,
      dropReason: 'operator-dropped',
    })

    const { processed } = await ad.drainAlertDismissals(client)

    expect(processed).toBe(1)
    expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('resolved')
    expect(await dismissalExists(client, taskId)).toBe(false)
    expect(await dismissals.isEntityDismissed('task', taskId)).toBe(false)
  })

  it('task.failed: leaves the actionable row open and preserves the dismissal row (ADR-0028)', async () => {
    const { q, actionQueue, dismissals, ad, pub } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-failed'

    const itemId = await raiseOpenItemFor(actionQueue, taskId)
    await dismissals.dismissEntity('task', taskId, { by: 'op' })

    await ad.ensureAlertDismisser(client)
    await publish(pub, client, 'task.failed', { taskId, error: 'something broke' })

    const { processed } = await ad.drainAlertDismissals(client)

    // task.failed is a NO-OP: one actionable row stays open, dismissal preserved.
    expect(processed).toBe(0)
    expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('open')
    expect(await dismissalExists(client, taskId)).toBe(true)
    expect(await dismissals.isEntityDismissed('task', taskId)).toBe(true)
  })
})
