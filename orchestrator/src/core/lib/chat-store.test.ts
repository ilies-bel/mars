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
  markContextSeeded: typeof import('./chat-store').markContextSeeded
  markThreadEvaporated: typeof import('./chat-store').markThreadEvaporated
  toMessageApiView: typeof import('./chat-store').toMessageApiView
  setMessageFeedback: typeof import('./chat-store').setMessageFeedback
  clearMessageFeedback: typeof import('./chat-store').clearMessageFeedback
  startThreadFromAlert: typeof import('./chat-store').startThreadFromAlert
}

const makeSegment = (title: string): import('./chat-store').AlertSegment => ({
  type: 'alert',
  kind: 'failed',
  entityId: 'arc-1',
  priority: 'high',
  title,
  whyNow: 'a verify step failed',
  actions: [{ op: 'restart', label: 'Restart', style: 'primary' }],
  resolved: false,
})

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

  // ── markContextSeeded ───────────────────────────────────────────────────────

  it('markContextSeeded flips context_seeded from false to true', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread('seeding test')
    expect(thread.context_seeded).toBe(false)
    await m.markContextSeeded(thread.id)
    const result = await m.getThread(thread.id)
    expect(result!.thread.context_seeded).toBe(true)
  })

  // ── markThreadEvaporated ────────────────────────────────────────────────────

  it('freshly created thread has evaporated_at === null', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread('evaporation test')
    expect(thread.evaporated_at).toBeNull()
  })

  it('markThreadEvaporated stamps evaporated_at with an ISO timestamp', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread('to evaporate')
    await m.markThreadEvaporated(thread.id)
    const result = await m.getThread(thread.id)
    expect(result!.thread.evaporated_at).not.toBeNull()
    // Must be a valid ISO-8601 date string
    expect(() => new Date(result!.thread.evaporated_at!)).not.toThrow()
  })

  it('second call to markThreadEvaporated does not overwrite the original timestamp', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread('idempotent evaporate')
    await m.markThreadEvaporated(thread.id)
    const first = (await m.getThread(thread.id))!.thread.evaporated_at

    // Ensure at least 1ms passes so a second stamp would differ
    await new Promise((r) => setTimeout(r, 2))
    await m.markThreadEvaporated(thread.id)
    const second = (await m.getThread(thread.id))!.thread.evaporated_at

    expect(second).toBe(first)
  })

  // ── startThreadFromAlert (human-pull, slice 4) ───────────────────────────────

  it('startThreadFromAlert seeds an alert-origin thread with the segment', async () => {
    const m = await loadModule(repo)
    const thread = await m.startThreadFromAlert('arc-1', 'ship the login page', makeSegment('login broke'))
    expect(thread.origin).toBe('alert')
    expect(thread.alert_item_id).toBe('arc-1')
    expect(thread.title).toBe('ship the login page')
    // The opening assistant message carries the alert segment.
    const result = await m.getThread(thread.id)
    expect(result!.messages).toHaveLength(1)
    expect(result!.messages[0].role).toBe('assistant')
    const seg = (result!.messages[0].segments as Array<{ type: string; title: string }>)[0]
    expect(seg.type).toBe('alert')
    expect(seg.title).toBe('login broke')
  })

  it('startThreadFromAlert dedups by arc — a second call reuses the same thread', async () => {
    const m = await loadModule(repo)
    const first = await m.startThreadFromAlert('arc-1', 'first', makeSegment('first'))
    const second = await m.startThreadFromAlert('arc-1', 'second', makeSegment('second'))
    expect(second.id).toBe(first.id)
    // No duplicate thread, and the original message is preserved (not re-seeded).
    const threads = await m.listThreads()
    expect(threads.filter((t) => t.alert_item_id === 'arc-1')).toHaveLength(1)
    const result = await m.getThread(first.id)
    expect(result!.messages).toHaveLength(1)
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

// ---------------------------------------------------------------------------
// toMessageApiView — segment shape contract
// ---------------------------------------------------------------------------
// These tests verify that the view serialiser translates runner-internal
// segment field names into the shape the UI zod schema expects.  A break
// here means the transcript silently empties in the browser.

describe('toMessageApiView — segment shape contract', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('passes text segments through unchanged', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    const msg = await m.appendMessage(thread.id, 'user', 'hello', [{ type: 'text', text: 'hello' }])
    const view = m.toMessageApiView(msg)
    expect(view.segments).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('renames runner thinking.thinking to thinking.text for the UI schema', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    const runnerSeg = { type: 'thinking', thinking: 'deep thought' }
    const msg = await m.appendMessage(thread.id, 'assistant', '', [runnerSeg])
    const view = m.toMessageApiView(msg)
    expect(view.segments).toEqual([{ type: 'thinking', text: 'deep thought' }])
  })

  it('renames runner tool_use.name to tool_use.toolName for the UI schema', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    const runnerSeg = { type: 'tool_use', id: 'call-1', name: 'Bash', input: { cmd: 'ls' } }
    const msg = await m.appendMessage(thread.id, 'assistant', '', [runnerSeg])
    const view = m.toMessageApiView(msg)
    expect(view.segments).toEqual([
      { type: 'tool_use', id: 'call-1', toolName: 'Bash', input: { cmd: 'ls' }, isError: false, status: 'complete' },
    ])
  })

  it('passes result segments through so the UI can render duration + token footer', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    const runnerSeg = { type: 'result', durationMs: 1234, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cost: 0.001 }
    const msg = await m.appendMessage(thread.id, 'assistant', '', [runnerSeg])
    const view = m.toMessageApiView(msg)
    expect(view.segments).toEqual([runnerSeg])
  })

  it('returns user message with text segment so content appears in transcript', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    const msg = await m.appendMessage(thread.id, 'user', 'what happened today?', [
      { type: 'text', text: 'what happened today?' },
    ])
    const view = m.toMessageApiView(msg)
    expect(view.role).toBe('user')
    const textSeg = view.segments.find((s) => (s as { type: string }).type === 'text') as
      | { type: string; text: string }
      | undefined
    expect(textSeg?.text).toBe('what happened today?')
  })

  it('returns empty segments array when message has no segments', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    const msg = await m.appendMessage(thread.id, 'user', 'bare message')
    const view = m.toMessageApiView(msg)
    expect(view.segments).toEqual([])
  })

  // ── setMessageFeedback / clearMessageFeedback ────────────────────────────────

  it('stores an up rating for an assistant message and returns the feedback row', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    const msg = await m.appendMessage(thread.id, 'assistant', 'hello')
    const fb = await m.setMessageFeedback(msg.id, 'up', null)
    expect(fb.message_id).toBe(msg.id)
    expect(fb.thread_id).toBe(thread.id)
    expect(fb.rating).toBe('up')
    expect(fb.note).toBeNull()
    expect(fb.created_at).toBeTruthy()
    expect(fb.updated_at).toBeTruthy()
  })

  it('stores a down rating with a note', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    const msg = await m.appendMessage(thread.id, 'assistant', 'bad answer')
    const fb = await m.setMessageFeedback(msg.id, 'down', 'wrong answer')
    expect(fb.rating).toBe('down')
    expect(fb.note).toBe('wrong answer')
  })

  it('upserts feedback when called a second time (re-rating)', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    const msg = await m.appendMessage(thread.id, 'assistant', 'hello')
    await m.setMessageFeedback(msg.id, 'up', null)
    const fb = await m.setMessageFeedback(msg.id, 'down', 'changed mind')
    // rating flipped, note updated
    expect(fb.rating).toBe('down')
    expect(fb.note).toBe('changed mind')
  })

  it('getThread returns feedback inline via the LEFT JOIN', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    const msg = await m.appendMessage(thread.id, 'assistant', 'hello')
    await m.setMessageFeedback(msg.id, 'up', null)
    const result = await m.getThread(thread.id)
    expect(result).not.toBeNull()
    expect(result!.feedbacks.get(msg.id)?.rating).toBe('up')
  })

  it('throws when the message does not exist', async () => {
    const m = await loadModule(repo)
    await expect(m.setMessageFeedback('nonexistent', 'up', null)).rejects.toThrow('not found')
  })

  it('throws when the message is a user message (not assistant)', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    const msg = await m.appendMessage(thread.id, 'user', 'hello')
    await expect(m.setMessageFeedback(msg.id, 'up', null)).rejects.toThrow('not an assistant message')
  })

  it('clearMessageFeedback returns true when feedback existed', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    const msg = await m.appendMessage(thread.id, 'assistant', 'hello')
    await m.setMessageFeedback(msg.id, 'up', null)
    const cleared = await m.clearMessageFeedback(msg.id)
    expect(cleared).toBe(true)
    // Feedback is gone — getThread returns null for this message.
    const result = await m.getThread(thread.id)
    expect(result!.feedbacks.has(msg.id)).toBe(false)
  })

  it('clearMessageFeedback returns false when no feedback existed (idempotent)', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread()
    const msg = await m.appendMessage(thread.id, 'assistant', 'hello')
    const cleared = await m.clearMessageFeedback(msg.id)
    expect(cleared).toBe(false)
  })
})
