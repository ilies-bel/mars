/**
 * Origin-session capture tests (slice mars-4da0cfba).
 *
 * Verifies that CLAUDE_CODE_SESSION_ID is captured at the CLI boundary and
 * stored in tasks.origin_session_id (and that the column stays NULL when the
 * var is absent or malformed).
 *
 * Uses the in-process command seam (ADR-0023) so no daemon is needed: the
 * fake daemon records the 'add' request and the test inspects what was sent,
 * then queries the store for the persisted row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { makeFakeDaemon, runCommandInProcess } from '../test-adapter'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'

const TEST_UUID = '12345678-1234-1234-1234-1234567890ab'

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-origin-session-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const loadStoreAndCtx = async (): Promise<{
  store: DomainTaskStore
  ctx: OrchestratorContext
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queueModule = await import('../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../core/store/task-store')
  const contextModule = await import('../../core/context')
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

beforeEach(() => {
  repo = setupRepo()
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.MARS_REPO
  delete process.env.CLAUDE_CODE_SESSION_ID
  rmSync(repo, { recursive: true, force: true })
})

describe('detectOriginSession', () => {
  it('returns the UUID when CLAUDE_CODE_SESSION_ID is a valid UUID', async () => {
    vi.resetModules()
    process.env.CLAUDE_CODE_SESSION_ID = TEST_UUID
    const { detectOriginSession } = await import('../../core/author')
    expect(detectOriginSession(process.env)).toBe(TEST_UUID)
  })

  it('returns null when CLAUDE_CODE_SESSION_ID is absent', async () => {
    vi.resetModules()
    delete process.env.CLAUDE_CODE_SESSION_ID
    const { detectOriginSession } = await import('../../core/author')
    expect(detectOriginSession(process.env)).toBeNull()
  })

  it('returns null when CLAUDE_CODE_SESSION_ID is not a UUID', async () => {
    vi.resetModules()
    process.env.CLAUDE_CODE_SESSION_ID = 'not-a-uuid'
    const { detectOriginSession } = await import('../../core/author')
    expect(detectOriginSession(process.env)).toBeNull()
  })
})

describe('task add stamps origin_session_id through the enqueue path', () => {
  it('includes originSessionId in the daemon add request when CLAUDE_CODE_SESSION_ID is set', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = TEST_UUID
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-abcd', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['task', 'add', 'test prompt'], {
      store,
      ctx,
      daemon: fake,
    })
    expect(r.code).toBe(0)
    const addCall = fake.calls[0]
    expect(addCall).toMatchObject({ op: 'add', originSessionId: TEST_UUID })
  })

  it('omits originSessionId from the daemon add request when CLAUDE_CODE_SESSION_ID is absent', async () => {
    delete process.env.CLAUDE_CODE_SESSION_ID
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-abcd', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['task', 'add', 'test prompt'], {
      store,
      ctx,
      daemon: fake,
    })
    expect(r.code).toBe(0)
    const addCall = fake.calls[0] as Record<string, unknown>
    expect(addCall.originSessionId).toBeUndefined()
  })

  it('persists origin_session_id on the task row when enqueueTask is called with originSessionId', async () => {
    const { store } = await loadStoreAndCtx()
    // Enqueue directly through the store's enqueueTask (which calls Arc.createOrigin)
    // to verify the DB layer end-to-end without a real daemon.
    const task = await store.enqueueTask('direct enqueue', undefined, {
      skipTriage: true,
      originSessionId: TEST_UUID,
    })
    expect(task.originSessionId).toBe(TEST_UUID)

    // Re-fetch from DB to confirm persistence
    const fetched = await store.getTask(task.id)
    expect(fetched?.originSessionId).toBe(TEST_UUID)
  })

  it('leaves origin_session_id NULL when originSessionId is not provided', async () => {
    const { store } = await loadStoreAndCtx()
    const task = await store.enqueueTask('no session', undefined, { skipTriage: true })
    expect(task.originSessionId).toBeNull()

    const fetched = await store.getTask(task.id)
    expect(fetched?.originSessionId).toBeNull()
  })
})

describe('task show prints origin session when set', () => {
  it('renders origin session line when originSessionId is present', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const task = await store.enqueueTask('session task', undefined, {
      skipTriage: true,
      originSessionId: TEST_UUID,
    })
    const r = await runCommandInProcess(['task', 'show', task.id], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain(`origin session: ${TEST_UUID}`)
  })

  it('does not render origin session line when originSessionId is null', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const task = await store.enqueueTask('no session task', undefined, { skipTriage: true })
    const r = await runCommandInProcess(['task', 'show', task.id], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).not.toContain('origin session:')
  })
})
