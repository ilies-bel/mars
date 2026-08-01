/**
 * Tests for the deployment teardown lifecycle hook.
 *
 * Verifies that:
 *   - `teardownDeploymentsForTask` calls provider.teardown for every active
 *     deployment and marks `torn_down_at` on success.
 *   - Provider errors are caught and logged but never rethrown.
 *   - The hook fires exactly once per terminal resolution across all four paths:
 *       1. validate  (coreValidateTask)
 *       2. reject    (coreRejectTask)
 *       3. drop      (corePurgeTask)
 *       4. merge     (updateTask status → 'done')
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// PGlite cold start can take a while — extend timeouts for every test.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

// ── Mock the deployment registry so we control provider behaviour ─────────────
const teardownFn = vi.fn<(id: string) => Promise<void>>()
let resetTestDbs: (() => Promise<void>) | undefined

vi.mock('../../lib/deployment/registry', () => ({
  getProvider: () => ({ teardown: teardownFn }),
  registerProvider: vi.fn(),
}))

// Mock dev-server so validate/reject tests never spawn a real process.
vi.mock('../../lib/dev-server', () => ({
  killDevServer: async (_pid: number | null) => {},
  startDevServer: async () => ({ pid: 1, url: 'http://127.0.0.1:1', logPath: '/tmp/x.log', port: 1 }),
  isDevServerAlive: () => false,
  allocatePort: async () => 1,
}))

// ── Helpers ────────────────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-deployment-teardown-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

let repo: string

beforeAll(() => {
  repo = setupRepo()
})

afterAll(async () => {
  await resetTestDbs?.()
  resetTestDbs = undefined
  delete process.env.MARS_REPO
  vi.resetModules()
  rmSync(repo, { recursive: true, force: true })
})

/**
 * Reload all modules fresh (PGlite-backed; one instance per target) and
 * reset the teardownFn mock to its default (resolves). If the test wants a
 * different behaviour it MUST override AFTER calling load().
 */
const load = async (repo: string) => {
  process.env.MARS_REPO = repo
  // Reset mock AFTER resetModules so re-imported modules see the fresh spy.
  teardownFn.mockReset()
  teardownFn.mockResolvedValue(undefined)
  const q = await import('../../queue')
  const { __resetDbRegistryForTests } = await import('../../lib/db')
  resetTestDbs = __resetDbRegistryForTests
  await q.migrateQueueSchema()
  return q
}

/** Insert a task_deployments row so teardown has something to act on. */
const insertDeployment = async (
  q: Awaited<ReturnType<typeof load>>,
  taskId: string,
  deploymentId: string,
  providerKey = 'noop',
): Promise<void> => {
  const client = q.resolveQueueClient()
  await client.execute({
    sql: `INSERT INTO task_deployments
            (deployment_id, task_id, provider, status, created_at, updated_at)
          VALUES (?, ?, ?, 'ready', now(), now())`,
    args: [deploymentId, taskId, providerKey],
  })
}

/** Read back a task_deployments row. */
const getDeployment = async (
  q: Awaited<ReturnType<typeof load>>,
  deploymentId: string,
): Promise<{ torn_down_at: string | null }> => {
  const client = q.resolveQueueClient()
  const result = await client.execute({
    sql: `SELECT torn_down_at FROM task_deployments WHERE deployment_id = ?`,
    args: [deploymentId],
  })
  return result.rows[0] as unknown as { torn_down_at: string | null }
}

/** Park a freshly-enqueued task at awaiting-validation. */
const parkAtGate = async (
  q: Awaited<ReturnType<typeof load>>,
  prompt = 'preview me',
): Promise<string> => {
  const task = await q.enqueueTask(prompt, undefined, {
    spec: { files: [], verifyCmd: null, doneCriteria: [], mergeMode: 'auto' },
  })
  await q.updateTask(task.id, {
    status: 'awaiting-validation',
    devServerUrl: 'http://127.0.0.1:1',
    devServerPid: 1,
  })
  return task.id
}

