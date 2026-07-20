import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type DbClient } from '../../core/lib/db.js'
import { ensureSchema } from '../../core/lib/pg-schema.js'
import { publishWithRetry } from '../publisher.js'
import {
  registerSubscriber,
  getCursor,
  advanceCursor,
  fetchPending,
} from '../subscribers.js'

let dbSeq = 0

/**
 * Fresh in-memory PGlite instance per test carrying the canonical schema
 * (`events` + `subscribers`; MARS_DB_BACKEND=pglite is set by
 * test/setup-env.ts, the target string is only an identity key).
 */
async function makeClient(): Promise<DbClient> {
  const client = openDb(`test:subscribers:${process.pid}:${dbSeq++}`)
  await ensureSchema(client)
  return client
}

describe('Subscriber cursor registry', () => {
  let client: DbClient

  beforeEach(async () => {
    client = await makeClient()
  })

  afterEach(async () => {
    await client.close()
  })

  it('initialises a new Subscriber to the current head — observes zero historical events', async () => {
    // Seed the outbox with three events.
    await publishWithRetry(client, 'task.queued', { taskId: 'h1' })
    await publishWithRetry(client, 'task.queued', { taskId: 'h2' })
    await publishWithRetry(client, 'task.queued', { taskId: 'h3' })

    await registerSubscriber(client, 'tail-only')

    const pending = await fetchPending(client, 'tail-only')
    expect(pending).toHaveLength(0)
  })

  it('resumes from a previously advanced cursor after re-instantiation', async () => {
    await publishWithRetry(client, 'task.queued', { taskId: 'a' })
    await publishWithRetry(client, 'task.queued', { taskId: 'b' })

    // First "instance" registers with replay so it sees a,b, then
    // acknowledges only the first event.
    await registerSubscriber(client, 'resumer', { replay: true })
    const firstPass = await fetchPending(client, 'resumer')
    expect(firstPass).toHaveLength(2)
    await advanceCursor(client, 'resumer', firstPass[0].id)

    // Simulate restart by re-registering. A new event arrives in between.
    await publishWithRetry(client, 'task.queued', { taskId: 'c' })
    await registerSubscriber(client, 'resumer')

    const resumed = await fetchPending(client, 'resumer')
    const taskIds = resumed.map(e => (e.payload as { taskId: string }).taskId)
    expect(taskIds).toEqual(['b', 'c'])
  })

  it('does not reset the cursor on re-registration', async () => {
    await publishWithRetry(client, 'task.queued', { taskId: 'x' })
    await registerSubscriber(client, 'sticky', { replay: true })

    const pending = await fetchPending(client, 'sticky')
    await advanceCursor(client, 'sticky', pending[0].id)
    const cursorBefore = await getCursor(client, 'sticky')

    // Re-register, even with replay flipped — must not touch cursor.
    await registerSubscriber(client, 'sticky', { replay: true })
    await registerSubscriber(client, 'sticky')

    const cursorAfter = await getCursor(client, 'sticky')
    expect(cursorAfter).toBe(cursorBefore)
    expect(cursorAfter).toBeGreaterThan(0)
  })

  it('replay-mode Subscriber starts at cursor 0 and observes the full history', async () => {
    await publishWithRetry(client, 'task.queued', { taskId: 'r1' })
    await publishWithRetry(client, 'task.queued', { taskId: 'r2' })
    await publishWithRetry(client, 'task.queued', { taskId: 'r3' })

    await registerSubscriber(client, 'replayer', { replay: true })

    expect(await getCursor(client, 'replayer')).toBe(0)

    const pending = await fetchPending(client, 'replayer')
    const taskIds = pending.map(e => (e.payload as { taskId: string }).taskId)
    expect(taskIds).toEqual(['r1', 'r2', 'r3'])
  })
})
