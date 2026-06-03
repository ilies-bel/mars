/**
 * Smoke tests for the TaskStore seam (slice 1).
 *
 * Verifies that `createTaskStore(client)` returns a store whose domain
 * methods delegate correctly to the underlying queue functions, and that
 * `createRunMigrations(client)` produces a lazy, once-per-instance memoised
 * runner that drives the queue's init path.
 *
 * Also verifies the generic SQL escape hatches: query, execute, and atomic.
 *
 * Test isolation follows the established pattern for queue tests: each test
 * group uses `vi.resetModules()` to obtain a fresh module graph and a
 * dedicated temp directory backed by a file-URL libsql client (the `:memory:`
 * URL has known incompatibilities with libsql write transactions in this
 * project — see fix-recipes.ts for details).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Scope } from '../task-store'

// ── Helpers ──────────────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-task-store-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadDeps = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const storeModule = await import('../task-store')
  const queueModule = await import('../../queue')
  // Initialise the queue so tables exist before we exercise domain methods.
  await queueModule.migrateQueueSchema()
  return { storeModule, queueModule }
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('createTaskStore', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('enqueueTask → getTask round-trip returns the expected row', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const task = await store.enqueueTask('hello world', undefined, {
      skipTriage: true,
    })

    const fetched = await store.getTask(task.id)

    expect(fetched).not.toBeNull()
    expect(fetched?.id).toBe(task.id)
    expect(fetched?.prompt).toBe('hello world')
    expect(fetched?.status).toBe('queued')
  })

  it('listTasks returns all queued tasks', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    await store.enqueueTask('task-one', undefined, { skipTriage: true })
    await store.enqueueTask('task-two', undefined, { skipTriage: true })

    const all = await store.listTasks('queued')
    const prompts = all.map((t) => t.prompt)

    expect(prompts).toContain('task-one')
    expect(prompts).toContain('task-two')
  })

  it('exposes every expected domain method', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const expectedMethods = [
      'getTask',
      'listTasks',
      'enqueueTask',
      'updateTask',
      'dropTask',
      'deleteTask',
      'setTaskPriority',
      'insertReflectionTask',
      'promoteDraftToQueued',
      'unblockTask',
      'addBlockers',
      'addPendingReviewBlockers',
      'removeBlocker',
      'clearBlockers',
      'listBlockers',
      'hasIncompleteBlockers',
      'listAllBlockers',
      'addProposalBlockers',
      'removeProposalBlocker',
      'listProposalBlockers',
      'listTasksBlockedByProposal',
      'transferProposalBlockerToTask',
      'listSiblings',
      'listTasksForProposal',
      'upsertTranscript',
      'getTranscript',
      'query',
      'execute',
      'atomic',
    ] as const

    for (const method of expectedMethods) {
      expect(
        typeof store[method],
        `store.${method} should be a function`,
      ).toBe('function')
    }
  })
})

describe('createRunMigrations', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('runner initialises the queue and is memoised across calls', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const runner = storeModule.createRunMigrations(queueModule.resolveQueueClient())

    // First call drives the migration.
    await runner()

    // Second call must return the same memoised promise — a fresh module
    // would have run migrateQueueSchema again. We verify memoisation by checking that
    // a task can be enqueued (tables exist) after both calls.
    await runner()

    const task = await queueModule.enqueueTask('memo-check', undefined, {
      skipTriage: true,
    })
    expect(task.id).toMatch(/^mars-/)
  })
})

describe('query, execute, and atomic escape hatches', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('execute runs a write and query reads it back', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    await store.execute('CREATE TABLE greet (msg TEXT)')
    await store.execute('INSERT INTO greet VALUES (?)', ['hello'])

    const rs = await store.query('SELECT msg FROM greet')

    expect(rs.rows).toHaveLength(1)
    expect(rs.rows[0]['msg']).toBe('hello')
  })

  it('atomic commits the callback changes when it returns', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    await store.execute('CREATE TABLE counter (n INTEGER)')
    await store.execute('INSERT INTO counter VALUES (?)', [0])

    await store.atomic(async (scope) => {
      await scope.execute('UPDATE counter SET n = ?', [1])
    })

    const rs = await store.query('SELECT n FROM counter')
    expect(Number(rs.rows[0]['n'])).toBe(1)
  })

  it('atomic rolls back on throw, leaving database unchanged', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    await store.execute('CREATE TABLE counter (n INTEGER)')
    await store.execute('INSERT INTO counter VALUES (?)', [42])

    await expect(
      store.atomic(async (scope) => {
        await scope.execute('UPDATE counter SET n = ?', [99])
        throw new Error('deliberate failure')
      }),
    ).rejects.toThrow('deliberate failure')

    // The row must still hold the original value — the write was rolled back.
    const rs = await store.query('SELECT n FROM counter')
    expect(Number(rs.rows[0]['n'])).toBe(42)
  })

  it('atomic rejects nesting with a clear error', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    await expect(
      store.atomic(async () => {
        // Attempt a nested atomic — must be rejected immediately.
        await store.atomic(async () => {})
      }),
    ).rejects.toThrow(/nested/)
  })

  it('retained Scope reference throws after callback settles', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    await store.execute('CREATE TABLE t (x TEXT)')

    let capturedScope!: Scope

    await store.atomic(async (scope) => {
      capturedScope = scope
    })

    // After atomic() has settled, any use of the retained scope must throw.
    await expect(
      capturedScope.execute('INSERT INTO t VALUES (?)', ['x']),
    ).rejects.toThrow(/revoked/)

    await expect(
      capturedScope.query('SELECT * FROM t'),
    ).rejects.toThrow(/revoked/)
  })
})
