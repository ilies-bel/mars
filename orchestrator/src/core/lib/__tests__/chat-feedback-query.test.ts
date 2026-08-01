/**
 * Tests for `loadChatFeedback` in `chat-feedback-query.ts`.
 *
 * Uses the same temp-repo + vi.resetModules() + dynamic-import pattern as
 * the chat-store tests: each test gets a fresh module with its own state
 * client connected to an isolated embedded PostgreSQL (via the Mars test
 * harness). All assertions are on observable return values — no DB internals.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// ── Module-shape types (for dynamic imports) ───────────────────────────────

interface ChatStoreModule {
  initChatStore: typeof import('../chat-store').initChatStore
  createThread: typeof import('../chat-store').createThread
  appendMessage: typeof import('../chat-store').appendMessage
  setMessageFeedback: typeof import('../chat-store').setMessageFeedback
}

interface ChatFeedbackQueryModule {
  loadChatFeedback: typeof import('../chat-feedback-query').loadChatFeedback
}

// ── Repo setup ─────────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-chat-feedback-query-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ cs: ChatStoreModule; cfq: ChatFeedbackQueryModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const cs = (await import('../chat-store')) as unknown as ChatStoreModule
  const cfq = (await import('../chat-feedback-query')) as unknown as ChatFeedbackQueryModule
  return { cs, cfq }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a thread, add a user message then an assistant message, rate it. */
