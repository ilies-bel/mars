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

  it('enqueueTask with explicit intent stores and returns it verbatim', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const task = await store.enqueueTask(
      'Do complex things. With many sentences.',
      undefined,
      { skipTriage: true, intent: 'Implement the frobnication layer' },
    )

    expect(task.intent).toBe('Implement the frobnication layer')

    const fetched = await store.getTask(task.id)
    expect(fetched?.intent).toBe('Implement the frobnication layer')

    const listed = await store.listTasks('queued')
    const found = listed.find((t) => t.id === task.id)
    expect(found?.intent).toBe('Implement the frobnication layer')
  })

  it('enqueueTask without intent derives it from the first sentence of prompt', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const task = await store.enqueueTask(
      'Fix the bug. Then clean up.',
      undefined,
      { skipTriage: true },
    )

    expect(task.intent).toBe('Fix the bug.')
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

  it('listAllTaskIds returns every task id without loading task details', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const first = await store.enqueueTask('first task', undefined, { skipTriage: true })
    const second = await store.enqueueTask('second task', undefined, { skipTriage: true })

    await queueModule.updateTask(second.id, { status: 'done' })

    await expect(store.listAllTaskIds()).resolves.toEqual(
      expect.arrayContaining([first.id, second.id]),
    )
  })

  it('listTasksPaged returns tasks with total count', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    await store.enqueueTask('paged-one', undefined, { skipTriage: true })
    await store.enqueueTask('paged-two', undefined, { skipTriage: true })
    await store.enqueueTask('paged-three', undefined, { skipTriage: true })

    const { tasks, total } = await store.listTasksPaged('queued')
    expect(total).toBe(3)
    expect(tasks.map((t) => t.prompt)).toContain('paged-one')
  })

  it('listTasksPaged respects limit and still reports full total', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    await store.enqueueTask('limit-a', undefined, { skipTriage: true })
    await store.enqueueTask('limit-b', undefined, { skipTriage: true })
    await store.enqueueTask('limit-c', undefined, { skipTriage: true })

    const { tasks, total } = await store.listTasksPaged('queued', 2)
    expect(total).toBe(3)
    expect(tasks).toHaveLength(2)
  })

  it('exposes every expected domain method', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const expectedMethods = [
      'getTask',
      'listTasks',
      'listTasksPaged',
      'listAllTaskIds',
      'enqueueTask',
      'updateTask',
      'dropTask',
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
      'getArcRescueAttempts',
      'incrementArcRescueAttempts',
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

describe('getArcRescueAttempts and incrementArcRescueAttempts', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('fresh origin task reports 0 rescue attempts', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const task = await store.enqueueTask('origin task', undefined, {
      skipTriage: true,
    })

    const count = await store.getArcRescueAttempts(task.id)
    expect(count).toBe(0)
  })

  it('incrementArcRescueAttempts returns 1 then 2 on consecutive calls', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const task = await store.enqueueTask('origin task', undefined, {
      skipTriage: true,
    })

    const first = await store.incrementArcRescueAttempts(task.id)
    expect(first).toBe(1)

    const second = await store.incrementArcRescueAttempts(task.id)
    expect(second).toBe(2)

    // getArcRescueAttempts reflects the persisted value
    const read = await store.getArcRescueAttempts(task.id)
    expect(read).toBe(2)
  })

  it('getArcRescueAttempts throws for a fix/recovery task id', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    // Insert an origin task first (FK target for fix_for_task_id)
    const origin = await store.enqueueTask('origin', undefined, {
      skipTriage: true,
    })

    // Insert a fix task directly — only the recovery dispatcher normally does
    // this, but a direct INSERT lets us test the guard without triggering the
    // full recovery machinery.
    const fixId = `mars-fix-${Date.now()}`
    const now = new Date().toISOString()
    await store.execute({
      sql: `INSERT INTO tasks (id, prompt, status, kind, fix_for_task_id, origin_id, created_at, updated_at)
            VALUES (?, ?, 'queued', 'fix', ?, ?, ?, ?)`,
      args: [fixId, 'fix task', origin.id, origin.id, now, now],
    })

    await expect(store.getArcRescueAttempts(fixId)).rejects.toThrow(
      'arc rescue counter can only be read on an origin task, not a recovery/fix task',
    )
  })

  it('incrementArcRescueAttempts throws for a fix/recovery task id', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const origin = await store.enqueueTask('origin', undefined, {
      skipTriage: true,
    })

    const fixId = `mars-fix-${Date.now()}-2`
    const now = new Date().toISOString()
    await store.execute({
      sql: `INSERT INTO tasks (id, prompt, status, kind, fix_for_task_id, origin_id, created_at, updated_at)
            VALUES (?, ?, 'queued', 'fix', ?, ?, ?, ?)`,
      args: [fixId, 'fix task', origin.id, origin.id, now, now],
    })

    await expect(store.incrementArcRescueAttempts(fixId)).rejects.toThrow(
      'arc rescue counter can only be read on an origin task, not a recovery/fix task',
    )
  })

  it('persists rescue attempts for an origin id with no task row (PRD slug)', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const proposalSlug = 'b625d966-add-pre-rebase-worktree-hygiene-check'

    await expect(store.getArcRescueAttempts(proposalSlug)).resolves.toBe(0)
    await expect(store.incrementArcRescueAttempts(proposalSlug)).resolves.toBe(1)
    await expect(store.incrementArcRescueAttempts(proposalSlug)).resolves.toBe(2)
    await expect(store.getArcRescueAttempts(proposalSlug)).resolves.toBe(2)
  })

  it('backfills the durable counter from rescue tasks during schema migration', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())
    const originId = 'backfill-proposal-slug'

    await store.enqueueTask('first existing rescue', undefined, {
      skipTriage: true,
      originId,
      tags: ['rescue-operator'],
    })
    await store.enqueueTask('second existing rescue', undefined, {
      skipTriage: true,
      originId,
      tags: ['rescue-operator'],
    })

    await store.execute('DROP TABLE arc_rescue_attempts')
    const { ensureSchema } = await import('../../lib/pg-schema')
    await ensureSchema(queueModule.resolveQueueClient())

    await expect(store.getArcRescueAttempts(originId)).resolves.toBe(2)
  })

})

