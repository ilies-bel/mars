import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface ChatStoreModule {
  initChatStore: typeof import('../chat-store').initChatStore
  createThread: typeof import('../chat-store').createThread
  forkThread: typeof import('../chat-store').forkThread
  startThreadFromAlert: typeof import('../chat-store').startThreadFromAlert
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-chat-fork-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModule = async (repo: string): Promise<ChatStoreModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  return (await import('../chat-store')) as unknown as ChatStoreModule
}

const makeSegment = (title: string): import('../chat-store').AlertSegment => ({
  type: 'alert',
  kind: 'failed',
  entityId: 'arc-1',
  priority: 'high',
  title,
  whyNow: 'a verify step failed',
  actions: [{ op: 'restart', label: 'Restart', style: 'primary' }],
  resolved: false,
})

describe('forkThread', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('forks a user thread with parent link and origin=null', async () => {
    const m = await loadModule(repo)
    await m.initChatStore()
    const parent = await m.createThread('parent thread')
    const { thread, deduped } = await m.forkThread({
      sourceThreadId: parent.id,
      goal: 'explore side topic',
      idempotencyKey: 'fork-1',
    })
    expect(deduped).toBe(false)
    expect(thread.parent_thread_id).toBe(parent.id)
    expect(thread.fork_idempotency_key).toBe('fork-1')
    expect(thread.title).toBe('explore side topic')
    expect(thread.origin).toBeNull()
    expect(thread.alert_item_id).toBeNull()
    expect(thread.status).toBe('idle')
  })

  it('forks an alert thread → new thread has origin=null', async () => {
    const m = await loadModule(repo)
    await m.initChatStore()
    const alertThread = await m.startThreadFromAlert(
      'arc-test-1',
      'Alert: task failed',
      makeSegment('Alert: task failed'),
    )
    expect(alertThread.origin).toBe('alert')
    const { thread } = await m.forkThread({
      sourceThreadId: alertThread.id,
      goal: 'investigate root cause',
      idempotencyKey: 'fork-alert-1',
    })
    expect(thread.origin).toBeNull()
    expect(thread.alert_item_id).toBeNull()
    expect(thread.parent_thread_id).toBe(alertThread.id)
  })

  it('deduplicates forks with the same idempotencyKey', async () => {
    const m = await loadModule(repo)
    await m.initChatStore()
    const parent = await m.createThread('parent')
    const first = await m.forkThread({
      sourceThreadId: parent.id,
      goal: 'side topic',
      idempotencyKey: 'idem-1',
    })
    const second = await m.forkThread({
      sourceThreadId: parent.id,
      goal: 'side topic again',
      idempotencyKey: 'idem-1',
    })
    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(true)
    expect(second.thread.id).toBe(first.thread.id)
  })

  it('different idempotencyKeys create separate forks', async () => {
    const m = await loadModule(repo)
    await m.initChatStore()
    const parent = await m.createThread('parent')
    const a = await m.forkThread({
      sourceThreadId: parent.id,
      goal: 'topic A',
      idempotencyKey: 'key-a',
    })
    const b = await m.forkThread({
      sourceThreadId: parent.id,
      goal: 'topic B',
      idempotencyKey: 'key-b',
    })
    expect(a.thread.id).not.toBe(b.thread.id)
  })
})