// ── Teardown behaviour tests ──────────────────────────────────────────────────

describe('teardownDeploymentsForTask', () => {
  it('calls provider.teardown and stamps torn_down_at on success', async () => {
    const q = await load(repo)
    const task = await q.enqueueTask('deploy me')
    await insertDeployment(q, task.id, 'dep-001')

    const { teardownDeploymentsForTask } = await import('../../lib/deployment/teardown')
    await teardownDeploymentsForTask(task.id)

    expect(teardownFn).toHaveBeenCalledOnce()
    expect(teardownFn).toHaveBeenCalledWith('dep-001')

    const dep = await getDeployment(q, 'dep-001')
    expect(dep.torn_down_at).not.toBeNull()
  })

  it('catches provider errors, logs them, and never rethrows', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const q = await load(repo)
    // Set AFTER load() so the mock isn't cleared by load()'s teardownFn.mockReset().
    teardownFn.mockRejectedValue(new Error('provider boom'))

    const task = await q.enqueueTask('deploy me')
    await insertDeployment(q, task.id, 'dep-002')

    const { teardownDeploymentsForTask } = await import('../../lib/deployment/teardown')

    // Must not throw even though provider threw.
    await expect(teardownDeploymentsForTask(task.id)).resolves.toBeUndefined()

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/\[deployment:teardown\]/))
    // torn_down_at NOT set — a retry can attempt teardown again.
    const dep = await getDeployment(q, 'dep-002')
    expect(dep.torn_down_at).toBeNull()

    consoleSpy.mockRestore()
  })

  it('is a no-op when the task has no deployments', async () => {
    const q = await load(repo)
    const task = await q.enqueueTask('no deployment')

    const { teardownDeploymentsForTask } = await import('../../lib/deployment/teardown')
    await expect(teardownDeploymentsForTask(task.id)).resolves.toBeUndefined()
    expect(teardownFn).not.toHaveBeenCalled()
  })

  it('skips already-torn-down deployments (idempotent)', async () => {
    const q = await load(repo)
    const task = await q.enqueueTask('deploy me')
    await insertDeployment(q, task.id, 'dep-003')

    // Mark it as already torn down.
    await q.resolveQueueClient().execute({
      sql: `UPDATE task_deployments SET torn_down_at = now() WHERE deployment_id = ?`,
      args: ['dep-003'],
    })

    const { teardownDeploymentsForTask } = await import('../../lib/deployment/teardown')
    await teardownDeploymentsForTask(task.id)

    // Provider was never called for an already-torn-down deployment.
    expect(teardownFn).not.toHaveBeenCalled()
  })
})

// ── validate path ─────────────────────────────────────────────────────────────

describe('validate path: coreValidateTask fires teardown', () => {
  it('calls teardown exactly once on validate', async () => {
    const q = await load(repo)
    const id = await parkAtGate(q)
    await insertDeployment(q, id, `dep-validate-${id}`)

    const { coreValidateTask } = await import('../validate-task')
    await coreValidateTask(id)

    expect(teardownFn).toHaveBeenCalledOnce()
    expect(teardownFn).toHaveBeenCalledWith(`dep-validate-${id}`)
  })

  it('teardown errors do not prevent validate from completing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const q = await load(repo)
    // Set AFTER load() so the mock isn't cleared by teardownFn.mockReset().
    teardownFn.mockRejectedValue(new Error('teardown exploded'))

    const id = await parkAtGate(q)
    await insertDeployment(q, id, `dep-validate-err-${id}`)

    const { coreValidateTask } = await import('../validate-task')
    await expect(coreValidateTask(id)).resolves.toBeUndefined()

    const after = await q.getTask(id)
    expect(after?.status).toBe('queued')

    consoleSpy.mockRestore()
  })
})

// ── reject path ───────────────────────────────────────────────────────────────