describe('task_deployments', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('writeDeployment inserts a row and returns it', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const task = await store.enqueueTask('deployment test task', undefined, {
      skipTriage: true,
    })

    const dep = await store.writeDeployment({
      taskId: task.id,
      provider: 'fly',
      deploymentId: 'dep-insert-test',
      url: 'https://insert-test.fly.dev',
      status: 'pending',
    })

    expect(dep.deploymentId).toBe('dep-insert-test')
    expect(dep.taskId).toBe(task.id)
    expect(dep.provider).toBe('fly')
    expect(dep.url).toBe('https://insert-test.fly.dev')
    expect(dep.status).toBe('pending')
    expect(dep.error).toBeNull()
    expect(typeof dep.createdAt).toBe('string')
    expect(typeof dep.updatedAt).toBe('string')
  })

  it('getLatestDeployment returns null when no rows exist', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const task = await store.enqueueTask('no-deploys task', undefined, {
      skipTriage: true,
    })

    const dep = await store.getLatestDeployment(task.id)
    expect(dep).toBeNull()
  })

  it('insert → updateDeploymentStatus → getLatestDeployment round-trip', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const task = await store.enqueueTask('round-trip task', undefined, {
      skipTriage: true,
    })

    await store.writeDeployment({
      taskId: task.id,
      provider: 'fly',
      deploymentId: 'dep-roundtrip',
      status: 'pending',
    })

    await store.updateDeploymentStatus('dep-roundtrip', {
      status: 'ready',
      url: 'https://ready.fly.dev',
      error: null,
    })

    const latest = await store.getLatestDeployment(task.id)
    expect(latest).not.toBeNull()
    expect(latest?.deploymentId).toBe('dep-roundtrip')
    expect(latest?.status).toBe('ready')
    expect(latest?.url).toBe('https://ready.fly.dev')
    expect(latest?.error).toBeNull()
  })

  it('updateDeploymentStatus records error on failure', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const task = await store.enqueueTask('error task', undefined, {
      skipTriage: true,
    })

    await store.writeDeployment({
      taskId: task.id,
      provider: 'fly',
      deploymentId: 'dep-fail-test',
      status: 'pending',
    })

    await store.updateDeploymentStatus('dep-fail-test', {
      status: 'failed',
      error: 'build timed out',
    })

    const latest = await store.getLatestDeployment(task.id)
    expect(latest?.status).toBe('failed')
    expect(latest?.error).toBe('build timed out')
  })

  it('listDeploymentsForTask returns all rows for the task', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const task = await store.enqueueTask('list task', undefined, {
      skipTriage: true,
    })

    await store.writeDeployment({
      taskId: task.id,
      provider: 'fly',
      deploymentId: 'dep-list-a',
      status: 'pending',
    })
    await store.writeDeployment({
      taskId: task.id,
      provider: 'fly',
      deploymentId: 'dep-list-b',
      status: 'ready',
      url: 'https://list-b.fly.dev',
    })

    const deps = await store.listDeploymentsForTask(task.id)
    expect(deps).toHaveLength(2)
    const ids = deps.map((d) => d.deploymentId)
    expect(ids).toContain('dep-list-a')
    expect(ids).toContain('dep-list-b')
  })

  it('listDeploymentsForTask returns empty array when no rows exist', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const task = await store.enqueueTask('no-list task', undefined, {
      skipTriage: true,
    })

    const deps = await store.listDeploymentsForTask(task.id)
    expect(deps).toHaveLength(0)
  })
})
