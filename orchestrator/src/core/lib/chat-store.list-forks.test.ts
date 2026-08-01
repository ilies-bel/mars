import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface ChatStoreModule {
  initChatStore: typeof import('./chat-store').initChatStore
  createThread: typeof import('./chat-store').createThread
  forkThread: typeof import('./chat-store').forkThread
  listThreads: typeof import('./chat-store').listThreads
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-chat-list-forks-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModule = async (repo: string): Promise<ChatStoreModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  return (await import('./chat-store')) as unknown as ChatStoreModule
}

describe('listThreads fork filters', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('lists only the direct forks of the requested parent thread', async () => {
    const store = await loadModule(repo)
    await store.initChatStore()
    const parent = await store.createThread('Parent investigation')
    const otherParent = await store.createThread('Another investigation')
    const child = await store.forkThread({
      sourceThreadId: parent.id,
      goal: 'Investigate tangent',
      idempotencyKey: 'child-of-parent',
    })
    await store.forkThread({
      sourceThreadId: otherParent.id,
      goal: 'Other tangent',
      idempotencyKey: 'child-of-other-parent',
    })

    const threads = await store.listThreads({ parentThreadId: parent.id })

    expect(threads.map((thread) => thread.id)).toEqual([child.thread.id])
  })

  it('lists every fork when hasParent is true', async () => {
    const store = await loadModule(repo)
    await store.initChatStore()
    const parent = await store.createThread('Parent investigation')
    const otherParent = await store.createThread('Another investigation')
    const firstFork = await store.forkThread({
      sourceThreadId: parent.id,
      goal: 'First tangent',
      idempotencyKey: 'first-fork',
    })
    const secondFork = await store.forkThread({
      sourceThreadId: otherParent.id,
      goal: 'Second tangent',
      idempotencyKey: 'second-fork',
    })

    const threads = await store.listThreads({ hasParent: true })

    expect(threads.map((thread) => thread.id)).toEqual(
      expect.arrayContaining([firstFork.thread.id, secondFork.thread.id]),
    )
    expect(threads).toHaveLength(2)
  })
})
