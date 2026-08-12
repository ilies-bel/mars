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

  // ── Branch-ahead guard: failedPhase null but commits exist ────────────────
  // This is the real-world scenario from the bug report: the daemon was
  // restarted while a task was in flight (no failedPhase recorded), but the
  // coder had already landed commits on the branch. `mars continue` must NOT
  // silently restart and discard those commits. Instead it must exit non-zero
  // and name `mars remerge` as the correct alternative.

  it('exits non-zero and names mars remerge when failedPhase is null but branch is ahead of main', async () => {
    const { queue, continueTask } = await loadModules(repo)

    const task = await queue.enqueueTask('add feature Y', undefined, { skipTriage: true })
    const branch = `task/${task.id}`
    const worktreePath = resolve(repo, '.mars', 'worktrees', task.id)

    // Create a worktree with a commit — simulating work the coder landed
    // before the daemon was restarted (killing the task without recording phase).
    execFileSync('git', ['worktree', 'add', '-qb', branch, worktreePath], { cwd: repo })
    writeFileSync(resolve(worktreePath, 'feature-y.ts'), 'export const y = 1\n')
    execFileSync('git', ['add', 'feature-y.ts'], { cwd: worktreePath })
    execFileSync('git', ['commit', '-qm', 'feat: add feature Y'], { cwd: worktreePath })

    // Stamp the task row as if the daemon killed it mid-flight (no failedPhase).
    await queue.updateTask(task.id, {
      status: 'failed',
      error: 'daemon killed mid-flight',
      failedPhase: null,  // explicitly null — this is the scenario
      branch,
      worktreePath,
    })

    // continue must reject — not restart — and name mars remerge.
    let thrown: Error | null = null
    try {
      await continueTask.coreContinueTask(task.id)
    } catch (e) {
      thrown = e as Error
    }

    expect(thrown).not.toBeNull()
    // The error must be framed as what `continue` could not do.
    expect(thrown!.message).toContain('mars continue')
    expect(thrown!.message).toContain('failed_phase was not recorded')
    // Must name the right alternative — not restart --force.
    expect(thrown!.message).toContain('mars remerge')
    expect(thrown!.message).toContain(task.id)
    // Must NOT suggest --force (which would discard work).
    expect(thrown!.message).not.toContain('--force')
    // The branch name must be mentioned so the operator knows what is at risk.
    expect(thrown!.message).toContain(branch)

    // The task must remain in 'failed' status — no restart was performed.
    const after = await queue.getTask(task.id)
    expect(after?.status).toBe('failed')
    // The branch and worktreePath must be preserved — no cleanup happened.
    expect(after?.branch).toBe(branch)
    expect(after?.worktreePath).toBe(worktreePath)
  })

  it('still degrades to restart when failedPhase is null and branch has no commits ahead', async () => {
    // A task with failedPhase=null but a branch that is at the same point
    // as main (0 unique commits). There is nothing to lose; degrading to
    // restart is correct and must still work.
    const { queue, continueTask } = await loadModules(repo)

    const task = await queue.enqueueTask('background work', undefined, { skipTriage: true })
    const branch = `task/${task.id}`
    const worktreePath = resolve(repo, '.mars', 'worktrees', task.id)

    // Branch with no commits ahead of main (just mirrors the initial commit).
    execFileSync('git', ['worktree', 'add', '-qb', branch, worktreePath], { cwd: repo })
    // No additional commits — branch tip == main tip.

    await queue.updateTask(task.id, {
      status: 'failed',
      error: 'killed before coder ran',
      failedPhase: null,
      branch,
      worktreePath,
    })

    const result = await continueTask.coreContinueTask(task.id)

    // Degrades to restart: no committed work to protect.
    expect(result.degradedToRestart).toBe(true)
    const after = await queue.getTask(task.id)
    expect(after?.status).toBe('queued')
    expect(after?.branch).toBeNull()
    expect(after?.worktreePath).toBeNull()
  })

  // ── Kill-handler fix: failedPhase recorded after daemon kill ──────────────
  // After the fix to the kill handler (`mars daemon kill` now records
  // failedPhase: 'code' for implement/triage/refine tasks), `mars continue`
  // can resume those tasks normally instead of degrading to restart or
  // confusing the operator with a restart-framed error.

  it('resumes normally when failedPhase is code (as recorded by the fixed kill handler)', async () => {
    // Simulate the state the kill handler writes after the fix:
    //   status='failed', failedPhase='code', failureSignature=DAEMON_KILLED_SIGNATURE,
    //   branch and worktreePath set (coder had started working).
    const { queue, continueTask } = await loadModules(repo)
    const { DAEMON_KILLED_SIGNATURE } = (await import('../../lib/retry-budget')) as typeof import('../../lib/retry-budget')

    const task = await queue.enqueueTask('task that was mid-code when daemon killed', undefined, { skipTriage: true })

    await queue.updateTask(task.id, {
      status: 'failed',
      failureSignature: DAEMON_KILLED_SIGNATURE,
      error: 'killed by `mars daemon kill`',
      failedPhase: 'code',    // now recorded by the fixed kill handler
      branch: `task/${task.id}`,
      worktreePath: repo,     // repo dir exists on disk (simulates intact worktree)
    })

    const result = await continueTask.coreContinueTask(task.id)

    // Resumes in the coder — no degradation.
    expect(result.degradedToRestart).toBe(false)
    expect(result.coderResume).toBe(true)

    const after = await queue.getTask(task.id)
    expect(after?.status).toBe('queued')
    expect(after?.failedPhase).toBe('code')     // preserved for the coder resume banner
    expect(after?.branch).toBe(`task/${task.id}`)  // branch preserved
  })

  // ── Salvage-checkpoint branch detection ───────────────────────────────────
  // The three shapes the branch-ahead guard must handle when failedPhase is
  // null and the branch has commits ahead of main:
  //
  //  A. checkpoint-only  → no remerge offered; restart with discard warning
  //  B. real-only        → remerge offered (existing behaviour, regression guard)
  //  C. mixed            → remerge offered with checkpoint called out at tip

  it('checkpoint-only: does not offer remerge and names restart when every commit is a salvage checkpoint', async () => {
    const { queue, continueTask } = await loadModules(repo)

    const task = await queue.enqueueTask('checkpoint-only task', undefined, { skipTriage: true })
    const branch = `task/${task.id}`
    const worktreePath = resolve(repo, '.mars', 'worktrees', task.id)

    execFileSync('git', ['worktree', 'add', '-qb', branch, worktreePath], { cwd: repo })
    // Write a file to give the checkpoint something to capture
    writeFileSync(resolve(worktreePath, 'wip.ts'), 'export const x = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: worktreePath })
    // Commit with the salvage checkpoint subject (mirrors what the workflow does)
    execFileSync('git', [
      '-c', 'user.email=mars@test', '-c', 'user.name=Mars',
      'commit', '-m', 'wip(checkpoint): coder killed (exit 1) with 1 uncommitted path(s) — do not merge as-is',
    ], { cwd: worktreePath })

    await queue.updateTask(task.id, {
      status: 'failed',
      error: 'killed',
      failedPhase: null,
      branch,
      worktreePath,
    })

    let thrown: Error | null = null
    try {
      await continueTask.coreContinueTask(task.id)
    } catch (e) {
      thrown = e as Error
    }

    expect(thrown).not.toBeNull()
    // Must describe the checkpoint situation
    expect(thrown!.message).toContain('salvage checkpoint')
    // Must NOT offer mars remerge — there is no reviewed work
    expect(thrown!.message).not.toContain('mars remerge')
    // Must offer restart as the escape hatch
    expect(thrown!.message).toContain('mars restart')
    expect(thrown!.message).toContain(task.id)
    // Must name the branch so the operator knows what is at risk
    expect(thrown!.message).toContain(branch)
    // Task remains failed — no restart was performed
    const after = await queue.getTask(task.id)
    expect(after?.status).toBe('failed')
  })

  it('real-commits-only: still offers mars remerge when no commit is a salvage checkpoint', async () => {
    // Regression guard: the existing behaviour must be preserved for branches
    // that contain only real, human-reviewed commits.
    const { queue, continueTask } = await loadModules(repo)

    const task = await queue.enqueueTask('real-only task', undefined, { skipTriage: true })
    const branch = `task/${task.id}`
    const worktreePath = resolve(repo, '.mars', 'worktrees', task.id)

    execFileSync('git', ['worktree', 'add', '-qb', branch, worktreePath], { cwd: repo })
    writeFileSync(resolve(worktreePath, 'feature.ts'), 'export const feature = true\n')
    execFileSync('git', ['add', 'feature.ts'], { cwd: worktreePath })
    execFileSync('git', [
      '-c', 'user.email=coder@test', '-c', 'user.name=Coder',
      'commit', '-m', 'feat: add feature',
    ], { cwd: worktreePath })

    await queue.updateTask(task.id, {
      status: 'failed',
      error: 'daemon killed mid-flight',
      failedPhase: null,
      branch,
      worktreePath,
    })

    let thrown: Error | null = null
    try {
      await continueTask.coreContinueTask(task.id)
    } catch (e) {
      thrown = e as Error
    }

    expect(thrown).not.toBeNull()
    // Must offer mars remerge — there is reviewed work to re-verify
    expect(thrown!.message).toContain('mars remerge')
    expect(thrown!.message).toContain(task.id)
    // Task remains failed
    const after = await queue.getTask(task.id)
    expect(after?.status).toBe('failed')
  })

  it('mixed: offers mars remerge but calls out the trailing salvage checkpoint', async () => {
    const { queue, continueTask } = await loadModules(repo)

    const task = await queue.enqueueTask('mixed task', undefined, { skipTriage: true })
    const branch = `task/${task.id}`
    const worktreePath = resolve(repo, '.mars', 'worktrees', task.id)

    execFileSync('git', ['worktree', 'add', '-qb', branch, worktreePath], { cwd: repo })

    // First: a real commit
    writeFileSync(resolve(worktreePath, 'feature.ts'), 'export const feature = true\n')
    execFileSync('git', ['add', 'feature.ts'], { cwd: worktreePath })
    execFileSync('git', [
      '-c', 'user.email=coder@test', '-c', 'user.name=Coder',
      'commit', '-m', 'feat: implement feature',
    ], { cwd: worktreePath })

    // Then: a trailing salvage checkpoint at the tip
    writeFileSync(resolve(worktreePath, 'wip.ts'), 'export const wip = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: worktreePath })
    execFileSync('git', [
      '-c', 'user.email=mars@test', '-c', 'user.name=Mars',
      'commit', '-m', 'wip(checkpoint): coder killed (exit 1) with 1 uncommitted path(s) — do not merge as-is',
    ], { cwd: worktreePath })

    await queue.updateTask(task.id, {
      status: 'failed',
      error: 'killed',
      failedPhase: null,
      branch,
      worktreePath,
    })

    let thrown: Error | null = null
    try {
      await continueTask.coreContinueTask(task.id)
    } catch (e) {
      thrown = e as Error
    }

    expect(thrown).not.toBeNull()
    // Must offer mars remerge — there is at least one real commit
    expect(thrown!.message).toContain('mars remerge')
    // Must also call out the trailing checkpoint so the operator knows verify
    // will see incomplete work
    expect(thrown!.message).toContain('salvage checkpoint')
    expect(thrown!.message).toContain(task.id)
    // Task remains failed
    const after = await queue.getTask(task.id)
    expect(after?.status).toBe('failed')
  })

  // ── Regression: worktree missing + failedPhase='code' + commits ahead ────
  // The operator ran `mars continue` and got "failed_phase was not recorded"
  // even though tasks.failed_phase was 'code'. Root cause: the worktree was
  // deleted (e.g. by a failed recovery task's cleanup), making isPreSetup=true.
  // The error must name the actual cause, never claim the column is unset.

  it('names worktree-missing cause when failedPhase is set but worktree is gone and branch has commits', async () => {
    const { queue, continueTask } = await loadModules(repo)

    const task = await queue.enqueueTask('add feature Z', undefined, { skipTriage: true })
    const branch = `task/${task.id}`
    const worktreePath = resolve(repo, '.mars', 'worktrees', task.id)

    // Create a worktree with a commit (e.g. the salvage checkpoint from a prior
    // recovery attempt) so the branch has work that must not be silently discarded.
    execFileSync('git', ['worktree', 'add', '-qb', branch, worktreePath], { cwd: repo })
    writeFileSync(resolve(worktreePath, 'feature-z.ts'), 'export const z = 1\n')
    execFileSync('git', ['add', 'feature-z.ts'], { cwd: worktreePath })
    execFileSync('git', ['commit', '-qm', 'wip: salvage checkpoint'], { cwd: worktreePath })

    // Now delete the worktree directory (simulating cleanup after a failed
    // recovery task), but keep the DB row and branch intact.
    execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repo })

    // Stamp the task row: failedPhase IS recorded but worktree is gone.
    await queue.updateTask(task.id, {
      status: 'failed',
      error: 'coder exited non-zero',
      failedPhase: 'code',
      branch,
      worktreePath,
    })

    let thrown: Error | null = null
    try {
      await continueTask.coreContinueTask(task.id)
    } catch (e) {
      thrown = e as Error
    }

    expect(thrown).not.toBeNull()
    // Must NOT claim "failed_phase was not recorded" — it IS recorded.
    expect(thrown!.message).not.toContain('failed_phase was not recorded')
    // Must name the actual cause: the worktree is missing.
    expect(thrown!.message).toContain('missing from disk')
    // Must name failed_phase='code' so the operator knows the column is set.
    expect(thrown!.message).toContain("failed_phase is 'code'")
    // Must suggest mars remerge (the committed work is recoverable).
    expect(thrown!.message).toContain('mars remerge')
    expect(thrown!.message).toContain(task.id)
    // Branch must be mentioned so the operator knows what to remerge.
    expect(thrown!.message).toContain(branch)

    // Task must remain failed — no restart was performed.
    const after = await queue.getTask(task.id)
    expect(after?.status).toBe('failed')
    expect(after?.branch).toBe(branch)
  })

  // ── Regression: settled failed recovery task must not block code-phase resume
  // Scenario: the origin task (failedPhase='code') has an arc whose recovery
  // task also failed (status='failed', fix_for_task_id=origin). The settled
  // (failed) recovery must not block `mars continue` on the origin — only
  // IN-FLIGHT recoveries block it.

  it('resolves to code-phase resume when a settled failed recovery task is in the arc', async () => {
    const { queue, continueTask } = await loadModules(repo)

    const origin = await queue.enqueueTask('implement the thing', undefined, { skipTriage: true })
    // Origin failed in code phase with an intact worktree.
    await queue.updateTask(origin.id, {
      status: 'failed',
      error: 'coder exited non-zero',
      failedPhase: 'code',
      branch: `task/${origin.id}`,
      worktreePath: repo,   // repo dir exists on disk — intact worktree
    })

    // Insert a FAILED recovery task for the origin. Its status='failed' means
    // it has settled and must not be treated as in-flight.
    const { getDefaultTaskStore } = (await import('../../store/task-store')) as typeof import('../../store/task-store')
    const store = await getDefaultTaskStore()
    const recoveryId = `mars-fix-settled`
    const now = new Date().toISOString()
    await store.execute({
      sql: `INSERT INTO tasks (id, prompt, status, fix_for_task_id, origin_id, priority, tag, kind, created_at, updated_at)
            VALUES (?, ?, 'failed', ?, ?, 0, 'coder', 'fix', ?, ?)`,
      args: [recoveryId, 'recover the thing', origin.id, origin.id, now, now],
    })

    // continue must succeed: the settled failed recovery does not block it.
    const result = await continueTask.coreContinueTask(origin.id)

    expect(result.degradedToRestart).toBe(false)
    expect(result.coderResume).toBe(true)

    const after = await queue.getTask(origin.id)
    expect(after?.status).toBe('queued')
    expect(after?.failedPhase).toBe('code')       // preserved for the coder banner
    expect(after?.branch).toBe(`task/${origin.id}`)
  })
})
