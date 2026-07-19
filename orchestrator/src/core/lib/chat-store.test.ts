import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface ChatStoreModule {
  initChatStore: typeof import('./chat-store').initChatStore
  createThread: typeof import('./chat-store').createThread
  listThreads: typeof import('./chat-store').listThreads
  getThread: typeof import('./chat-store').getThread
  appendMessage: typeof import('./chat-store').appendMessage
  updateThreadTitle: typeof import('./chat-store').updateThreadTitle
  deleteThread: typeof import('./chat-store').deleteThread
  setThreadStatus: typeof import('./chat-store').setThreadStatus
  setThreadSession: typeof import('./chat-store').setThreadSession
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-chat-store-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModule = async (repo: string): Promise<ChatStoreModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  return (await import('./chat-store')) as unknown as ChatStoreModule
}

describe('chat-store', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── createThread ────────────────────────────────────────────────────────────

  it('creates a thread with a given title', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread('hello world')
    expect(thread.id).toBeTruthy()
    expect(thread.title).toBe('hello world')
    expect(thread.status).toBe('idle')
    expect(thread.session_id).toBeNull()
    expect(thread.created_at).toBeTruthy()
    expect(thread.updated_at).toBeTruthy()
  })

  it('creates a thread with empty title when none supplied', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    expect(thread.title).toBe('')
  })

  // ── listThreads ─────────────────────────────────────────────────────────────

  it('lists threads newest-first', async () => {
    const m = await loadModule(repo)
    const a = await m.createThread('alpha')
    const b = await m.createThread('beta')
    const threads = await m.listThreads()
    // beta was created after alpha so it should appear first
    expect(threads[0].id).toBe(b.id)
    expect(threads[1].id).toBe(a.id)
  })

  it('returns empty list when no threads exist', async () => {
    const m = await loadModule(repo)
    const threads = await m.listThreads()
    expect(threads).toEqual([])
  })

  it('includes last_message preview as null when thread has no messages', async () => {
    const m = await loadModule(repo)
    await m.createThread('no-messages')
    const threads = await m.listThreads()
    expect(threads[0].last_message).toBeNull()
  })

  it('includes last_message preview with the most recent message content', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread('with messages')
    await m.appendMessage(thread.id, 'user', 'first message')
    await m.appendMessage(thread.id, 'assistant', 'second message')
    const threads = await m.listThreads()
    expect(threads[0].last_message).toBe('second message')
  })

  // ── getThread ───────────────────────────────────────────────────────────────

  it('returns null for a nonexistent thread id', async () => {
    const m = await loadModule(repo)
    const result = await m.getThread('no-such-id')
    expect(result).toBeNull()
  })

  it('returns thread with empty messages array for a thread with no messages', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread('empty')
    const result = await m.getThread(thread.id)
    expect(result).not.toBeNull()
    expect(result!.thread.id).toBe(thread.id)
    expect(result!.messages).toEqual([])
  })

  it('returns messages in chronological order', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread('ordered')
    await m.appendMessage(thread.id, 'user', 'first')
    await m.appendMessage(thread.id, 'assistant', 'second')
    await m.appendMessage(thread.id, 'user', 'third')
    const result = await m.getThread(thread.id)
    expect(result!.messages.map((msg) => msg.content)).toEqual(['first', 'second', 'third'])
  })

  // ── appendMessage ───────────────────────────────────────────────────────────

  it('appends a user message with role and content', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    const msg = await m.appendMessage(thread.id, 'user', 'hello')
    expect(msg.id).toBeTruthy()
    expect(msg.thread_id).toBe(thread.id)
    expect(msg.role).toBe('user')
    expect(msg.content).toBe('hello')
    expect(msg.segments).toBeNull()
    expect(msg.created_at).toBeTruthy()
  })

  it('appends a message with segments JSON', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    const segments = [{ type: 'text', text: 'hi' }]
    const msg = await m.appendMessage(thread.id, 'assistant', 'hi', segments)
    expect(msg.segments).toEqual(segments)
  })

  it('bumps thread updated_at after appending a message', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    const before = thread.updated_at
    // Ensure at least 1ms difference
    await new Promise((r) => setTimeout(r, 2))
    await m.appendMessage(thread.id, 'user', 'bump')
    const result = await m.getThread(thread.id)
    expect(result!.thread.updated_at >= before).toBe(true)
  })

  // ── updateThreadTitle ───────────────────────────────────────────────────────

  it('renames a thread', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread('old')
    await m.updateThreadTitle(thread.id, 'new title')
    const result = await m.getThread(thread.id)
    expect(result!.thread.title).toBe('new title')
  })

  it('is a no-op for a nonexistent thread', async () => {
    const m = await loadModule(repo)
    // Should not throw
    await expect(m.updateThreadTitle('ghost', 'irrelevant')).resolves.toBeUndefined()
  })

  // ── deleteThread ────────────────────────────────────────────────────────────

  it('deletes a thread and its messages', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread('to-delete')
    await m.appendMessage(thread.id, 'user', 'orphan')
    await m.deleteThread(thread.id)
    expect(await m.getThread(thread.id)).toBeNull()
    // The orphan message should also be gone (cascade)
    const threads = await m.listThreads()
    expect(threads.find((t) => t.id === thread.id)).toBeUndefined()
  })

  it('is a no-op when thread does not exist', async () => {
    const m = await loadModule(repo)
    await expect(m.deleteThread('ghost')).resolves.toBeUndefined()
  })

  // ── setThreadStatus ─────────────────────────────────────────────────────────

  it('transitions a thread to running', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    await m.setThreadStatus(thread.id, 'running')
    const result = await m.getThread(thread.id)
    expect(result!.thread.status).toBe('running')
  })

  it('transitions a running thread back to idle', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    await m.setThreadStatus(thread.id, 'running')
    await m.setThreadStatus(thread.id, 'idle')
    const result = await m.getThread(thread.id)
    expect(result!.thread.status).toBe('idle')
  })

  // ── setThreadSession ────────────────────────────────────────────────────────

  it('binds a session id to a thread', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    await m.setThreadSession(thread.id, 'sess-abc')
    const result = await m.getThread(thread.id)
    expect(result!.thread.session_id).toBe('sess-abc')
  })

  it('unbinds a session id (sets to null)', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    await m.setThreadSession(thread.id, 'sess-abc')
    await m.setThreadSession(thread.id, null)
    const result = await m.getThread(thread.id)
    expect(result!.thread.session_id).toBeNull()
  })

  // ── idempotent init ─────────────────────────────────────────────────────────

  it('initChatStore is a no-op when called a second time', async () => {
    const m = await loadModule(repo)
    await m.initChatStore()
    // Second call should not throw or corrupt state
    await m.initChatStore()
    const thread = await m.createThread('after double init')
    expect(thread.title).toBe('after double init')
  })
})
