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
  createAlertThread: typeof import('./chat-store').createAlertThread
  findAlertThreadByItemId: typeof import('./chat-store').findAlertThreadByItemId
  resolveAlertThread: typeof import('./chat-store').resolveAlertThread
  toMessageApiView: typeof import('./chat-store').toMessageApiView
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

const makeAlertSegment = (overrides: Partial<{
  kind: string
  entityId: string
  priority: string
  title: string
  whyNow: string
  actions: Array<{ op: string; label: string; style: 'primary' | 'destructive' | 'default' }>
}> = {}) => ({
  type: 'alert' as const,
  kind: 'failed',
  entityId: 'task-abc',
  priority: 'high',
  title: 'Task failed',
  whyNow: 'The coder exceeded its retry budget.',
  actions: [
    { op: 'restart', label: 'Restart', style: 'primary' as const },
    { op: 'dismiss', label: 'Dismiss', style: 'default' as const },
  ],
  resolved: false,
  ...overrides,
})

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

  // ── alert thread API ────────────────────────────────────────────────────────

  it('createAlertThread stores origin=alert, alert_item_id, and an initial assistant message', async () => {
    const m = await loadModule(repo)
    const seg = makeAlertSegment()
    const thread = await m.createAlertThread('item-1', 'Task failed', seg)

    expect(thread.origin).toBe('alert')
    expect(thread.alert_item_id).toBe('item-1')
    expect(thread.alert_resolved).toBe(false)
    expect(thread.title).toBe('Task failed')

    const detail = await m.getThread(thread.id)
    expect(detail).not.toBeNull()
    expect(detail!.messages).toHaveLength(1)
    const msg = detail!.messages[0]
    expect(msg.role).toBe('assistant')
    const segments = msg.segments as Array<{ type: string }>
    expect(segments).toHaveLength(1)
    expect(segments[0].type).toBe('alert')
  })

  it('findAlertThreadByItemId returns the thread for a known item id', async () => {
    const m = await loadModule(repo)
    const seg = makeAlertSegment()
    const created = await m.createAlertThread('item-2', 'Alert two', seg)

    const found = await m.findAlertThreadByItemId('item-2')
    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
    expect(found!.alert_item_id).toBe('item-2')
  })

  it('findAlertThreadByItemId returns null when no thread exists for the item id', async () => {
    const m = await loadModule(repo)
    const result = await m.findAlertThreadByItemId('no-such-item')
    expect(result).toBeNull()
  })

  it('resolveAlertThread marks the thread resolved and patches the alert segment', async () => {
    const m = await loadModule(repo)
    const seg = makeAlertSegment()
    const thread = await m.createAlertThread('item-3', 'To be resolved', seg)

    const wasResolved = await m.resolveAlertThread('item-3')
    expect(wasResolved).toBe(true)

    const detail = await m.getThread(thread.id)
    expect(detail!.thread.alert_resolved).toBe(true)

    const segments = detail!.messages[0].segments as Array<{ type: string; resolved: boolean }>
    expect(segments[0].resolved).toBe(true)
  })

  it('resolveAlertThread returns false when no unresolved thread exists for the item id', async () => {
    const m = await loadModule(repo)
    const result = await m.resolveAlertThread('ghost-item')
    expect(result).toBe(false)
  })

  it('resolveAlertThread is idempotent: second call returns false', async () => {
    const m = await loadModule(repo)
    const seg = makeAlertSegment()
    await m.createAlertThread('item-4', 'Once', seg)
    expect(await m.resolveAlertThread('item-4')).toBe(true)
    expect(await m.resolveAlertThread('item-4')).toBe(false)
  })

  it('listThreads places unresolved alert-origin threads before regular threads', async () => {
    const m = await loadModule(repo)
    const reg = await m.createThread('regular')
    const seg = makeAlertSegment()
    const alertThread = await m.createAlertThread('item-5', 'Alert', seg)

    const threads = await m.listThreads()
    const ids = threads.map((t) => t.id)
    expect(ids.indexOf(alertThread.id)).toBeLessThan(ids.indexOf(reg.id))
  })

  it('listThreads demotes resolved alert threads below regular threads', async () => {
    const m = await loadModule(repo)
    const seg = makeAlertSegment()
    const alertThread = await m.createAlertThread('item-6', 'Resolved alert', seg)
    await m.resolveAlertThread('item-6')
    const reg = await m.createThread('fresh regular')

    const threads = await m.listThreads()
    const ids = threads.map((t) => t.id)
    // The resolved alert thread should sort after the regular thread (regular sorts by rowid desc)
    expect(ids.indexOf(reg.id)).toBeLessThan(ids.indexOf(alertThread.id))
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
})
