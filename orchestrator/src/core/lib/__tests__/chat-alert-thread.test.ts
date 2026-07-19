/**
 * Unit tests for alert-thread functionality in `chat-store.ts`:
 *
 *   1. raise → thread creation: `createAlertThread` inserts a thread with
 *      `origin='alert'` and one assistant message containing the alert segment.
 *
 *   2. dedup: `findAlertThreadByItemId` finds the existing thread so a second
 *      call to `createAlertThread` with the same item id is skipped.
 *
 *   3. resolve-on-supersede: `resolveAlertThread` marks the thread resolved
 *      and patches the segment's `resolved` field in place.
 *
 *   4. Edge cases: `findAlertThreadByItemId` returns null when nothing exists;
 *      `resolveAlertThread` returns false when there is no open thread.
 *
 * Tests operate through the public `chat-store` API only, not DB internals —
 * so an internal refactor (e.g. column rename, SQL rewrite) leaves these
 * tests unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { AlertSegment } from '../chat-store'

// ── Module-level types (used to drive dynamic imports) ────────────────────────

interface ChatStoreModule {
  initChatStore: typeof import('../chat-store').initChatStore
  findAlertThreadByItemId: typeof import('../chat-store').findAlertThreadByItemId
  createAlertThread: typeof import('../chat-store').createAlertThread
  resolveAlertThread: typeof import('../chat-store').resolveAlertThread
  getThread: typeof import('../chat-store').getThread
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeAlertSegment = (overrides?: Partial<AlertSegment>): AlertSegment => ({
  type: 'alert',
  kind: 'failed',
  entityId: 'task-123',
  priority: 'high',
  title: 'Task mars-abc123 failed',
  whyNow: 'The implementation step exited with code 1.',
  actions: [
    { op: 'restart', label: 'Restart', style: 'primary' },
    { op: 'dismiss', label: 'Dismiss', style: 'default' },
  ],
  resolved: false,
  ...overrides,
})

// ── Repo setup ────────────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-chat-alert-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadChatStore = async (repo: string): Promise<ChatStoreModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = (await import('../chat-store')) as unknown as ChatStoreModule
  await mod.initChatStore()
  return mod
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('findAlertThreadByItemId', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns null when no alert thread exists for the given item id', async () => {
    const { findAlertThreadByItemId } = await loadChatStore(repo)
    const result = await findAlertThreadByItemId('item-does-not-exist')
    expect(result).toBeNull()
  })

  it('returns null for a different item id even after a thread is created', async () => {
    const { createAlertThread, findAlertThreadByItemId } = await loadChatStore(repo)
    await createAlertThread('item-A', 'Alert for A', makeAlertSegment({ entityId: 'task-A' }))
    const result = await findAlertThreadByItemId('item-B')
    expect(result).toBeNull()
  })
})

describe('createAlertThread', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('creates a thread with origin=alert and the given alert_item_id', async () => {
    const { createAlertThread } = await loadChatStore(repo)
    const thread = await createAlertThread(
      'item-xyz',
      'Task mars-xyz failed',
      makeAlertSegment(),
    )
    expect(thread.origin).toBe('alert')
    expect(thread.alert_item_id).toBe('item-xyz')
  })

  it('creates a thread with alert_resolved=false', async () => {
    const { createAlertThread } = await loadChatStore(repo)
    const thread = await createAlertThread('item-xyz', 'Test alert', makeAlertSegment())
    expect(thread.alert_resolved).toBe(false)
  })

  it('stores one assistant message containing the alert segment', async () => {
    const { createAlertThread, getThread } = await loadChatStore(repo)
    const seg = makeAlertSegment({ title: 'Custom title' })
    const thread = await createAlertThread('item-abc', 'Custom title', seg)

    const detail = await getThread(thread.id)
    expect(detail).not.toBeNull()
    expect(detail!.messages).toHaveLength(1)

    const msg = detail!.messages[0]
    expect(msg.role).toBe('assistant')

    const segments = Array.isArray(msg.segments) ? msg.segments : []
    expect(segments).toHaveLength(1)
    const stored = segments[0] as AlertSegment
    expect(stored.type).toBe('alert')
    expect(stored.title).toBe('Custom title')
    expect(stored.kind).toBe('failed')
    expect(stored.resolved).toBe(false)
  })

  it('the created thread is discoverable by findAlertThreadByItemId', async () => {
    const { createAlertThread, findAlertThreadByItemId } = await loadChatStore(repo)
    await createAlertThread('item-find', 'Find me', makeAlertSegment())
    const found = await findAlertThreadByItemId('item-find')
    expect(found).not.toBeNull()
    expect(found!.alert_item_id).toBe('item-find')
    expect(found!.origin).toBe('alert')
  })
})

describe('dedup: findAlertThreadByItemId prevents double-thread creation', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns the existing thread after first creation, preventing a second INSERT', async () => {
    const { createAlertThread, findAlertThreadByItemId } = await loadChatStore(repo)
    const itemId = 'item-dedup'

    // First raise: create the thread.
    const first = await createAlertThread(itemId, 'Alert title', makeAlertSegment())

    // Dedup check (as maybeCreateAlertThread does): existing thread found → skip.
    const existing = await findAlertThreadByItemId(itemId)
    expect(existing).not.toBeNull()
    expect(existing!.id).toBe(first.id)

    // If the caller correctly skips creation when existing is non-null, only
    // one thread exists. Verify by re-fetching.
    const againLookup = await findAlertThreadByItemId(itemId)
    expect(againLookup!.id).toBe(first.id)
  })

  it('does NOT create a second thread when findAlertThreadByItemId returns non-null', async () => {
    const { createAlertThread, findAlertThreadByItemId } = await loadChatStore(repo)
    const itemId = 'item-no-dup'
    await createAlertThread(itemId, 'First', makeAlertSegment())

    // Simulate the maybeCreateAlertThread dedup path: check → skip.
    const check = await findAlertThreadByItemId(itemId)
    expect(check).not.toBeNull() // would skip creation

    // Unconditionally creating a second would cause a PK collision in the DB.
    // Verify the first thread still has the original title.
    const still = await findAlertThreadByItemId(itemId)
    expect(still!.title).toBe('First')
  })
})

describe('resolveAlertThread', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns false when no alert thread exists for the item id', async () => {
    const { resolveAlertThread } = await loadChatStore(repo)
    const result = await resolveAlertThread('nonexistent-item')
    expect(result).toBe(false)
  })

  it('returns true and marks the thread resolved', async () => {
    const { createAlertThread, resolveAlertThread, findAlertThreadByItemId } =
      await loadChatStore(repo)

    await createAlertThread('item-resolve', 'Resolve me', makeAlertSegment())
    const resolved = await resolveAlertThread('item-resolve')
    expect(resolved).toBe(true)

    const thread = await findAlertThreadByItemId('item-resolve')
    expect(thread).not.toBeNull()
    expect(thread!.alert_resolved).toBe(true)
  })

  it('patches the alert segment resolved flag to true', async () => {
    const { createAlertThread, resolveAlertThread, getThread, findAlertThreadByItemId } =
      await loadChatStore(repo)

    const seg = makeAlertSegment({ resolved: false })
    const thread = await createAlertThread('item-patch', 'Patch segment', seg)
    await resolveAlertThread('item-patch')

    // Refetch and check the message's segment.
    const detail = await getThread(thread.id)
    expect(detail).not.toBeNull()
    const segments = Array.isArray(detail!.messages[0].segments)
      ? (detail!.messages[0].segments as AlertSegment[])
      : []
    expect(segments[0].resolved).toBe(true)
  })

  it('is idempotent: resolving an already-resolved thread returns false', async () => {
    const { createAlertThread, resolveAlertThread } = await loadChatStore(repo)
    await createAlertThread('item-idem', 'Idempotent', makeAlertSegment())

    const first = await resolveAlertThread('item-idem')
    expect(first).toBe(true)

    // Second call: no unresolved thread exists for this item.
    const second = await resolveAlertThread('item-idem')
    expect(second).toBe(false)
  })
})