const makeRatedExchange = async (
  cs: ChatStoreModule,
  opts: {
    userContent?: string
    assistantContent?: string
    segments?: unknown
    rating?: 'up' | 'down'
    note?: string | null
    createdAtOffset?: number // seconds to shift created_at for ordering tests
  } = {},
): Promise<{ threadId: string; assistantMsgId: string }> => {
  const thread = await cs.createThread('test thread')
  if (opts.userContent !== undefined) {
    await cs.appendMessage(thread.id, 'user', opts.userContent)
  }
  const assistantMsg = await cs.appendMessage(
    thread.id,
    'assistant',
    opts.assistantContent ?? 'assistant reply',
    opts.segments,
  )
  await cs.setMessageFeedback(assistantMsg.id, opts.rating ?? 'down', opts.note ?? null)
  return { threadId: thread.id, assistantMsgId: assistantMsg.id }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('loadChatFeedback', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns empty array when no feedback exists', async () => {
    const { cs, cfq } = await loadModules(repo)
    await cs.initChatStore()
    const entries = await cfq.loadChatFeedback()
    expect(entries).toHaveLength(0)
  })

  it('returns a rated exchange with correct fields', async () => {
    const { cs, cfq } = await loadModules(repo)
    await cs.initChatStore()
    await makeRatedExchange(cs, {
      userContent: 'what is the capital of France?',
      assistantContent: 'Paris',
      rating: 'up',
      note: 'good answer',
    })

    const entries = await cfq.loadChatFeedback()
    expect(entries).toHaveLength(1)
    const e = entries[0]
    expect(e.rating).toBe('up')
    expect(e.note).toBe('good answer')
    expect(e.userPrompt).toBe('what is the capital of France?')
    expect(e.assistantReply).toBe('Paris')
    expect(e.toolsUsed).toEqual([])
    expect(e.messageId).toBeTruthy()
    expect(e.threadId).toBeTruthy()
    expect(e.createdAt).toBeTruthy()
  })

  it('rating filter — down only', async () => {
    const { cs, cfq } = await loadModules(repo)
    await cs.initChatStore()
    await makeRatedExchange(cs, { rating: 'up', userContent: 'up question' })
    await makeRatedExchange(cs, { rating: 'down', userContent: 'down question' })

    const downOnly = await cfq.loadChatFeedback({ rating: 'down' })
    expect(downOnly).toHaveLength(1)
    expect(downOnly[0].rating).toBe('down')
    expect(downOnly[0].userPrompt).toBe('down question')
  })

  it('rating filter — up only', async () => {
    const { cs, cfq } = await loadModules(repo)
    await cs.initChatStore()
    await makeRatedExchange(cs, { rating: 'up', userContent: 'up question' })
    await makeRatedExchange(cs, { rating: 'down', userContent: 'down question' })

    const upOnly = await cfq.loadChatFeedback({ rating: 'up' })
    expect(upOnly).toHaveLength(1)
    expect(upOnly[0].rating).toBe('up')
  })

  it('respects the limit option', async () => {
    const { cs, cfq } = await loadModules(repo)
    await cs.initChatStore()
    for (let i = 0; i < 5; i++) {
      await makeRatedExchange(cs, { userContent: `question ${i}` })
    }

    const entries = await cfq.loadChatFeedback({ limit: 3 })
    expect(entries).toHaveLength(3)
  })

  it('returns entries newest-first', async () => {
    const { cs, cfq } = await loadModules(repo)
    await cs.initChatStore()
    // Create three rated exchanges — each appendMessage sets a timestamp
    // based on the real wall clock. We rely on sequential inserts having
    // monotonically increasing created_at in the same process.
    await makeRatedExchange(cs, { assistantContent: 'first' })
    await makeRatedExchange(cs, { assistantContent: 'second' })
    await makeRatedExchange(cs, { assistantContent: 'third' })

    const entries = await cfq.loadChatFeedback()
    expect(entries).toHaveLength(3)
    // Newest first: created_at DESC
    const timestampsDesc = entries.map((e) => e.createdAt)
    const sorted = [...timestampsDesc].sort((a, b) => b - a)
    expect(timestampsDesc).toEqual(sorted)
  })

  it('truncates long userPrompt and assistantReply to 1500 chars with ellipsis', async () => {
    const { cs, cfq } = await loadModules(repo)
    await cs.initChatStore()
    const longUser = 'U'.repeat(2000)
    const longAssistant = 'A'.repeat(2000)
    await makeRatedExchange(cs, {
      userContent: longUser,
      assistantContent: longAssistant,
    })

    const entries = await cfq.loadChatFeedback()
    expect(entries).toHaveLength(1)
    const e = entries[0]
    expect(e.userPrompt.length).toBeLessThanOrEqual(1501) // 1500 + ellipsis char
    expect(e.userPrompt.endsWith('…')).toBe(true)
    expect(e.assistantReply.length).toBeLessThanOrEqual(1501)
    expect(e.assistantReply.endsWith('…')).toBe(true)
  })

  it('extracts toolsUsed from tool_use segments in order', async () => {
    const { cs, cfq } = await loadModules(repo)
    await cs.initChatStore()
    const segments = [
      { type: 'tool_use', name: 'Bash', id: 'call-1', input: {} },
      { type: 'text', text: 'here is the result' },
      { type: 'tool_use', name: 'Read', id: 'call-2', input: {} },
    ]
    await makeRatedExchange(cs, { segments })

    const entries = await cfq.loadChatFeedback()
    expect(entries).toHaveLength(1)
    expect(entries[0].toolsUsed).toEqual(['Bash', 'Read'])
  })

  it('returns empty toolsUsed when there are no tool_use segments', async () => {
    const { cs, cfq } = await loadModules(repo)
    await cs.initChatStore()
    const segments = [{ type: 'text', text: 'plain text answer' }]
    await makeRatedExchange(cs, { segments })

    const entries = await cfq.loadChatFeedback()
    expect(entries[0].toolsUsed).toEqual([])
  })

  it('edge case: userPrompt is empty string (not a crash) when the rated reply is the first message in the thread', async () => {
    const { cs, cfq } = await loadModules(repo)
    await cs.initChatStore()
    // No user message before the assistant reply
    const thread = await cs.createThread('first-msg thread')
    const assistantMsg = await cs.appendMessage(
      thread.id,
      'assistant',
      'I am the first message',
    )
    await cs.setMessageFeedback(assistantMsg.id, 'down', null)

    const entries = await cfq.loadChatFeedback()
    expect(entries).toHaveLength(1)
    expect(entries[0].userPrompt).toBe('')
    expect(entries[0].assistantReply).toBe('I am the first message')
  })

  it('pairs the rated reply with the immediately preceding user message, not an earlier one', async () => {
    const { cs, cfq } = await loadModules(repo)
    await cs.initChatStore()
    const thread = await cs.createThread('multi-turn thread')

    // Turn 1
    await cs.appendMessage(thread.id, 'user', 'first user question')
    await cs.appendMessage(thread.id, 'assistant', 'first assistant answer')
    // Turn 2
    await cs.appendMessage(thread.id, 'user', 'second user question')
    const secondAssistant = await cs.appendMessage(
      thread.id,
      'assistant',
      'second assistant answer',
    )
    await cs.setMessageFeedback(secondAssistant.id, 'down', null)

    const entries = await cfq.loadChatFeedback()
    expect(entries).toHaveLength(1)
    // The paired user prompt must be from the second turn, not the first
    expect(entries[0].userPrompt).toBe('second user question')
  })

  it('sinceMs filter excludes older entries', async () => {
    const { cs, cfq } = await loadModules(repo)
    await cs.initChatStore()
    // Create two entries; we can't control timestamps precisely in these
    // tests, so we verify that sinceMs with a far-future date returns nothing.
    await makeRatedExchange(cs, { userContent: 'question' })

    const empty = await cfq.loadChatFeedback({ sinceMs: Date.parse('2099-01-01T00:00:00Z') })
    expect(empty).toHaveLength(0)

    const all = await cfq.loadChatFeedback({ sinceMs: Date.parse('2000-01-01T00:00:00Z') })
    expect(all.length).toBeGreaterThan(0)
  })
})
