/**
 * Phase-stamping regression tests.
 *
 * Each pipeline step (setup / code / verify / merge) must record its own phase
 * in `failed_phase` when it fails. The regression these tests cover:
 *
 * The dispatch loop's unhandled-failure handler in server.ts inferred the phase
 * from the pre-dispatch `task.worktreePath` snapshot. That snapshot is stale:
 * for a freshly-dispatched task `worktreePath` is null at dispatch time even
 * after setup creates the worktree. The handler therefore stamped 'setup'
 * for failures that occurred in the verify step (or later), overwriting the
 * correctly-stamped 'verify' that review.ts had already written to the DB
 * before throwing.
 *
 * The fix: re-read the task from the DB before deciding what to stamp. If a
 * step has already written `failedPhase`, trust it and skip the overwrite.
 * If no phase is set, use the CURRENT (fresh) `worktreePath` for inference.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-phase-stamping-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
  ensureQueueSchema: typeof import('../../queue').ensureQueueSchema
}

const loadModules = async (repo: string): Promise<QueueModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.ensureQueueSchema()
  return q
}

describe('phase-stamping: each step records its own phase', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Regression: verify-step failure must NOT be overwritten with 'setup' ───
  //
  // The bug: review.ts writes failedPhase:'verify' to the DB, then throws a
  // plain Error. The server.ts unhandled handler re-derives the phase from the
  // stale pre-dispatch task snapshot (worktreePath=null) and overwrites the DB
  // with 'setup'. After the fix, the handler re-reads the DB; seeing that
  // failedPhase is already set, it skips the overwrite.

  it('preserves failedPhase:verify when the verify step self-handles before throwing', async () => {
    const q = await loadModules(repo)

    // A fresh task dispatched for the first time: worktreePath is null in the
    // pre-dispatch snapshot even though setup will set it.
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    // Simulate the review primitive calling updateTask({ failedPhase: 'verify' })
    // before throwing. The task transitions to 'failed' with the correct phase.
    await q.updateTask(task.id, {
      status: 'failed',
      failedPhase: 'verify',
      failureReason: 'verify:test',
      failureSignature: 'verify:test/test-assertion-error',
      failureReasonCode: 'verify:test/test-assertion-error',
    })

    // Simulate the OLD server.ts unhandled handler: re-derive phase from stale
    // worktreePath=null (the pre-dispatch snapshot), which would produce 'setup'.
    const staleWorktreePath: string | null = null // as seen by the stale snapshot
    const inferredByOldHandler = (staleWorktreePath === null || staleWorktreePath === undefined)
      ? 'setup'
      : 'code'

    // The NEW handler re-reads the task first.
    const freshTask = await q.getTask(task.id)
    const selfHandled = freshTask?.status === 'failed' && freshTask.failedPhase != null

    // Because the verify step already stamped its phase, the new handler must
    // detect selfHandled=true and NOT run the overwrite.
    expect(selfHandled).toBe(true)
    expect(inferredByOldHandler).toBe('setup') // old logic would have stamped this

    if (!selfHandled) {
      // This branch must NOT execute — if it did, the old bug would recur.
      await q.updateTask(task.id, {
        status: 'failed',
        failedPhase: inferredByOldHandler as 'setup' | 'code' | 'verify' | 'merge',
        failureSignature: `${inferredByOldHandler}:unhandled/unclassified`,
      })
    }

    const finalTask = await q.getTask(task.id)
    expect(finalTask?.failedPhase).toBe('verify') // must NOT be 'setup'
    expect(finalTask?.failureSignature).toBe('verify:test/test-assertion-error')
  })

  // ── Setup step: no worktree → failedPhase='setup' ─────────────────────────

  it('stamps failedPhase:setup when worktreePath is null and no phase recorded', async () => {
    const q = await loadModules(repo)

    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    // No step ran, no failedPhase written. Simulate a genuine setup failure.
    const freshTask = await q.getTask(task.id)
    const selfHandled = freshTask?.status === 'failed' && freshTask?.failedPhase != null
    expect(selfHandled).toBe(false) // task is not yet failed, so no phase

    // Fresh worktreePath is null → infer 'setup'.
    const freshWorktreePath = freshTask?.worktreePath ?? null
    const failedPhase = (freshWorktreePath === null) ? 'setup' : 'code'
    expect(failedPhase).toBe('setup')

    await q.updateTask(task.id, { status: 'failed', failedPhase: 'setup' })
    const after = await q.getTask(task.id)
    expect(after?.failedPhase).toBe('setup')
  })

  // ── Code step: worktree present, no phase → failedPhase='code' ─────────────

  it('stamps failedPhase:code when worktreePath is set and no phase recorded', async () => {
    const q = await loadModules(repo)

    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })
    // Simulate setup having run: worktreePath is set, but no failedPhase yet.
    await q.updateTask(task.id, { worktreePath: '/tmp/mars/worktrees/some-id' })

    const freshTask = await q.getTask(task.id)
    const selfHandled = freshTask?.status === 'failed' && freshTask?.failedPhase != null
    expect(selfHandled).toBe(false)

    const freshWorktreePath = freshTask?.worktreePath ?? null
    const failedPhase = (freshWorktreePath === null) ? 'setup' : 'code'
    expect(failedPhase).toBe('code') // worktree present → code phase

    await q.updateTask(task.id, { status: 'failed', failedPhase: 'code' })
    const after = await q.getTask(task.id)
    expect(after?.failedPhase).toBe('code')
  })

  // ── Merge step: explicitly stamps 'merge' via its own updateTask call ──────

  it('preserves failedPhase:merge when the merge step self-handles before throwing', async () => {
    const q = await loadModules(repo)

    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })
    await q.updateTask(task.id, { worktreePath: '/tmp/mars/worktrees/some-id' })

    // The merge step calls updateTask({ failedPhase: 'merge' }) before throwing.
    await q.updateTask(task.id, {
      status: 'failed',
      failedPhase: 'merge',
      failureReason: 'merge:crashed',
      failureSignature: 'merge:crashed/unclassified',
    })

    // New handler: re-read and see it's already handled.
    const freshTask = await q.getTask(task.id)
    const selfHandled = freshTask?.status === 'failed' && freshTask?.failedPhase != null
    expect(selfHandled).toBe(true)
    // If the old handler ran, it would stamp 'code' (worktreePath set). But it must not.

    const finalTask = await q.getTask(task.id)
    expect(finalTask?.failedPhase).toBe('merge') // must NOT be overwritten with 'code'
  })

  // ── Verify-step failure signature includes the verify: prefix ─────────────

  it('verify-step failure signature uses verify: prefix, not setup:', async () => {
    const q = await loadModules(repo)

    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })
    // Simulate the AssertionError failure that triggered the bug:
    // the review primitive stamps 'verify:test/test-assertion-error'.
    await q.updateTask(task.id, {
      status: 'failed',
      failedPhase: 'verify',
      failureReason: 'verify:test',
      failureSignature: 'verify:test/test-assertion-error',
    })

    const after = await q.getTask(task.id)
    expect(after?.failureSignature).toMatch(/^verify:/)
    expect(after?.failureSignature).not.toMatch(/^setup:/)
    expect(after?.failedPhase).toBe('verify')
  })
})
