import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-continue-pre-setup-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = (await import('../../queue')) as typeof import('../../queue')
  const continueTask = (await import('../continue-task')) as typeof import('../continue-task')
  await queue.migrateQueueSchema()
  return { queue, continueTask }
}

describe('continue degrades to restart for pre-setup failures', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Tracer bullet: null failedPhase (pre-setup guard, e.g. dirty-main) ────

  it('re-queues from setup when failedPhase is null', async () => {
    const { queue, continueTask } = await loadModules(repo)

    const task = await queue.enqueueTask('test work', undefined, { skipTriage: true })
    // Simulate a failure that happened before any phase was recorded (e.g.
    // dirty-main-at-setup guard fired before worktree creation).
    await queue.updateTask(task.id, { status: 'failed', error: 'dirty-main guard fired' })

    const freshed = await queue.getTask(task.id)
    expect(freshed?.failedPhase).toBeNull()

    const result = await continueTask.coreContinueTask(task.id)

    expect(result.degradedToRestart).toBe(true)
    expect(result.note).toMatch(/pre-setup/)

    const after = await queue.getTask(task.id)
    // Re-enters from setup: branch+worktree cleared. Resume is engine-driven
    // (runId=task.id); the row carries no resume hint.
    expect(after?.status).toBe('queued')
    expect(after?.branch).toBeNull()
    expect(after?.worktreePath).toBeNull()
    expect(after?.error).toBeNull()
  })

  // ── failedPhase 'code' → non-resumable setup-time failure ─────────────────

  it('re-queues from setup when failedPhase is code', async () => {
    const { queue, continueTask } = await loadModules(repo)

    const task = await queue.enqueueTask('test work', undefined, { skipTriage: true })
    await queue.updateTask(task.id, {
      status: 'failed',
      error: 'install step failed',
      failedPhase: 'code',
    })

    const result = await continueTask.coreContinueTask(task.id)

    expect(result.degradedToRestart).toBe(true)

    const after = await queue.getTask(task.id)
    expect(after?.status).toBe('queued')
    expect(after?.failedPhase).toBeNull()
  })

  // ── Guard: only failed tasks can be continued ──────────────────────────────

  it('throws when the task is not in failed status', async () => {
    const { queue, continueTask } = await loadModules(repo)

    const task = await queue.enqueueTask('test work', undefined, { skipTriage: true })
    // task is in 'queued' status (not failed)

    await expect(continueTask.coreContinueTask(task.id)).rejects.toThrow(/only failed tasks/)
  })

  // ── Missing-worktree fallback: recorded path is gone from disk ────────────

  it('falls back to restart when worktree path is set but missing from disk', async () => {
    const { queue, continueTask } = await loadModules(repo)

    const task = await queue.enqueueTask('test work', undefined, { skipTriage: true })
    // Simulate a task that failed in verify with a worktree that has since
    // been deleted from disk (e.g. host reboot, manual cleanup, or eviction).
    // The branch+worktreePath are recorded in the DB but the directory is gone.
    await queue.updateTask(task.id, {
      status: 'failed',
      error: 'verify failed',
      failedPhase: 'verify',
      branch: `task/${task.id}`,
      worktreePath: '/nonexistent/worktree/path',
    })

    const result = await continueTask.coreContinueTask(task.id)

    // Should degrade to restart since the worktree is missing on disk.
    expect(result.degradedToRestart).toBe(true)
    // Note must specifically mention the missing worktree so the operator
    // knows why continue could not re-enter the verify phase.
    expect(result.note).toMatch(/missing from disk/)

    const after = await queue.getTask(task.id)
    // Re-enters from setup: branch+worktree cleared (same as restart).
    expect(after?.status).toBe('queued')
    expect(after?.branch).toBeNull()
    expect(after?.worktreePath).toBeNull()
    expect(after?.error).toBeNull()
  })

  // ── In-flight recovery guard ──────────────────────────────────────────────

  it('refuses with the recovery task id when an in-flight recovery is present', async () => {
    const { queue, continueTask } = await loadModules(repo)

    const source = await queue.enqueueTask('test work', undefined, { skipTriage: true })
    // Source is failed+verify: worktree exists, so no pre-setup guard would fire.
    // The only reason continue should refuse is the in-flight recovery.
    await queue.updateTask(source.id, {
      status: 'failed',
      error: 'verify failed',
      failedPhase: 'verify',
      branch: `task/${source.id}`,
      worktreePath: repo, // repo dir exists on disk
    })

    // Insert a recovery fix-task pointing at the source. enqueueTask rejects
    // kind='fix', so we use the task store directly.
    const { getDefaultTaskStore } = (await import('../../store/task-store')) as typeof import('../../store/task-store')
    const store = await getDefaultTaskStore()
    const recoveryId = `mars-fix-00`
    const now = new Date().toISOString()
    await store.execute({
      sql: `INSERT INTO tasks (id, prompt, status, fix_for_task_id, origin_id, priority, tag, kind, created_at, updated_at)
            VALUES (?, ?, 'running', ?, ?, 0, 'coder', 'fix', ?, ?)`,
      args: [recoveryId, 'fix the thing', source.id, source.id, now, now],
    })

    // continue must refuse and name the in-flight recovery id
    await expect(continueTask.coreContinueTask(source.id)).rejects.toThrow(recoveryId)
  })

  // ── Normal resume path is unaffected ──────────────────────────────────────

  it('resumes from failed phase without degrading when worktree exists', async () => {
    const { queue, continueTask } = await loadModules(repo)

    const task = await queue.enqueueTask('test work', undefined, { skipTriage: true })
    // Simulate a task that failed in verify with a live worktree.
    // We use the repo itself as the worktree path so existsSync returns true.
    await queue.updateTask(task.id, {
      status: 'failed',
      error: 'verify failed',
      failedPhase: 'verify',
      branch: `task/${task.id}`,
      worktreePath: repo, // repo dir exists on disk
    })

    const result = await continueTask.coreContinueTask(task.id)

    expect(result.degradedToRestart).toBe(false)

    const after = await queue.getTask(task.id)
    // Re-queued as-is with the worktree preserved. Continue no longer sets a
    // resumeFrom hint; the engine resumes via runId=task.id, short-circuiting
    // the already-completed setup+code steps and re-entering verify on its own.
    // failedPhase stays on the row (it drove the resume-vs-degrade decision).
    expect(after?.status).toBe('queued')
    expect(after?.failedPhase).toBe('verify')
    expect(after?.branch).toBe(`task/${task.id}`) // preserved
  })
})
