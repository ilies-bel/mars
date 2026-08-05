/**
 * Tests for coreRemergeTask — re-verify + merge an existing ahead-of-main
 * branch without re-running the coder.
 *
 * Covers:
 *  - Happy path: branch exists and is ahead → task queued with workflow='remerge'
 *  - Rejects when task not found (NOT_FOUND)
 *  - Rejects when task is in a non-terminal status (WRONG_STATUS)
 *  - Rejects when branch does not exist (NO_BRANCH)
 *  - Rejects when branch has no un-integrated commits (NO_COMMITS_AHEAD)
 *  - Removes existing worktree but preserves the branch
 *  - Clears the workflow run journal
 *  - coreRestartTask clears workflow='remerge' on a subsequent restart
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, mkdirSync as mkdir } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { InMemoryStore } from '@mars/workflow'

/** Create a minimal git repo with one commit on main so listUniqueCommitsAhead has a base. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-remerge-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  writeFileSync(resolve(repo, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repo })
  return repo
}

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as typeof import('../../queue')
  await q.migrateQueueSchema()
  const remerge = (await import('../remerge-task')) as typeof import('../remerge-task')
  const restart = (await import('../restart-task')) as typeof import('../restart-task')
  return { q, remerge, restart }
}

const branchExists = (repo: string, branch: string): boolean =>
  execFileSync('git', ['branch', '--list', branch], { cwd: repo }).toString().trim() !== ''

describe('coreRemergeTask', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.INTEGRATION_BRANCH
    rmSync(repo, { recursive: true, force: true })
    vi.resetModules()
  })

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('queues a failed task with workflow=remerge when branch is ahead of main', async () => {
    const { q, remerge } = await loadModules(repo)

    const task = await q.enqueueTask('fix something', undefined, { skipTriage: true })
    const branch = `task/${task.id}`

    // Create the task branch with a commit ahead of main
    execFileSync('git', ['checkout', '-b', branch], { cwd: repo })
    writeFileSync(resolve(repo, 'fix.ts'), 'export const fix = true\n')
    execFileSync('git', ['add', 'fix.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'implement fix'], { cwd: repo })
    execFileSync('git', ['checkout', 'main'], { cwd: repo })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', branch = ?, error = 'merge conflict' WHERE id = ?`,
      args: [branch, task.id],
    })

    const result = await remerge.coreRemergeTask(task.id, new Set(['failed']), new InMemoryStore())

    expect(result.status).toBe('queued')

    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('queued')
    expect(updated?.workflow).toBe('remerge')
    expect(updated?.error).toBeNull()
    expect(updated?.failedPhase).toBeNull()
    expect(updated?.failureSignature).toBeNull()
    expect(updated?.failureReasonCode).toBeNull()
  })

  it('preserves the branch — remerge never deletes it', async () => {
    const { q, remerge } = await loadModules(repo)

    const task = await q.enqueueTask('keep my branch', undefined, { skipTriage: true })
    const branch = `task/${task.id}`

    execFileSync('git', ['checkout', '-b', branch], { cwd: repo })
    writeFileSync(resolve(repo, 'work.ts'), 'export const work = 1\n')
    execFileSync('git', ['add', 'work.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'good work commit'], { cwd: repo })
    execFileSync('git', ['checkout', 'main'], { cwd: repo })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', branch = ? WHERE id = ?`,
      args: [branch, task.id],
    })

    await remerge.coreRemergeTask(task.id, new Set(['failed']), new InMemoryStore())

    expect(branchExists(repo, branch)).toBe(true)
  })

  it('clears the workflow run journal so the remerge pipeline starts fresh', async () => {
    const { q, remerge } = await loadModules(repo)

    const task = await q.enqueueTask('clear journal test', undefined, { skipTriage: true })
    const branch = `task/${task.id}`

    execFileSync('git', ['checkout', '-b', branch], { cwd: repo })
    writeFileSync(resolve(repo, 'impl.ts'), 'export const impl = true\n')
    execFileSync('git', ['add', 'impl.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'implement'], { cwd: repo })
    execFileSync('git', ['checkout', 'main'], { cwd: repo })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', branch = ? WHERE id = ?`,
      args: [branch, task.id],
    })

    // Seed the workflow store with a stale completed run from the old implement pipeline
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
      summary: 'ok',
      errorSummary: null,
      transcriptKey: null,
      resultJson: '"done"',
    })
    await store.putStep({
      runId: task.id,
      name: 'run-claude-code',
      status: 'completed',
      sha: null,
      startedAt: Date.now(),
      finishedAt: Date.now() + 200,
      attempt: 1,
      summary: 'ok',
      errorSummary: null,
      transcriptKey: null,
      resultJson: '"done"',
    })

    // remerge clears the journal
    await remerge.coreRemergeTask(task.id, new Set(['failed']), store)

    // After clearing, the run should be gone (InMemoryStore returns undefined for absent runs)
    const run = await store.getRun(task.id)
    expect(run).toBeUndefined()
  })

  // ── Rejection guards ────────────────────────────────────────────────────────

  it('throws NOT_FOUND when the task does not exist', async () => {
    const { remerge } = await loadModules(repo)

    await expect(
      remerge.coreRemergeTask('no-such-task', new Set(['failed']), new InMemoryStore()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('throws WRONG_STATUS when the task is not in an eligible status', async () => {
    const { q, remerge } = await loadModules(repo)

    const task = await q.enqueueTask('queued task', undefined, { skipTriage: true })
    // Task is 'queued' — not in allowedStatuses

    await expect(
      remerge.coreRemergeTask(task.id, new Set(['failed']), new InMemoryStore()),
    ).rejects.toMatchObject({ code: 'WRONG_STATUS' })
  })

  it('throws NO_BRANCH when the task branch does not exist in git', async () => {
    const { q, remerge } = await loadModules(repo)

    const task = await q.enqueueTask('no branch task', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [task.id],
    })
    // Do NOT create the branch — it should be absent

    await expect(
      remerge.coreRemergeTask(task.id, new Set(['failed']), new InMemoryStore()),
    ).rejects.toMatchObject({ code: 'NO_BRANCH' })
  })

  it('throws NO_COMMITS_AHEAD when the branch is at the integration tip', async () => {
    const { q, remerge } = await loadModules(repo)

    const task = await q.enqueueTask('no work task', undefined, { skipTriage: true })
    const branch = `task/${task.id}`

    // Create branch at main tip — zero commits ahead
    execFileSync('git', ['branch', branch], { cwd: repo })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', branch = ? WHERE id = ?`,
      args: [branch, task.id],
    })

    await expect(
      remerge.coreRemergeTask(task.id, new Set(['failed']), new InMemoryStore()),
    ).rejects.toMatchObject({ code: 'NO_COMMITS_AHEAD' })
  })

  // ── Restart clears remerge workflow override ────────────────────────────────

  it('coreRestartTask clears workflow=remerge so a subsequent full restart runs the default pipeline', async () => {
    const { q, remerge, restart } = await loadModules(repo)

    const task = await q.enqueueTask('restart after remerge', undefined, { skipTriage: true })
    const branch = `task/${task.id}`

    execFileSync('git', ['checkout', '-b', branch], { cwd: repo })
    writeFileSync(resolve(repo, 'file.ts'), 'export const x = 1\n')
    execFileSync('git', ['add', 'file.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'work'], { cwd: repo })
    execFileSync('git', ['checkout', 'main'], { cwd: repo })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', branch = ? WHERE id = ?`,
      args: [branch, task.id],
    })

    const store = new InMemoryStore()

    // First: remerge sets workflow='remerge'
    await remerge.coreRemergeTask(task.id, new Set(['failed']), store)
    const afterRemerge = await q.getTask(task.id)
    expect(afterRemerge?.workflow).toBe('remerge')

    // Simulate the remerge failing (verify rejected the branch)
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', failure_reason_code = 'verify:branch-contaminated' WHERE id = ?`,
      args: [task.id],
    })

    // Then: restart should clear workflow back to null
    await restart.coreRestartTask(task.id, new Set(['failed']), store, { force: true })
    const afterRestart = await q.getTask(task.id)
    expect(afterRestart?.workflow).toBeNull()
    expect(afterRestart?.status).toBe('queued')
  })
})
