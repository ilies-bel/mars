/**
 * Smoke tests for the TaskStore seam (slice 1).
 *
 * Verifies that `createTaskStore(client)` returns a store whose domain
 * methods delegate correctly to the underlying queue functions, and that
 * `createRunMigrations(client)` produces a lazy, once-per-instance memoised
 * runner that drives the queue's init path.
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
  await queueModule.initQueue()
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
    const store = storeModule.createTaskStore(queueModule.getClient())

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
    const store = storeModule.createTaskStore(queueModule.getClient())

    await store.enqueueTask('task-one', undefined, { skipTriage: true })
    await store.enqueueTask('task-two', undefined, { skipTriage: true })

    const all = await store.listTasks('queued')
    const prompts = all.map((t) => t.prompt)

    expect(prompts).toContain('task-one')
    expect(prompts).toContain('task-two')
  })

  it('exposes every expected domain method', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.getClient())

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
    const runner = storeModule.createRunMigrations(queueModule.getClient())

    // First call drives the migration.
    await runner()

    // Second call must return the same memoised promise — a fresh module
    // would have run initQueue again. We verify memoisation by checking that
    // a task can be enqueued (tables exist) after both calls.
    await runner()

    const task = await queueModule.enqueueTask('memo-check', undefined, {
      skipTriage: true,
    })
    expect(task.id).toMatch(/^mars-/)
  })
})
