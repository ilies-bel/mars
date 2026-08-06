import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-continue-pre-setup-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@mars'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Mars Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'baseline.ts'), 'export const fixed = false\n')
  execFileSync('git', ['add', 'baseline.ts'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo })
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

  // ── failedPhase 'code' with no worktree → degrades to restart ─────────────
  // The task had failedPhase='code' but no branch/worktreePath were ever
  // recorded (e.g. a setup-time install failure before worktree creation).
  // The degrade happens because !task.branch && !task.worktreePath → isPreSetup.

  it('re-queues from setup when failedPhase is code but no worktree was created', async () => {
    const { queue, continueTask } = await loadModules(repo)

    const task = await queue.enqueueTask('test work', undefined, { skipTriage: true })
    await queue.updateTask(task.id, {
      status: 'failed',
      error: 'install step failed',
      failedPhase: 'code',
      // No branch or worktreePath — worktree was never created
    })

    const result = await continueTask.coreContinueTask(task.id)

    // Degrades because no worktree to preserve (not because failedPhase==='code')
    expect(result.degradedToRestart).toBe(true)

    const after = await queue.getTask(task.id)
    expect(after?.status).toBe('queued')
    expect(after?.failedPhase).toBeNull()
  })

  // ── failedPhase 'code' with existing worktree → resumes code phase ─────────

  it('resumes code phase without degrading when failedPhase is code and worktree exists', async () => {
    const { queue, continueTask } = await loadModules(repo)

    const task = await queue.enqueueTask('test work', undefined, { skipTriage: true })
    // Simulate a context-exhausted kill: failedPhase='code', worktree on disk.
    // Use the repo dir itself as the worktree path so existsSync returns true.
    await queue.updateTask(task.id, {
      status: 'failed',
      error: 'context-exhausted: coder hit the context token budget limit',
      failedPhase: 'code',
      branch: `task/${task.id}`,
      worktreePath: repo,
    })

    const result = await continueTask.coreContinueTask(task.id)

    expect(result.degradedToRestart).toBe(false)
    expect(result.coderResume).toBe(true)

    const after = await queue.getTask(task.id)
    expect(after?.status).toBe('queued')
    // failedPhase stays on the row — used by dispatchImplement to inject resume banner
    expect(after?.failedPhase).toBe('code')
    expect(after?.branch).toBe(`task/${task.id}`) // preserved
    expect(after?.error).toBeNull()
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

  it('refreshes a failed task branch with a fix that landed on main before resuming', async () => {
    const { queue, continueTask } = await loadModules(repo)
    const task = await queue.enqueueTask('test work', undefined, { skipTriage: true })
    const worktreePath = resolve(repo, '.mars', 'worktrees', task.id)
    const branch = `task/${task.id}`

    execFileSync('git', ['worktree', 'add', '-qb', branch, worktreePath], { cwd: repo })
    writeFileSync(resolve(worktreePath, 'feature.ts'), 'export const feature = true\n')
    execFileSync('git', ['add', 'feature.ts'], { cwd: worktreePath })
    execFileSync('git', ['commit', '-qm', 'task work'], { cwd: worktreePath })

    writeFileSync(resolve(repo, 'baseline.ts'), 'export const fixed = true\n')
    execFileSync('git', ['add', 'baseline.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'fix failing baseline'], { cwd: repo })

    await queue.updateTask(task.id, {
      status: 'failed',
      error: 'verify failed against stale baseline',
      failedPhase: 'verify',
      branch,
      worktreePath,
    })

    const result = await continueTask.coreContinueTask(task.id)

    expect(result.degradedToRestart).toBe(false)
    expect(readFileSync(resolve(worktreePath, 'baseline.ts'), 'utf-8')).toBe(
      'export const fixed = true\n',
    )
    expect(() =>
      execFileSync('git', ['merge-base', '--is-ancestor', 'main', 'HEAD'], { cwd: worktreePath }),
    ).not.toThrow()
  })

  it('reports a base refresh conflict instead of re-running the failed phase', async () => {
    const { queue, continueTask } = await loadModules(repo)
    const task = await queue.enqueueTask('test work', undefined, { skipTriage: true })
    const worktreePath = resolve(repo, '.mars', 'worktrees', task.id)
    const branch = `task/${task.id}`

    execFileSync('git', ['worktree', 'add', '-qb', branch, worktreePath], { cwd: repo })
    writeFileSync(resolve(worktreePath, 'baseline.ts'), 'export const fixed = taskVersion\n')
    execFileSync('git', ['add', 'baseline.ts'], { cwd: worktreePath })
    execFileSync('git', ['commit', '-qm', 'task baseline edit'], { cwd: worktreePath })

    writeFileSync(resolve(repo, 'baseline.ts'), 'export const fixed = mainVersion\n')
    execFileSync('git', ['add', 'baseline.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'main baseline fix'], { cwd: repo })

    await queue.updateTask(task.id, {
      status: 'failed',
      error: 'verify failed against stale baseline',
      failedPhase: 'verify',
      branch,
      worktreePath,
    })

    // Inject a null-returning supervisor so the test does not depend on
    // whether the claude binary is present in the test environment.
    const supervisorFn = async (): Promise<null> => null
    await expect(continueTask.coreContinueTask(task.id, { supervisorFn })).rejects.toThrow(/merging main.*conflicted/)

    const after = await queue.getTask(task.id)
    expect(after?.status).toBe('failed')
    expect(after?.failureReasonCode).toBe('continue:base-refresh-conflict')
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: worktreePath, encoding: 'utf-8' })).toBe('')

    const { listActionQueueItems } = await import('../../lib/action-queue')
    const actions = await listActionQueueItems('open', { kind: 'failed' })
    expect(actions.some((action) => action.signature === 'continue:base-refresh-conflict')).toBe(true)
  })

  // ── vcs-supervisor routing ────────────────────────────────────────────────

  it('routes a merge conflict to vcs-supervisor and re-queues the task on success', async () => {
    const { queue, continueTask } = await loadModules(repo)
    const task = await queue.enqueueTask('implement feature', undefined, { skipTriage: true })
    const worktreePath = resolve(repo, '.mars', 'worktrees', task.id)
    const branch = `task/${task.id}`

    execFileSync('git', ['worktree', 'add', '-qb', branch, worktreePath], { cwd: repo })
    // Task branch edits baseline.ts
    writeFileSync(resolve(worktreePath, 'baseline.ts'), 'export const fixed = taskVersion\n')
    execFileSync('git', ['add', 'baseline.ts'], { cwd: worktreePath })
    execFileSync('git', ['commit', '-qm', 'task edit'], { cwd: worktreePath })

    // main also edits baseline.ts → conflict when merging main into task branch
    writeFileSync(resolve(repo, 'baseline.ts'), 'export const fixed = mainVersion\n')
    execFileSync('git', ['add', 'baseline.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'main fix'], { cwd: repo })

    await queue.updateTask(task.id, {
      status: 'failed',
      error: 'verify failed',
      failedPhase: 'verify',
      branch,
      worktreePath,
    })

    let supervisorInvoked = false
    // The supervisor mock resolves the conflict by writing the final content,
    // staging, and committing — completing the in-progress merge.
    const supervisorFn = async (_branch: string, _integrationBranch: string, cwd: string): Promise<unknown> => {
      supervisorInvoked = true
      writeFileSync(resolve(cwd, 'baseline.ts'), 'export const fixed = resolved\n')
      execFileSync('git', ['add', 'baseline.ts'], { cwd })
      execFileSync(
        'git',
        ['-c', 'user.email=vega@test', '-c', 'user.name=Vega', 'commit', '-m', 'merge: resolve conflict'],
        { cwd },
      )
      return { exitCode: 0 }
    }

    const result = await continueTask.coreContinueTask(task.id, { supervisorFn })

    expect(supervisorInvoked).toBe(true)
    expect(result.degradedToRestart).toBe(false)

    const after = await queue.getTask(task.id)
    expect(after?.status).toBe('queued')
    expect(after?.error).toBeNull()
  })

  it('error when no resolver available names worktree path, branch, conflicted files, and mars restart fallback', async () => {
    const { queue, continueTask } = await loadModules(repo)
    const task = await queue.enqueueTask('implement feature', undefined, { skipTriage: true })
    const worktreePath = resolve(repo, '.mars', 'worktrees', task.id)
    const branch = `task/${task.id}`

    execFileSync('git', ['worktree', 'add', '-qb', branch, worktreePath], { cwd: repo })
    writeFileSync(resolve(worktreePath, 'baseline.ts'), 'export const fixed = taskVersion\n')
    execFileSync('git', ['add', 'baseline.ts'], { cwd: worktreePath })
    execFileSync('git', ['commit', '-qm', 'task edit'], { cwd: worktreePath })

    writeFileSync(resolve(repo, 'baseline.ts'), 'export const fixed = mainVersion\n')
    execFileSync('git', ['add', 'baseline.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'main fix'], { cwd: repo })

    await queue.updateTask(task.id, {
      status: 'failed',
      error: 'verify failed',
      failedPhase: 'verify',
      branch,
      worktreePath,
    })

    let thrown: Error | null = null
    try {
      await continueTask.coreContinueTask(task.id, { supervisorFn: async () => null })
    } catch (e) {
      thrown = e as Error
    }

    expect(thrown).not.toBeNull()
    // Error must name the worktree path, the branch, and the conflicting file
    expect(thrown!.message).toContain(worktreePath)
    expect(thrown!.message).toContain(branch)
    expect(thrown!.message).toMatch(/baseline\.ts/)
    // Must state the mars restart fallback
    expect(thrown!.message).toMatch(/mars restart/)
    // Must give the manual resolution commands
    expect(thrown!.message).toMatch(/git merge/)
  })

  it('leaves the worktree clean with no MERGE_HEAD when the supervisor fails', async () => {
    const { queue, continueTask } = await loadModules(repo)
    const task = await queue.enqueueTask('implement feature', undefined, { skipTriage: true })
    const worktreePath = resolve(repo, '.mars', 'worktrees', task.id)
    const branch = `task/${task.id}`

    execFileSync('git', ['worktree', 'add', '-qb', branch, worktreePath], { cwd: repo })
    writeFileSync(resolve(worktreePath, 'baseline.ts'), 'export const fixed = taskVersion\n')
    execFileSync('git', ['add', 'baseline.ts'], { cwd: worktreePath })
    execFileSync('git', ['commit', '-qm', 'task edit'], { cwd: worktreePath })

    writeFileSync(resolve(repo, 'baseline.ts'), 'export const fixed = mainVersion\n')
    execFileSync('git', ['add', 'baseline.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'main fix'], { cwd: repo })

    await queue.updateTask(task.id, {
      status: 'failed',
      error: 'verify failed',
      failedPhase: 'verify',
      branch,
      worktreePath,
    })

    // Supervisor unavailable — should abort the merge cleanly
    await expect(
      continueTask.coreContinueTask(task.id, { supervisorFn: async () => null }),
    ).rejects.toThrow()

    // No in-progress merge left behind
    expect(() =>
      execFileSync('git', ['rev-parse', '--verify', 'MERGE_HEAD'], {
        cwd: worktreePath,
        stdio: 'pipe',
        encoding: 'utf-8',
      }),
    ).toThrow()

    // Working tree is clean
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: worktreePath, encoding: 'utf-8' }),
    ).toBe('')
  })

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

  it('rewinds a verify failure to the coder without discarding its committed work', async () => {
    const { queue, continueTask } = await loadModules(repo)
    const task = await queue.enqueueTask('add the missing task field', undefined, { skipTriage: true })
    const worktreePath = resolve(repo, '.mars', 'worktrees', task.id)
    const branch = `task/${task.id}`

    execFileSync('git', ['worktree', 'add', '-qb', branch, worktreePath], { cwd: repo })
    writeFileSync(resolve(worktreePath, 'feature.ts'), 'export const priority = 1\n')
    execFileSync('git', ['add', 'feature.ts'], { cwd: worktreePath })
    execFileSync('git', ['commit', '-qm', 'add task priority'], { cwd: worktreePath })
    const committedHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
    }).trim()

    const { createQueueWorkflowStore } = await import('../../../workflows/queue-workflow-store')
    const workflowStore = createQueueWorkflowStore(queue.resolveQueueClient())
    const now = Date.now()
    await workflowStore.createRun({
      id: task.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'failed',
      createdAt: now,
      updatedAt: now,
    })
    await workflowStore.putStep({
      runId: task.id,
      name: 'setup-worktree',
      status: 'completed',
      sha: null,
      startedAt: now,
      finishedAt: now,
      attempt: 1,
      summary: null,
      errorSummary: null,
      transcriptKey: null,
      resultJson: null,
    })
    await workflowStore.putStep({
      runId: task.id,
      name: 'run-claude-code',
      status: 'completed',
      sha: null,
      startedAt: now,
      finishedAt: now,
      attempt: 1,
      summary: null,
      errorSummary: null,
      transcriptKey: null,
      resultJson: null,
    })
    await workflowStore.putStep({
      runId: task.id,
      name: 'review',
      status: 'failed',
      sha: null,
      startedAt: now,
      finishedAt: now,
      attempt: 1,
      summary: null,
      errorSummary: 'typecheck failed: priority is missing',
      transcriptKey: null,
      resultJson: null,
    })
    await queue.updateTask(task.id, {
      status: 'failed',
      error: 'typecheck failed: priority is missing',
      failedPhase: 'verify',
      branch,
      worktreePath,
    })

    const result = await continueTask.coreContinueTask(task.id)

    expect(result).toEqual({ degradedToRestart: false, coderResume: true })
    expect(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
    }).trim()).toBe(committedHead)
    expect((await workflowStore.listSteps(task.id)).map((step) => step.name)).toEqual([
      'setup-worktree',
    ])
  })

  it('runs a custom workflow coder again before retrying verification', async () => {
    const { queue, continueTask } = await loadModules(repo)
    const task = await queue.enqueueTask('repair the failed verification', undefined, {
      skipTriage: true,
    })
    const { createQueueWorkflowStore } = await import('../../../workflows/queue-workflow-store')
    const { defineWorkflow, runWorkflow } = await import('@mars/workflow')
    const workflowStore = createQueueWorkflowStore(queue.resolveQueueClient())
    let verifyAttempts = 0
    const workflow = defineWorkflow({
      id: 'custom-task',
      async fn(ctx) {
        await ctx.step('setup', async () => undefined)
        await ctx.step('code', async () => undefined)
        await ctx.step('verify', async () => {
          verifyAttempts += 1
          if (verifyAttempts === 1) throw new Error('verify:typecheck failed')
        })
      },
    })

    const first = await runWorkflow(workflow, undefined, {
      store: workflowStore,
      runId: task.id,
    })
    expect(first.status).toBe('failed')
    await queue.updateTask(task.id, {
      status: 'failed',
      error: 'verify:typecheck failed',
      failedPhase: 'verify',
      branch: `task/${task.id}`,
      worktreePath: repo,
    })

    await continueTask.coreContinueTask(task.id)

    const events: Array<{ step: string | null; event: string }> = []
    const retried = await runWorkflow(workflow, undefined, {
      store: workflowStore,
      runId: task.id,
      onEvent: ({ step, event }) => events.push({ step, event }),
    })

    expect(retried.status).toBe('completed')
    const codeStarted = events.findIndex(
      ({ step, event }) => step === 'code' && event === 'step.started',
    )
    const verifyStarted = events.findIndex(
      ({ step, event }) => step === 'verify' && event === 'step.started',
    )
    expect(codeStarted).toBeGreaterThanOrEqual(0)
    expect(codeStarted).toBeLessThan(verifyStarted)
  })

  // ── Auto-commit dirty worktree before code-phase resume ───────────────────

  it('auto-commits dirty worktree before code-phase resume', async () => {
    // Set up a real git repo with an initial commit so we can inspect git log.
    const gitRepo = mkdtempSync(resolve(tmpdir(), 'mars-continue-autocommit-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: gitRepo })
      execFileSync('git', ['-c', 'user.email=test@test', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'initial'], { cwd: gitRepo })

      const { queue, continueTask } = await loadModules(gitRepo)

      const task = await queue.enqueueTask('test work', undefined, { skipTriage: true })
      await queue.updateTask(task.id, {
        status: 'failed',
        error: 'context-exhausted',
        failedPhase: 'code',
        branch: `task/${task.id}`,
        worktreePath: gitRepo,
      })

      // Create an untracked file to simulate dangling work.
      writeFileSync(resolve(gitRepo, 'wip-file.ts'), 'export const x = 1\n')

      const result = await continueTask.coreContinueTask(task.id)

      expect(result.degradedToRestart).toBe(false)
      expect(result.coderResume).toBe(true)

      // Verify a wip commit was created.
      const log = execFileSync('git', ['log', '--oneline'], {
        cwd: gitRepo,
        encoding: 'utf-8',
      }).trim()
      expect(log).toMatch(/wip:/)
    } finally {
      rmSync(gitRepo, { recursive: true, force: true })
    }
  })
})
