/**
 * Regression tests for `mars restart --force <id>` on tasks stuck in an
 * in-flight status (verifying) with a terminal-failed workflow run.
 *
 * Scenario: after a daemon restart, a recovery task (fix-xxx) can remain in
 * `tasks.status=verifying` even though its `workflow_runs.status=failed`.
 * Without --force, `mars restart` rejects it (only failed/done allowed).
 * With --force, `coreRestartTask` should accept it, clear the stale run journal,
 * and transition the task to `queued` so a fresh worktree is created.
 *
 * Done criteria (from task mars-a60f2b80):
 *   ✓ A task stuck in verifying with a failed workflow run can be restarted
 *   ✓ Restart deletes stale workflow checkpoints and setup creates a fresh worktree
 *   ✓ Active verifying runs remain protected from restart
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
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-restart-force-verifying-'))
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

describe('coreRestartTask force restart — verifying/failed-run mismatch', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Acceptance criterion 1: verifying task with failed run can be restarted ─

  it('allows restart of a verifying task when its workflow run is terminal failed', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('verifying stuck task', undefined, {
      skipTriage: true,
    })
    // Simulate the post-daemon-restart state: task row says verifying but the
    // durable workflow run has already failed (e.g. "working directory no longer exists").
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'verifying' WHERE id = ?`,
      args: [task.id],
    })

    const store = new InMemoryStore()
    await store.createRun({
      id: task.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await store.setRunStatus(task.id, 'failed', Date.now())

    // Without force, the restart must be rejected.
    await expect(
      restart.coreRestartTask(task.id, new Set(['failed', 'done']), store),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof restart.RestartTaskError && e.code === 'WRONG_STATUS',
    )

    // With force=true, the restart is permitted because the workflow run is failed.
    const result = await restart.coreRestartTask(
      task.id,
      new Set(['failed', 'done']),
      store,
      { force: true },
    )
    expect(result.status).toBe('queued')

    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('queued')
  })

  // ── Acceptance criterion 2: stale checkpoints cleared before re-dispatch ────

  it('clears the stale workflow run journal so re-dispatch starts from setup', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('stale verifier task', undefined, {
      skipTriage: true,
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'verifying' WHERE id = ?`,
      args: [task.id],
    })

    // Seed a stale run with completed setup and code steps — exactly the state
    // that causes re-dispatch to skip straight to verify against a missing worktree.
    const store = new InMemoryStore()
    await store.createRun({
      id: task.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await store.putStep({
      runId: task.id,
      name: 'setup-worktree',
      status: 'completed',
      sha: null,
      startedAt: Date.now(),
      finishedAt: Date.now() + 100,
      attempt: 1,
      summary: 'worktree ready',
      errorSummary: null,
      transcriptKey: null,
      resultJson: '"done"',
    })
    await store.putStep({
      runId: task.id,
      name: 'run-claude-code',
      status: 'completed',
      sha: null,
      startedAt: Date.now() + 200,
      finishedAt: Date.now() + 300,
      attempt: 1,
      summary: 'code step done',
      errorSummary: null,
      transcriptKey: null,
      resultJson: '"done"',
    })
    await store.setRunStatus(task.id, 'failed', Date.now() + 400)

    // Sanity: stale journal is present before restart.
    expect(await store.getRun(task.id)).toBeDefined()
    expect(await store.listSteps(task.id)).toHaveLength(2)

    await restart.coreRestartTask(
      task.id,
      new Set(['failed', 'done']),
      store,
      { force: true },
    )

    // After force-restart the stale journal MUST be gone. The next dispatch
    // will see no run record, enter step 0 (setup-worktree), and create a
    // fresh worktree — not skip to verify against the deleted origin worktree.
    expect(await store.getRun(task.id)).toBeUndefined()
    expect(await store.listSteps(task.id)).toEqual([])

    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('queued')
    // Failure markers must be cleared so the requeued task is pristine.
    expect(updated?.failedPhase).toBeNull()
    expect(updated?.error).toBeNull()
    expect(updated?.failureSignature).toBeNull()
  })

  // ── Acceptance criterion 3: active verifying runs are protected ──────────────

  it('refuses force restart when the verifying workflow run is still active (no run)', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('live verifying task', undefined, {
      skipTriage: true,
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'verifying' WHERE id = ?`,
      args: [task.id],
    })

    // No durable run record — the run is still considered active (the daemon
    // may be in the middle of executing the workflow step). Force must refuse.
    const store = new InMemoryStore()

    await expect(
      restart.coreRestartTask(
        task.id,
        new Set(['failed', 'done']),
        store,
        { force: true },
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof restart.RestartTaskError && e.code === 'WRONG_STATUS',
    )

    // Task must remain verifying — we did not tear it down.
    const unchanged = await q.getTask(task.id)
    expect(unchanged?.status).toBe('verifying')
  })

  it('refuses force restart when the verifying workflow run is not failed (running status)', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('live verifying run task', undefined, {
      skipTriage: true,
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'verifying' WHERE id = ?`,
      args: [task.id],
    })

    const store = new InMemoryStore()
    await store.createRun({
      id: task.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    // Run is still 'running' — the engine is actively executing the verify step.

    await expect(
      restart.coreRestartTask(
        task.id,
        new Set(['failed', 'done']),
        store,
        { force: true },
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof restart.RestartTaskError && e.code === 'WRONG_STATUS',
    )

    const unchanged = await q.getTask(task.id)
    expect(unchanged?.status).toBe('verifying')
  })

  it('error message explains why force was refused (run status included)', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('explain force refusal', undefined, {
      skipTriage: true,
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'verifying' WHERE id = ?`,
      args: [task.id],
    })

    const store = new InMemoryStore()
    await store.createRun({
      id: task.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    let err: unknown
    try {
      await restart.coreRestartTask(
        task.id,
        new Set(['failed', 'done']),
        store,
        { force: true },
      )
    } catch (e) {
      err = e
    }

    expect(err).toBeInstanceOf(restart.RestartTaskError)
    // The error message must include the run's actual status so the operator
    // understands why --force was refused.
    expect((err as InstanceType<typeof restart.RestartTaskError>).message).toContain('running')
  })

  // ── Force is not needed for tasks already in the normal allowed set ─────────

  it('without force, a task in failed status is still restarted normally', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('normal failed task', undefined, {
      skipTriage: true,
    })
    await q.updateTask(task.id, { status: 'failed', error: 'boom' })

    const store = new InMemoryStore()

    // force=false (default) on a failed task — no change to current behaviour.
    const result = await restart.coreRestartTask(task.id, new Set(['failed', 'done']), store)
    expect(result.status).toBe('queued')

    expect((await q.getTask(task.id))?.status).toBe('queued')
  })
})