describe('reject path: coreRejectTask fires teardown', () => {
  it('calls teardown exactly once on reject', async () => {
    const q = await load(repo)
    const id = await parkAtGate(q)
    await insertDeployment(q, id, `dep-reject-${id}`)

    const { coreRejectTask } = await import('../validate-task')
    await coreRejectTask(id)

    expect(teardownFn).toHaveBeenCalledOnce()
    expect(teardownFn).toHaveBeenCalledWith(`dep-reject-${id}`)
  })

  it('teardown errors do not prevent reject from completing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const q = await load(repo)
    // Set AFTER load() so the mock isn't cleared by teardownFn.mockReset().
    teardownFn.mockRejectedValue(new Error('teardown exploded'))

    const id = await parkAtGate(q)
    await insertDeployment(q, id, `dep-reject-err-${id}`)

    const { coreRejectTask } = await import('../validate-task')
    await expect(coreRejectTask(id)).resolves.toBeUndefined()

    const after = await q.getTask(id)
    expect(after?.status).toBe('failed')

    consoleSpy.mockRestore()
  })
})

// ── drop path (corePurgeTask) ─────────────────────────────────────────────────

describe('drop path: corePurgeTask fires teardown', () => {
  it('calls teardown exactly once on purge of a failed task', async () => {
    const q = await load(repo)
    // Create a task in a terminal state so corePurgeTask accepts it.
    const task = await q.enqueueTask('to be purged')
    await q.updateTask(task.id, {
      status: 'failed',
      failedPhase: 'code',
      error: 'test failure',
      failureReason: 'test',
      failureReasonCode: 'test',
      failureSignature: 'test',
    })
    await insertDeployment(q, task.id, `dep-purge-${task.id}`)

    const { corePurgeTask } = await import('../purge-task')
    await corePurgeTask(task.id, true, 'main', repo)

    expect(teardownFn).toHaveBeenCalledOnce()
    expect(teardownFn).toHaveBeenCalledWith(`dep-purge-${task.id}`)
  })

  it('teardown errors do not prevent purge from completing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const q = await load(repo)
    // Set AFTER load() so the mock isn't cleared by teardownFn.mockReset().
    teardownFn.mockRejectedValue(new Error('teardown exploded'))

    const task = await q.enqueueTask('to be purged error path')
    await q.updateTask(task.id, {
      status: 'failed',
      failedPhase: 'code',
      error: 'test failure',
      failureReason: 'test',
      failureReasonCode: 'test',
      failureSignature: 'test',
    })
    await insertDeployment(q, task.id, `dep-purge-err-${task.id}`)

    const { corePurgeTask } = await import('../purge-task')
    // Should not throw even though teardown errored.
    await expect(corePurgeTask(task.id, true, 'main', repo)).resolves.toBeDefined()

    consoleSpy.mockRestore()
  })
})

// ── merge path (updateTask status → 'done') ───────────────────────────────────

describe('merge path: updateTask status→done fires teardown', () => {
  it('calls teardown exactly once when a task transitions to done', async () => {
    const q = await load(repo)
    // A task with no branch skips the done-implies-merged git guard.
    const task = await q.enqueueTask('to be merged')
    // The task starts as 'queued' with branch=null (no worktree provisioned).
    await insertDeployment(q, task.id, `dep-merge-${task.id}`)

    // Simulate the merge step completing: mark the task done.
    await q.updateTask(task.id, { status: 'done' })

    expect(teardownFn).toHaveBeenCalledOnce()
    expect(teardownFn).toHaveBeenCalledWith(`dep-merge-${task.id}`)
  })

  it('teardown errors do not prevent the done transition from completing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const q = await load(repo)
    // Set AFTER load() so the mock isn't cleared by teardownFn.mockReset().
    teardownFn.mockRejectedValue(new Error('teardown exploded'))

    const task = await q.enqueueTask('to be merged error path')
    await insertDeployment(q, task.id, `dep-merge-err-${task.id}`)

    await expect(q.updateTask(task.id, { status: 'done' })).resolves.toBeUndefined()

    const after = await q.getTask(task.id)
    expect(after?.status).toBe('done')

    consoleSpy.mockRestore()
  })
})
