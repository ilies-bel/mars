/**
 * Tests for `mars restart` accepting vega-reconciling and merging tasks
 * without requiring --force.
 *
 * Before this change, only failed/done tasks could be restarted via the
 * normal path. Tasks stuck in merging or vega-reconciling required --force
 * (plus a terminal-failed workflow run). Now they are first-class restart
 * targets: the allow-list in handleRestart (UDS) and the HTTP restartTask
 * handler both include 'vega-reconciling' and 'merging'.
 *
 * Done criteria (from task mars-6ef16056):
 *   ✓ A task in vega-reconciling can be restarted without force
 *   ✓ A task in merging can be restarted without force
 *   ✓ queued tasks are still rejected
 *   ✓ running tasks are still rejected without force
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { InMemoryStore } from '@mars/workflow'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  updateTask: typeof import('../../queue').updateTask
}

interface RestartModule {
  coreRestartTask: typeof import('../restart-task').coreRestartTask
  RestartTaskError: typeof import('../restart-task').RestartTaskError
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-restart-verb-statuses-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; restart: RestartModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const restart = (await import('../restart-task')) as unknown as RestartModule
  return { q, restart }
}

/** Allow-list matching what server.ts handleRestart passes. */
const RESTART_ALLOWED = new Set(['failed', 'done', 'vega-reconciling', 'merging'])

describe('coreRestartTask — vega-reconciling and merging are normal restart targets', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  // ── vega-reconciling ──────────────────────────────────────────────────────

  it('restarts an explicitly selected done task without weakening terminal immutability', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('completed task selected for rerun', undefined, {
      skipTriage: true,
    })
    await q.updateTask(task.id, { status: 'done' })

    const result = await restart.coreRestartTask(
      task.id,
      RESTART_ALLOWED,
      new InMemoryStore(),
    )

    expect(result.status).toBe('queued')
    expect((await q.getTask(task.id))?.status).toBe('queued')
  })

  it('restarts a vega-reconciling task without force', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('merge conflict stuck task', undefined, {
      skipTriage: true,
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'vega-reconciling' WHERE id = ?`,
      args: [task.id],
    })

    const store = new InMemoryStore()

    // No force needed — vega-reconciling is in the normal allow-list.
    const result = await restart.coreRestartTask(task.id, RESTART_ALLOWED, store)
    expect(result.status).toBe('queued')

    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('queued')
  })

  it('clears failure markers when restarting a vega-reconciling task', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('vega-reconciling task with error', undefined, {
      skipTriage: true,
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks
              SET status = 'vega-reconciling',
                  error = 'vega conflict',
                  failed_phase = 'merge',
                  failure_signature = 'merge:crashed/index-lock-contention'
            WHERE id = ?`,
      args: [task.id],
    })

    const store = new InMemoryStore()
    await restart.coreRestartTask(task.id, RESTART_ALLOWED, store)

    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('queued')
    expect(updated?.error).toBeNull()
    expect(updated?.failedPhase).toBeNull()
    expect(updated?.failureSignature).toBeNull()
  })

  // ── merging ───────────────────────────────────────────────────────────────

  it('restarts a merging task without force', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('merging stuck task', undefined, {
      skipTriage: true,
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'merging' WHERE id = ?`,
      args: [task.id],
    })

    const store = new InMemoryStore()

    // No force needed — merging is in the normal allow-list.
    const result = await restart.coreRestartTask(task.id, RESTART_ALLOWED, store)
    expect(result.status).toBe('queued')

    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('queued')
  })

  it('clears failure markers when restarting a merging task', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('merging task with error', undefined, {
      skipTriage: true,
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks
              SET status = 'merging',
                  error = 'index lock contention',
                  failed_phase = 'merge',
                  failure_signature = 'merge:crashed/index-lock-contention'
            WHERE id = ?`,
      args: [task.id],
    })

    const store = new InMemoryStore()
    await restart.coreRestartTask(task.id, RESTART_ALLOWED, store)

    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('queued')
    expect(updated?.error).toBeNull()
    expect(updated?.failedPhase).toBeNull()
    expect(updated?.failureSignature).toBeNull()
  })

  // ── Still-rejected statuses ───────────────────────────────────────────────

  it('still rejects a queued task', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('queued task', undefined, { skipTriage: true })
    // task is 'queued' — not in the allow-list

    const store = new InMemoryStore()

    await expect(
      restart.coreRestartTask(task.id, RESTART_ALLOWED, store),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof restart.RestartTaskError && e.code === 'WRONG_STATUS',
    )

    // Task must remain queued — we did not tear it down.
    const unchanged = await q.getTask(task.id)
    expect(unchanged?.status).toBe('queued')
  })

  it('still rejects a running task without force', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('running task', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running' WHERE id = ?`,
      args: [task.id],
    })

    const store = new InMemoryStore()

    await expect(
      restart.coreRestartTask(task.id, RESTART_ALLOWED, store),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof restart.RestartTaskError && e.code === 'WRONG_STATUS',
    )

    const unchanged = await q.getTask(task.id)
    expect(unchanged?.status).toBe('running')
  })
})
