/**
 * Behavioural tests for the continueAllDaemonKilled bulk operation.
 *
 * The function is the successor to restartAllDaemonKilled — it uses coreContinueTask
 * (the continue path) instead of coreRestartTask (the destructive restart path).
 * This matters because daemon-killed tasks are the purest "continue" case: their
 * coder was mid-run when the daemon died, leaving committed work on the branch.
 * Using restart discards that work; using continue preserves it.
 *
 * These tests exercise the server.ts behaviour end-to-end through a thin helper
 * that mirrors what the function does — calling coreContinueTask for each
 * daemon-killed task and splitting the result into continued / degraded / skipped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test',
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-continue-all-daemon-killed-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: GIT_ENV })
  writeFileSync(resolve(repo, 'README.md'), 'baseline\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo, env: GIT_ENV })
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo, env: GIT_ENV })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = (await import('../../queue')) as typeof import('../../queue')
  const continueTask = (await import('../continue-task')) as typeof import('../continue-task')
  const { DAEMON_KILLED_SIGNATURE } = (await import('../../lib/retry-budget')) as typeof import('../../lib/retry-budget')
  await queue.migrateQueueSchema()
  return { queue, continueTask, DAEMON_KILLED_SIGNATURE }
}

type Modules = Awaited<ReturnType<typeof loadModules>>

/**
 * Mirror the continueAllDaemonKilled logic from server.ts so the tests exercise
 * the same decision path without spinning up the full daemon stack.
 * This helper is intentionally thin — it delegates everything to coreContinueTask
 * (the same component server.ts delegates to) rather than re-implementing.
 */
const runContinueAllDaemonKilled = async (
  modules: Modules,
) => {
  const { queue, continueTask, DAEMON_KILLED_SIGNATURE } = modules
  const failed = await queue.listTasks('failed')
  const killed = failed.filter(
    (t) =>
      t.failureSignature === DAEMON_KILLED_SIGNATURE &&
      t.failureReason !== 'cancelled',
  )
  const continued: string[] = []
  const degraded: string[] = []
  const skipped: string[] = []
  for (const task of killed) {
    try {
      const result = await continueTask.coreContinueTask(task.id)
      if (result.degradedToRestart) {
        degraded.push(task.id)
      } else {
        continued.push(task.id)
      }
    } catch {
      skipped.push(task.id)
    }
  }
  return { continued, degraded, skipped }
}

