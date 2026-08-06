/**
 * Inline narration subscriber — behaviour tests.
 *
 * The central criterion: with presence=present the subscriber writes one
 * `inline_event` row per narratable event; with presence=away it writes none
 * for the same event stream.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DbClient } from '../lib/db.js'
import type { PresenceMode } from './inlineNarration.js'

// ── helpers ──────────────────────────────────────────────────────────────────

const openFreshDb = async (dir: string): Promise<DbClient> => {
  const { openDb } = await import('../lib/db.js')
  return openDb(join(dir, 'db'))
}

const publishTerminal = async (
  client: DbClient,
  taskId: string,
  reason: 'done' | 'failed',
): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO events (type, payload, ts) VALUES (?, ?, ?)`,
    args: ['task.terminal', JSON.stringify({ taskId, reason }), Date.now()],
  })
}

const publishBlocked = async (client: DbClient, taskId: string): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO events (type, payload, ts) VALUES (?, ?, ?)`,
    args: [
      'task.blocked',
      JSON.stringify({ taskId, fixTaskId: null, failureSignature: 'verify:has-diff', failingStep: 'verify' }),
      Date.now(),
    ],
  })
}

const countInlineEvents = async (client: DbClient): Promise<number> => {
  const result = await client.execute(
    `SELECT COUNT(*) AS n FROM chat_messages WHERE kind = 'inline_event'`,
  )
  return Number((result.rows[0] as Record<string, unknown>).n)
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('inlineNarration subscriber', () => {
  let tmpDir: string
  let client: DbClient
  let sub: typeof import('./inlineNarration.js')

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-inline-narration-test-'))
    client = await openFreshDb(tmpDir)
    sub = await import('./inlineNarration.js')
    await sub.ensureInlineNarration(client)
  })

  afterEach(async () => {
    await client.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes one inline_event row per narratable event when presence is present', async () => {
    await publishTerminal(client, 'task-1', 'done')
    await publishTerminal(client, 'task-2', 'failed')
    await publishBlocked(client, 'task-3')

    const { processed } = await sub.drainInlineNarration(client, async () => 'present')

    expect(processed).toBe(3)
    expect(await countInlineEvents(client)).toBe(3)
  })

  it('writes no inline_event rows when presence is away', async () => {
    await publishTerminal(client, 'task-1', 'done')
    await publishTerminal(client, 'task-2', 'failed')
    await publishBlocked(client, 'task-3')

    const { processed } = await sub.drainInlineNarration(client, async () => 'away')

    expect(processed).toBe(0)
    expect(await countInlineEvents(client)).toBe(0)
  })

  it('skips non-narratable events without writing rows', async () => {
    await client.execute({
      sql: `INSERT INTO events (type, payload, ts) VALUES (?, ?, ?)`,
      args: ['task.created', JSON.stringify({ taskId: 'task-1', title: 'Test task' }), Date.now()],
    })

    await sub.drainInlineNarration(client, async () => 'present')

    expect(await countInlineEvents(client)).toBe(0)
  })

  it('proves that the same event stream produces 0 rows when away and N rows when present', async () => {
    // Run 1: away — no rows written, cursor advances
    const presentTmpDir = mkdtempSync(join(tmpdir(), 'mars-inline-narration-present-'))
    const presentClient = await openFreshDb(presentTmpDir)
    try {
      await sub.ensureInlineNarration(presentClient)

      // Same three events in each fresh DB
      const seedEvents = async (c: DbClient): Promise<void> => {
        await publishTerminal(c, 'task-a', 'done')
        await publishTerminal(c, 'task-b', 'failed')
        await publishBlocked(c, 'task-c')
      }

      await seedEvents(client)
      await seedEvents(presentClient)

      await sub.drainInlineNarration(client, async (): Promise<PresenceMode> => 'away')
      await sub.drainInlineNarration(presentClient, async (): Promise<PresenceMode> => 'present')

      const awayCount = await countInlineEvents(client)
      const presentCount = await countInlineEvents(presentClient)

      expect(awayCount).toBe(0)
      expect(presentCount).toBe(3)
    } finally {
      await presentClient.close()
      rmSync(presentTmpDir, { recursive: true, force: true })
    }
  })
})
