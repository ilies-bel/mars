import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Client } from '@libsql/client'

/**
 * ADR-0032 stall contract for the shared drainWithStall helper: a handler
 * that throws blocks the subscriber's cursor on the failing event, retries
 * on every wake, raises a subscriber-stalled actionQueue row after K consecutive
 * failures, and supersedes that row once the event finally processes.
 */

interface Loaded {
  q: typeof import('../../queue')
  actionQueue: typeof import('../../lib/action-queue')
  drain: typeof import('../subscriber-drain')
  subs: typeof import('../../../bus/subscribers')
  pub: typeof import('../../../bus/publisher')
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
  return { q, actionQueue, drain, subs, pub }
}

const SUB = 'test-stall-subscriber'

const openStalledCount = async (client: Client): Promise<number> => {
  const r = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM action_queue_items WHERE kind = 'subscriber-stalled' AND state = 'open'`,
  })
  return Number((r.rows[0] as unknown as { n: number | bigint }).n)
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
    const { q, actionQueue, drain, subs, pub } = await load(repo)
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
    expect(await openStalledCount(client)).toBe(0)
    await drain.drainWithStall({ client, subscriberId: SUB, handle })
    expect(await openStalledCount(client)).toBe(0)

    // Drain 3: K-th consecutive failure → stalled row raised, cursor still blocked.
    await drain.drainWithStall({ client, subscriberId: SUB, handle })
    expect(await subs.getCursor(client, SUB)).toBe(cursorStart)
    expect(await openStalledCount(client)).toBe(1)

    // Drain 4: handler now succeeds → cursor advances, stalled row superseded.
    const { processed } = await drain.drainWithStall({
      client,
      subscriberId: SUB,
      handle,
    })
    expect(processed).toBe(1)
    expect(await subs.getCursor(client, SUB)).toBeGreaterThan(cursorStart)
    expect(await openStalledCount(client)).toBe(0)
  })

  it('a healthy subscriber advances its cursor and raises nothing', async () => {
    const { q, actionQueue, drain, subs, pub } = await load(repo)
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
    expect(await openStalledCount(client)).toBe(0)
  })
})
