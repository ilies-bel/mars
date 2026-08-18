import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Client } from '@libsql/client'

/**
 * ADR-0032 stall contract for the shared drainWithStall helper: a handler
 * that throws blocks the subscriber's cursor on the failing event, retries
 * on every wake, surfaces a subscriber-stalled action-queue item after K
 * consecutive failures, and withdraws it once the event finally processes.
 *
 * Per ADR-0057 `subscriber-stalled` is a derived condition kind — there is no
 * stored action_queue_items row. These tests therefore assert on the operator
 * surface itself (the derived condition source), not on any table.
 */

interface Loaded {
  q: typeof import('../../queue')
  actionQueue: typeof import('../../lib/action-queue')
  drain: typeof import('../subscriber-drain')
  subs: typeof import('../../../bus/subscribers')
  pub: typeof import('../../../bus/publisher')
  conditions: typeof import('../view/derived-conditions')
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-stall-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const load = async (repo: string): Promise<Loaded> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = await import('../../queue')
  await q.migrateQueueSchema()
  const actionQueue = await import('../../lib/action-queue')
  const drain = await import('../subscriber-drain')
  const subs = await import('../../../bus/subscribers')
  const pub = await import('../../../bus/publisher')
  const conditions = await import('../view/derived-conditions')
  return { q, actionQueue, drain, subs, pub, conditions }
}

const SUB = 'test-stall-subscriber'

/**
 * Count the `subscriber-stalled` items an operator would actually see. Goes
 * through the derived condition source rather than any table, so the assertion
 * survives a change of where the stall state is kept.
 */
const openStalledCount = async (
  conditions: Loaded['conditions'],
  client: Client,
): Promise<number> => {
  const source = conditions.createConditionItemsSource({ getClient: () => client })
  const rows = await source.derive({ kinds: new Set(['subscriber-stalled']) })
  return rows.length
}


describe('drainWithStall — ADR-0032', () => {
  let repo: string
  beforeEach(() => {
    repo = setupRepo()
  })
  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('blocks the cursor on a throwing handler and raises a stalled row after K failures, then recovers', async () => {
    const { q, actionQueue, drain, subs, pub, conditions } = await load(repo)
    const client = q.resolveQueueClient()

    await actionQueue.initActionQueue()
    await subs.registerSubscriber(client, SUB, { replay: false })
    await pub.publishWithRetry(client, 'task.queued', { taskId: 'X-1' })
    const cursorStart = await subs.getCursor(client, SUB)

    // Handler throws for the first 3 drains, then succeeds.
    // Only react to the target event; ignore unrelated events (e.g. the
    // actionQueue.raised event our own stall-row raise appends to the outbox),
    // exactly as a real subscriber's matcher would.
    let attempts = 0
    const handle = async (event: { type: string }): Promise<boolean> => {
      if (event.type !== 'task.queued') return false
      attempts += 1
      if (attempts <= drain.STALL_THRESHOLD) throw new Error('boom')
      return true
    }

    // Drains 1 and 2: cursor stays blocked, no stalled row yet.
    await drain.drainWithStall({ client, subscriberId: SUB, handle })
    expect(await subs.getCursor(client, SUB)).toBe(cursorStart)
    expect(await openStalledCount(conditions, client)).toBe(0)
    await drain.drainWithStall({ client, subscriberId: SUB, handle })
    expect(await openStalledCount(conditions, client)).toBe(0)

    // Drain 3: K-th consecutive failure → stalled row raised, cursor still blocked.
    await drain.drainWithStall({ client, subscriberId: SUB, handle })
    expect(await subs.getCursor(client, SUB)).toBe(cursorStart)
    expect(await openStalledCount(conditions, client)).toBe(1)

    // Drain 4: handler now succeeds → cursor advances, stalled row superseded.
    const { processed } = await drain.drainWithStall({
      client,
      subscriberId: SUB,
      handle,
    })
    expect(processed).toBe(1)
    expect(await subs.getCursor(client, SUB)).toBeGreaterThan(cursorStart)
    expect(await openStalledCount(conditions, client)).toBe(0)
  })

  it('closes a stalled row when the event succeeds in a fresh drain with empty failureCounts (post-restart scenario)', async () => {
    // Phase 1: raise a subscriber-stalled row via K consecutive failures.
    const { q, actionQueue, drain, subs, pub, conditions } = await load(repo)
    const client = q.resolveQueueClient()

    await actionQueue.initActionQueue()
    await subs.registerSubscriber(client, SUB, { replay: false })
    await pub.publishWithRetry(client, 'task.queued', { taskId: 'X-3' })

    for (let i = 0; i < drain.STALL_THRESHOLD; i++) {
      await drain.drainWithStall({
        client,
        subscriberId: SUB,
        handle: async (event: { type: string }): Promise<boolean> => {
          if (event.type !== 'task.queued') return false
          throw new Error('simulated failure')
        },
      })
    }

    expect(await openStalledCount(conditions, client)).toBe(1)

    // Phase 2: simulate a daemon restart by resetting module state (clears the
    // in-memory failureCounts Map), then drain successfully. The stalled row
    // must be closed even though failureCounts is empty in the new process.
    const reloaded = await load(repo)
    const client2 = reloaded.q.resolveQueueClient()

    await reloaded.drain.drainWithStall({
      client: client2,
      subscriberId: SUB,
      handle: async (event: { type: string }): Promise<boolean> => {
        if (event.type !== 'task.queued') return false
        return true
      },
    })

    expect(await openStalledCount(reloaded.conditions, client2)).toBe(0)
  })

  it('a healthy subscriber advances its cursor and raises nothing', async () => {
    const { q, actionQueue, drain, subs, pub, conditions } = await load(repo)
    const client = q.resolveQueueClient()

    await actionQueue.initActionQueue()
    await subs.registerSubscriber(client, SUB, { replay: false })
    await pub.publishWithRetry(client, 'task.queued', { taskId: 'X-2' })
    const before = await subs.getCursor(client, SUB)

    const { processed } = await drain.drainWithStall({
      client,
      subscriberId: SUB,
      handle: async () => true,
    })
    expect(processed).toBe(1)
    expect(await subs.getCursor(client, SUB)).toBeGreaterThan(before)
    expect(await openStalledCount(conditions, client)).toBe(0)
  })
})
