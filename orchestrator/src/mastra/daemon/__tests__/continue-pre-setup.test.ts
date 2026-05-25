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
  await queue.initQueue()
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
    // Re-enters from setup: no resumeFrom hint, branch+worktree cleared
    expect(after?.status).toBe('queued')
    expect(after?.resumeFrom).toBeNull()
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
    expect(after?.resumeFrom).toBeNull()
    expect(after?.failedPhase).toBeNull()
  })

  // ── Guard: only failed tasks can be continued ──────────────────────────────

  it('throws when the task is not in failed status', async () => {
    const { queue, continueTask } = await loadModules(repo)

    const task = await queue.enqueueTask('test work', undefined, { skipTriage: true })
    // task is in 'queued' status (not failed)

    await expect(continueTask.coreContinueTask(task.id)).rejects.toThrow(/only failed tasks/)
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
    expect(after?.status).toBe('queued')
    expect(after?.resumeFrom).toBe('verify') // skips back into verify
    expect(after?.branch).toBe(`task/${task.id}`) // preserved
  })
})
