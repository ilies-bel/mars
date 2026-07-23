/**
 * Tests for the orphaned-chat-run startup sweep.
 *
 * Acceptance criteria:
 *   1. A chat_threads row left at 'running' by a prior daemon crash is flipped
 *      to 'idle' by recoverOrphanedChatRuns (called by the reconciler).
 *   2. An assistant message noting the interruption is appended so the user
 *      sees why their turn produced no reply.
 *   3. Threads already at 'idle' are left untouched.
 *   4. The function returns the count of threads recovered.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

interface ChatStoreMod {
  initChatStore: typeof import('../../lib/chat-store').initChatStore
  createThread: typeof import('../../lib/chat-store').createThread
  getThread: typeof import('../../lib/chat-store').getThread
  setThreadStatus: typeof import('../../lib/chat-store').setThreadStatus
  recoverOrphanedChatRuns: typeof import('../../lib/chat-store').recoverOrphanedChatRuns
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-orphaned-chat-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModule = async (repo: string): Promise<ChatStoreMod> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = (await import('../../lib/chat-store')) as unknown as ChatStoreMod
  await mod.initChatStore()
  return mod
}

describe('recoverOrphanedChatRuns', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('flips a running thread to idle and appends an interrupted-run assistant message', async () => {
    const m = await loadModule(repo)

    // Simulate a thread left at 'running' by a prior daemon crash.
    const thread = await m.createThread('test thread')
    await m.setThreadStatus(thread.id, 'running')

    const recovered = await m.recoverOrphanedChatRuns()

    expect(recovered).toBe(1)

    const result = await m.getThread(thread.id)
    expect(result).not.toBeNull()
    expect(result!.thread.status).toBe('idle')

    // The user should see a message explaining the interruption.
    const assistantMessages = result!.messages.filter((msg) => msg.role === 'assistant')
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1)
    const lastAssistant = assistantMessages[assistantMessages.length - 1]
    expect(lastAssistant!.content).toMatch(/interrupted/)
  })

  it('leaves idle threads untouched', async () => {
    const m = await loadModule(repo)

    const thread = await m.createThread('already idle')
    // Thread starts at 'idle' by default — do not change status.

    const recovered = await m.recoverOrphanedChatRuns()

    expect(recovered).toBe(0)

    const result = await m.getThread(thread.id)
    expect(result!.thread.status).toBe('idle')
    expect(result!.messages).toHaveLength(0)
  })

  it('recovers all running threads and returns the correct count', async () => {
    const m = await loadModule(repo)

    const t1 = await m.createThread('thread one')
    const t2 = await m.createThread('thread two')
    const t3 = await m.createThread('idle thread')

    await m.setThreadStatus(t1.id, 'running')
    await m.setThreadStatus(t2.id, 'running')
    // t3 stays idle.

    const recovered = await m.recoverOrphanedChatRuns()

    expect(recovered).toBe(2)

    const r1 = await m.getThread(t1.id)
    const r2 = await m.getThread(t2.id)
    const r3 = await m.getThread(t3.id)

    expect(r1!.thread.status).toBe('idle')
    expect(r2!.thread.status).toBe('idle')
    expect(r3!.thread.status).toBe('idle')

    // Only the two recovered threads get an assistant message.
    expect(r1!.messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(r2!.messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(r3!.messages.filter((m) => m.role === 'assistant')).toHaveLength(0)
  })
})
