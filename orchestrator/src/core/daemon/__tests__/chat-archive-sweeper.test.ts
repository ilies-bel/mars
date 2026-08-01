/**
 * Behaviour tests for the chat archive sweeper.
 *
 * Acceptance criteria:
 *   1. Evaporated threads older than the retention window are permanently deleted.
 *   2. Their chat_messages rows are deleted (and chat_feedback cascades).
 *   3. Evaporated threads within the retention window survive (History accordion).
 *   4. Active (non-evaporated) threads are never touched.
 *   5. Upload directories (.mars/chat-uploads/<threadId>/) are removed for
 *      deleted threads.
 *   6. Upload directories for surviving threads are left intact.
 *   7. The result reports accurate counts (deletedThreads, deletedUploadDirs).
 *   8. A sweep with nothing to delete returns zero counts without error.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../../lib/db.js'
import { sweepChatArchive, CHAT_ARCHIVE_RETENTION_DAYS } from '../chat-archive-sweeper.js'

// ── helpers ──────────────────────────────────────────────────────────────────

type DbClient = ReturnType<typeof openDb>

function daysAgo(n: number): number {
  return Date.now() - n * 24 * 60 * 60 * 1000
}

async function insertThread(
  client: DbClient,
  id: string,
  evaporatedAt: number | null,
): Promise<void> {
  const ts = Date.now()
  await client.execute({
    sql: `INSERT INTO chat_threads (id, title, status, created_at, updated_at, evaporated_at)
          VALUES (?, ?, 'idle', ?, ?, ?)`,
    args: [id, `Thread ${id}`, ts, ts, evaporatedAt],
  })
}

async function insertMessage(client: DbClient, id: string, threadId: string): Promise<void> {
  const ts = Date.now()
  await client.execute({
    sql: `INSERT INTO chat_messages (id, thread_id, role, content, created_at)
          VALUES (?, ?, 'user', 'hello', ?)`,
    args: [id, threadId, ts],
  })
}

async function threadExists(client: DbClient, id: string): Promise<boolean> {
  const r = await client.execute({
    sql: `SELECT 1 FROM chat_threads WHERE id = ?`,
    args: [id],
  })
  return r.rows.length > 0
}

async function messageCount(client: DbClient, threadId: string): Promise<number> {
  const r = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id = ?`,
    args: [threadId],
  })
  return Number((r.rows[0] as unknown as { n: number | bigint }).n)
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('sweepChatArchive', () => {
  let tmpDir: string
  let dbTarget: string
  let uploadsRoot: string
  let client: DbClient

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-chat-archive-'))
    dbTarget = resolve(tmpDir, 'test-state')
    uploadsRoot = resolve(tmpDir, 'chat-uploads')
    mkdirSync(uploadsRoot, { recursive: true })
    // openDb auto-applies the schema (ensureSchema) on first execute
    client = openDb(dbTarget)
  })

  afterEach(async () => {
    await client.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('deletes evaporated threads past the retention window', async () => {
    const expiredId = 'expired-thread'
    await insertThread(client, expiredId, daysAgo(CHAT_ARCHIVE_RETENTION_DAYS + 1))

    const result = await sweepChatArchive(dbTarget, uploadsRoot)

    expect(result.deletedThreads).toBe(1)
    expect(await threadExists(client, expiredId)).toBe(false)
  })

  it('preserves evaporated threads within the retention window', async () => {
    const recentId = 'recent-evaporated'
    await insertThread(client, recentId, daysAgo(1))

    const result = await sweepChatArchive(dbTarget, uploadsRoot)

    expect(result.deletedThreads).toBe(0)
    expect(await threadExists(client, recentId)).toBe(true)
  })

  it('never deletes active (non-evaporated) threads', async () => {
    const activeId = 'active-thread'
    await insertThread(client, activeId, null)

    const result = await sweepChatArchive(dbTarget, uploadsRoot)

    expect(result.deletedThreads).toBe(0)
    expect(await threadExists(client, activeId)).toBe(true)
  })

  it('deletes messages belonging to expired threads', async () => {
    const expiredId = 'expired-with-messages'
    await insertThread(client, expiredId, daysAgo(CHAT_ARCHIVE_RETENTION_DAYS + 1))
    await insertMessage(client, 'msg-1', expiredId)
    await insertMessage(client, 'msg-2', expiredId)

    await sweepChatArchive(dbTarget, uploadsRoot)

    expect(await messageCount(client, expiredId)).toBe(0)
  })

  it('leaves messages of surviving threads intact', async () => {
    const recentId = 'recent-evaporated-with-msgs'
    await insertThread(client, recentId, daysAgo(1))
    await insertMessage(client, 'msg-recent-1', recentId)

    await sweepChatArchive(dbTarget, uploadsRoot)

    expect(await messageCount(client, recentId)).toBe(1)
  })

  it('removes the upload directory for an expired thread', async () => {
    const expiredId = 'expired-with-uploads'
    await insertThread(client, expiredId, daysAgo(CHAT_ARCHIVE_RETENTION_DAYS + 5))

    // Create a fake upload directory and file
    const uploadDir = resolve(uploadsRoot, expiredId)
    mkdirSync(uploadDir, { recursive: true })
    writeFileSync(resolve(uploadDir, 'image.png'), 'fake-image-data')

    const result = await sweepChatArchive(dbTarget, uploadsRoot)

    expect(result.deletedUploadDirs).toBe(1)
    // The directory should be gone
    const { existsSync } = await import('node:fs')
    expect(existsSync(uploadDir)).toBe(false)
  })

  it('does not count upload dirs that never existed', async () => {
    const expiredId = 'expired-no-uploads'
    await insertThread(client, expiredId, daysAgo(CHAT_ARCHIVE_RETENTION_DAYS + 1))
    // No upload directory created

    const result = await sweepChatArchive(dbTarget, uploadsRoot)

    expect(result.deletedThreads).toBe(1)
    expect(result.deletedUploadDirs).toBe(0)
  })

  it('leaves upload dirs for surviving evaporated threads intact', async () => {
    const recentId = 'recent-with-uploads'
    await insertThread(client, recentId, daysAgo(1))

    const uploadDir = resolve(uploadsRoot, recentId)
    mkdirSync(uploadDir, { recursive: true })
    writeFileSync(resolve(uploadDir, 'file.txt'), 'data')

    const result = await sweepChatArchive(dbTarget, uploadsRoot)

    expect(result.deletedUploadDirs).toBe(0)
    const { existsSync } = await import('node:fs')
    expect(existsSync(uploadDir)).toBe(true)
  })

  it('handles a mix: deletes expired, preserves recent and active', async () => {
    const expiredId = 'expired'
    const recentEvapId = 'recent-evap'
    const activeId = 'active'

    await insertThread(client, expiredId, daysAgo(CHAT_ARCHIVE_RETENTION_DAYS + 10))
    await insertThread(client, recentEvapId, daysAgo(5))
    await insertThread(client, activeId, null)

    await insertMessage(client, 'e-msg', expiredId)

    // Upload dir only for expired
    const expiredUploadDir = resolve(uploadsRoot, expiredId)
    mkdirSync(expiredUploadDir, { recursive: true })

    const result = await sweepChatArchive(dbTarget, uploadsRoot)

    expect(result.deletedThreads).toBe(1)
    expect(result.deletedUploadDirs).toBe(1)

    expect(await threadExists(client, expiredId)).toBe(false)
    expect(await threadExists(client, recentEvapId)).toBe(true)
    expect(await threadExists(client, activeId)).toBe(true)
    expect(await messageCount(client, expiredId)).toBe(0)
  })

  it('returns zero counts when there is nothing to sweep', async () => {
    const result = await sweepChatArchive(dbTarget, uploadsRoot)

    expect(result.deletedThreads).toBe(0)
    expect(result.deletedUploadDirs).toBe(0)
  })

  it('respects a custom retention window', async () => {
    const threadId = 'custom-window'
    // Evaporated 3 days ago
    await insertThread(client, threadId, daysAgo(3))

    // With a 1-day window, this is past retention
    const result = await sweepChatArchive(dbTarget, uploadsRoot, 1)

    expect(result.deletedThreads).toBe(1)
    expect(await threadExists(client, threadId)).toBe(false)
  })
})
