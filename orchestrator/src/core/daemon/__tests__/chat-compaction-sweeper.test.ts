import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { openDb } from '../../lib/db.js'

vi.mock('../codex-api.js', () => ({
  loadCodexAuth: vi.fn(),
  resolveCodexOAuthConfig: vi.fn(),
  streamCodexResponse: vi.fn(),
}))

import * as codexApi from '../codex-api.js'
import { sweepChatCompaction } from '../chat-compaction-sweeper.js'

type DbClient = ReturnType<typeof openDb>

const oldEnough = (): number => Date.now() - 6 * 60_000

async function insertThread(client: DbClient, id: string, status = 'idle'): Promise<void> {
  const updatedAt = oldEnough()
  await client.execute({
    sql: `INSERT INTO chat_threads (id, title, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [id, 'Keep the daemon healthy', status, updatedAt, updatedAt],
  })
}

async function insertMessage(
  client: DbClient,
  id: string,
  threadId: string,
  content: string,
  segments: unknown = null,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO chat_messages (id, thread_id, role, content, segments, created_at)
          VALUES (?, ?, 'user', ?, ?, ?)`,
    args: [id, threadId, content, segments === null ? null : JSON.stringify(segments), oldEnough()],
  })
}

async function messages(client: DbClient, threadId: string): Promise<Array<Record<string, unknown>>> {
  const result = await client.execute({
    sql: `SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC, seq ASC`,
    args: [threadId],
  })
  return result.rows as unknown as Array<Record<string, unknown>>
}

describe('sweepChatCompaction', () => {
  let tmpDir: string
  let dbTarget: string
  let client: DbClient

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-chat-compaction-'))
    dbTarget = resolve(tmpDir, 'test-state')
    client = openDb(dbTarget)
    vi.mocked(codexApi.loadCodexAuth).mockResolvedValue({ accessToken: 'token', accountId: 'account', refreshToken: null })
    vi.mocked(codexApi.resolveCodexOAuthConfig).mockReturnValue({
      baseUrl: 'https://example.test', model: 'gpt-test', effort: 'low', maxToolTurns: 1, requestTimeoutMs: 1_000,
    })
    vi.mocked(codexApi.streamCodexResponse).mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'The daemon health plan was agreed.' }] } })
    })
  })

  afterEach(async () => {
    await client.close()
    rmSync(tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('adds one checkpoint to an idle transcript above the size gate without replacing its messages', async () => {
    await insertThread(client, 'idle-large')
    await insertMessage(client, 'original-message', 'idle-large', 'x'.repeat(30_001))

    const result = await sweepChatCompaction(dbTarget)

    expect(result.compactedThreads).toBe(1)
    const persisted = await messages(client, 'idle-large')
    expect(persisted).toHaveLength(2)
    expect(persisted[0]?.id).toBe('original-message')
    expect(persisted[1]?.role).toBe('assistant')
    expect(JSON.parse(persisted[1]?.segments as string)).toMatchObject([{ type: 'compaction', summary: 'The daemon health plan was agreed.' }])
    expect(codexApi.streamCodexResponse).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.6-luna' }))
  })

  it('does not add a second checkpoint when no messages arrived since the first one', async () => {
    await insertThread(client, 'already-compacted')
    await insertMessage(client, 'original-message', 'already-compacted', 'x'.repeat(30_001))

    await sweepChatCompaction(dbTarget)
    await client.execute({
      sql: `UPDATE chat_threads SET updated_at = ? WHERE id = ?`,
      args: [oldEnough(), 'already-compacted'],
    })

    const result = await sweepChatCompaction(dbTarget)

    expect(result.compactedThreads).toBe(0)
    expect(await messages(client, 'already-compacted')).toHaveLength(2)
    expect(codexApi.streamCodexResponse).toHaveBeenCalledTimes(1)
  })

  it('leaves an idle transcript below the size gate alone', async () => {
    await insertThread(client, 'idle-small')
    await insertMessage(client, 'small-message', 'idle-small', 'A short question.')

    const result = await sweepChatCompaction(dbTarget)

    expect(result.compactedThreads).toBe(0)
    expect(await messages(client, 'idle-small')).toHaveLength(1)
    expect(codexApi.streamCodexResponse).not.toHaveBeenCalled()
  })

  it('never compacts a running thread', async () => {
    await insertThread(client, 'running-large', 'running')
    await insertMessage(client, 'running-message', 'running-large', 'x'.repeat(30_001))

    const result = await sweepChatCompaction(dbTarget)

    expect(result.compactedThreads).toBe(0)
    expect(await messages(client, 'running-large')).toHaveLength(1)
    expect(codexApi.streamCodexResponse).not.toHaveBeenCalled()
  })

  it('leaves a thread untouched when its summary request fails', async () => {
    await insertThread(client, 'failed-summary')
    await insertMessage(client, 'failed-message', 'failed-summary', 'x'.repeat(30_001))
    vi.mocked(codexApi.streamCodexResponse).mockRejectedValueOnce(new Error('provider unavailable'))

    await expect(sweepChatCompaction(dbTarget)).resolves.toEqual({ compactedThreads: 0 })
    expect(await messages(client, 'failed-summary')).toHaveLength(1)
  })

  it('carries structured references from compacted messages onto the checkpoint', async () => {
    await insertThread(client, 'structured-refs')
    await insertMessage(client, 'referenced-message', 'structured-refs', '', [
      { type: 'text', text: 'x'.repeat(30_001) },
      { type: 'task_ref', taskId: 'mars-task-1' },
      { type: 'adr_ref', ref: 'ADR-0099' },
      { type: 'glossary_ref', ref: 'compaction' },
      { type: 'artifact_ref', ref: 'docs/compaction.md' },
    ])

    await sweepChatCompaction(dbTarget)

    const persisted = await messages(client, 'structured-refs')
    expect(JSON.parse(persisted[1]?.segments as string)).toMatchObject([{
      type: 'compaction',
      taskIds: ['mars-task-1'],
      adrRefs: ['ADR-0099'],
      glossaryRefs: ['compaction'],
      artifactRefs: ['docs/compaction.md'],
    }])
  })
})