describe('continueAllDaemonKilled — behavioural contract', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Tracer bullet: intact worktree keeps its commits ────────────────────────

  it('daemon-killed task with intact worktree and branch resumes via continue, keeping its commits', async () => {
    // This is the purest continue case: the coder was mid-run and committed
    // work before the daemon died. The bulk operation must preserve those commits.
    const modules = await loadModules(repo)
    const { queue, DAEMON_KILLED_SIGNATURE } = modules

    const task = await queue.enqueueTask('add feature X', undefined, { skipTriage: true })
    const branch = `task/${task.id}`
    const worktreePath = resolve(repo, '.mars', 'worktrees', task.id)

    // Create a real worktree with a commit on it to simulate mid-run coder state.
    execFileSync('git', ['worktree', 'add', '-qb', branch, worktreePath], { cwd: repo, env: GIT_ENV })
    writeFileSync(resolve(worktreePath, 'feature.ts'), 'export const x = 1\n')
    execFileSync('git', ['add', 'feature.ts'], { cwd: worktreePath, env: GIT_ENV })
    execFileSync('git', ['commit', '-qm', 'wip: feature X partial'], { cwd: worktreePath, env: GIT_ENV })
    const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      env: GIT_ENV,
    }).trim()

    // Stamp the task as daemon-killed mid-code-phase.
    await queue.updateTask(task.id, {
      status: 'failed',
      failureSignature: DAEMON_KILLED_SIGNATURE,
      failedPhase: 'code',
      branch,
      worktreePath,
    })

    const result = await runContinueAllDaemonKilled(modules)

    // Must appear in 'continued' (intact worktree → no degradation).
    expect(result.continued).toContain(task.id)
    expect(result.degraded).not.toContain(task.id)
    expect(result.skipped).not.toContain(task.id)

    // The commit seeded before the daemon died must survive — the continue path
    // preserves existing branch history rather than wiping it.
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      env: GIT_ENV,
    }).trim()
    // HEAD must still contain the original commit (HEAD or an ancestor of HEAD
    // after a potential base-refresh merge).
    const isAncestor = (() => {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', commitSha, headAfter], {
          cwd: worktreePath,
          stdio: 'pipe',
          env: GIT_ENV,
        })
        return true
      } catch {
        return false
      }
    })()
    expect(isAncestor).toBe(true)

    // Task is back in queued state — ready for dispatch.
    const updated = await queue.getTask(task.id)
    expect(updated?.status).toBe('queued')
    // Branch and worktree are preserved (not cleared like a restart would do).
    expect(updated?.branch).toBe(branch)
    expect(updated?.worktreePath).toBe(worktreePath)
  })

  // ── Unresumable task degrades to restart ────────────────────────────────────

  it('daemon-killed task with no worktree degrades to restart and reports degradedToRestart', async () => {
    // A task with failedPhase=null (failure before any phase was recorded) has
    // nothing on disk worth preserving. The continue path must degrade to restart
    // and report this via degradedToRestart=true.
    const modules = await loadModules(repo)
    const { queue, DAEMON_KILLED_SIGNATURE } = modules

    const task = await queue.enqueueTask('background work', undefined, { skipTriage: true })
    // No branch, no worktreePath, no failedPhase — nothing to resume.
    await queue.updateTask(task.id, {
      status: 'failed',
      failureSignature: DAEMON_KILLED_SIGNATURE,
      // failedPhase stays null (default)
    })

    const result = await runContinueAllDaemonKilled(modules)

    // Must appear in 'degraded' (no worktree → degrade to restart).
    expect(result.degraded).toContain(task.id)
    expect(result.continued).not.toContain(task.id)
    expect(result.skipped).not.toContain(task.id)

    // Task is re-queued (from restart path — branch/worktree cleared).
    const updated = await queue.getTask(task.id)
    expect(updated?.status).toBe('queued')
    expect(updated?.branch).toBeNull()
    expect(updated?.worktreePath).toBeNull()
  })

  // ── Split counts reported separately ────────────────────────────────────────

  it('bulk result reports continued, degraded, and skipped counts separately', async () => {
    // Seed three daemon-killed tasks with different resumability:
    //   - task A: intact worktree → 'continued'
    //   - task B: no worktree    → 'degraded' (degrades to restart)
    // Then verify the result has the right shape.
    const modules = await loadModules(repo)
    const { queue, DAEMON_KILLED_SIGNATURE } = modules

    const taskA = await queue.enqueueTask('task with worktree', undefined, { skipTriage: true })
    const taskB = await queue.enqueueTask('task without worktree', undefined, { skipTriage: true })

    const branchA = `task/${taskA.id}`
    const worktreeA = resolve(repo, '.mars', 'worktrees', taskA.id)
    execFileSync('git', ['worktree', 'add', '-qb', branchA, worktreeA], { cwd: repo, env: GIT_ENV })
    writeFileSync(resolve(worktreeA, 'work.ts'), 'export const done = true\n')
    execFileSync('git', ['add', 'work.ts'], { cwd: worktreeA, env: GIT_ENV })
    execFileSync('git', ['commit', '-qm', 'work'], { cwd: worktreeA, env: GIT_ENV })

    await queue.updateTask(taskA.id, {
      status: 'failed',
      failureSignature: DAEMON_KILLED_SIGNATURE,
      failedPhase: 'code',
      branch: branchA,
      worktreePath: worktreeA,
    })
    await queue.updateTask(taskB.id, {
      status: 'failed',
      failureSignature: DAEMON_KILLED_SIGNATURE,
      // No branch, no worktree → will degrade
    })

    const result = await runContinueAllDaemonKilled(modules)

    // Result has all three arrays.
    expect(Array.isArray(result.continued)).toBe(true)
    expect(Array.isArray(result.degraded)).toBe(true)
    expect(Array.isArray(result.skipped)).toBe(true)

    // Task A with intact worktree is in 'continued'.
    expect(result.continued).toContain(taskA.id)
    // Task B with no worktree degrades to restart and is in 'degraded'.
    expect(result.degraded).toContain(taskB.id)
    // Neither is in 'skipped' (no errors occurred).
    expect(result.skipped).toHaveLength(0)
  })

  // ── Cancellation guard ───────────────────────────────────────────────────────

  it('cancelled daemon-killed tasks are not resumed and do not appear in any result bucket', async () => {
    // A task with failureReason='cancelled' must be silently skipped — the user
    // explicitly stopped that work and the bulk continue must not override intent.
    const modules = await loadModules(repo)
    const { queue, DAEMON_KILLED_SIGNATURE } = modules

    const normalTask = await queue.enqueueTask('normal daemon-killed', undefined, { skipTriage: true })
    const cancelledTask = await queue.enqueueTask('cancelled daemon-killed', undefined, { skipTriage: true })

    // Both carry the daemon-killed signature; only one was cancelled.
    await queue.updateTask(normalTask.id, {
      status: 'failed',
      failureSignature: DAEMON_KILLED_SIGNATURE,
    })
    await queue.updateTask(cancelledTask.id, {
      status: 'failed',
      failureSignature: DAEMON_KILLED_SIGNATURE,
      failureReason: 'cancelled',
    })

    const result = await runContinueAllDaemonKilled(modules)

    // The normal task is resumed (continued or degraded — either is fine).
    const recovered = [...result.continued, ...result.degraded]
    expect(recovered).toContain(normalTask.id)

    // The cancelled task must NOT appear anywhere — completely excluded.
    expect(result.continued).not.toContain(cancelledTask.id)
    expect(result.degraded).not.toContain(cancelledTask.id)
    expect(result.skipped).not.toContain(cancelledTask.id)

    // The cancelled task must remain failed, untouched.
    const cancelledRow = await queue.getTask(cancelledTask.id)
    expect(cancelledRow?.status).toBe('failed')
    expect(cancelledRow?.failureReason).toBe('cancelled')
  })

  // ── Missing worktree on disk degrades to restart ─────────────────────────────

  it('daemon-killed task whose worktree path is gone from disk degrades to restart', async () => {
    // The worktree path was recorded but the directory no longer exists (e.g.
    // host reboot, manual cleanup). The continue path detects this and degrades.
    const modules = await loadModules(repo)
    const { queue, DAEMON_KILLED_SIGNATURE } = modules

    const task = await queue.enqueueTask('disappeared worktree', undefined, { skipTriage: true })
    await queue.updateTask(task.id, {
      status: 'failed',
      failureSignature: DAEMON_KILLED_SIGNATURE,
      failedPhase: 'code',
      branch: `task/${task.id}`,
      worktreePath: '/nonexistent/worktree/path/that/is/gone',
    })

    const result = await runContinueAllDaemonKilled(modules)

    // Must degrade — cannot resume a missing worktree.
    expect(result.degraded).toContain(task.id)
    expect(result.continued).not.toContain(task.id)
    expect(result.skipped).not.toContain(task.id)

    // Task is re-queued from restart (branch/worktree cleared).
    const updated = await queue.getTask(task.id)
    expect(updated?.status).toBe('queued')
  })
})
