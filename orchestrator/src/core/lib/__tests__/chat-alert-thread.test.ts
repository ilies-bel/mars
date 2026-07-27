import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface ChatStoreModule {
  initChatStore: typeof import('../chat-store').initChatStore
  startThreadFromAlert: typeof import('../chat-store').startThreadFromAlert
  resolveAlertThread: typeof import('../chat-store').resolveAlertThread
  getThread: typeof import('../chat-store').getThread
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

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-chat-alert-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModule = async (repo: string): Promise<ChatStoreModule> => {
  const { vi } = await import('vitest')
  vi.resetModules()
  process.env.MARS_REPO = repo
  return (await import('../chat-store')) as unknown as ChatStoreModule
}

// ── resolveAlertThread ────────────────────────────────────────────────────────

describe('resolveAlertThread', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('sets evaporated_at to a valid ISO string on first resolution', async () => {
    const m = await loadModule(repo)
    const thread = await m.startThreadFromAlert('arc-1', 'task broke', makeSegment('task broke'))
    const resolved = await m.resolveAlertThread(thread.id)
    expect(resolved).toBe(true)
    const result = await m.getThread(thread.id)
    expect(result).not.toBeNull()
    const { evaporated_at } = result!.thread
    expect(evaporated_at).not.toBeNull()
    // Must be parseable as a valid date
    expect(Number.isFinite(new Date(evaporated_at!).getTime())).toBe(true)
  })

  it('also flips alert_resolved to true on first resolution', async () => {
    const m = await loadModule(repo)
    const thread = await m.startThreadFromAlert('arc-2', 'another task', makeSegment('another task'))
    await m.resolveAlertThread(thread.id)
    const result = await m.getThread(thread.id)
    expect(result!.thread.alert_resolved).toBe(true)
  })

  it('returns false on second resolution and leaves evaporated_at unchanged', async () => {
    const m = await loadModule(repo)
    const thread = await m.startThreadFromAlert('arc-3', 'third task', makeSegment('third task'))

    await m.resolveAlertThread(thread.id)
    const firstTimestamp = (await m.getThread(thread.id))!.thread.evaporated_at

    // Ensure at least 1ms elapses so a fresh stamp would differ
    await new Promise((r) => setTimeout(r, 2))

    const secondResult = await m.resolveAlertThread(thread.id)
    expect(secondResult).toBe(false)

    const secondTimestamp = (await m.getThread(thread.id))!.thread.evaporated_at
    expect(secondTimestamp).toBe(firstTimestamp)
  })
})
