/**
 * Tests for the `mars release` CLI command.
 *
 * Uses the in-process command seam (ADR-0023) with a recording fake daemon so
 * tests assert on CLI behaviour and daemon calls without spawning a real daemon.
 *
 * The dirty-worktree guard (`release` with uncommitted changes) is verified
 * against a real git worktree to satisfy the cross-boundary check requirement.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  runCommandInProcess,
  makeFakeDaemon,
  type InProcessOptions,
} from '../test-adapter'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'

const here = dirname(fileURLToPath(import.meta.url))
// src/cli/commands -> src/cli -> src -> orchestrator
const projectRoot = resolve(here, '..', '..', '..')

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-human-tasks-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const loadStoreAndCtx = async (): Promise<{
  store: DomainTaskStore
  ctx: OrchestratorContext
}> => {
  const queueModule = await import('../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../core/store/task-store')
  const contextModule = await import('../../core/context')
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

const baseOpts = async (
  daemonResponder?: Parameters<typeof makeFakeDaemon>[0],
): Promise<InProcessOptions> => {
  const fake = makeFakeDaemon(daemonResponder)
  const { store, ctx } = await loadStoreAndCtx()
  return { store, ctx, daemon: fake }
}

/**
 * Create a task in 'awaiting-human' status with the given leaseOwner.
 * Uses updateTask directly (bypasses Arc) for test setup only.
 */
const createAwaitingHumanTask = async (
  leaseOwner: string | null,
  worktreePath?: string | null,
): Promise<string> => {
  const { enqueueTask, updateTask } = await import('../../core/queue')
  const task = await enqueueTask('test task for human work', undefined, {
    skipTriage: true,
  })
  await updateTask(task.id, {
    status: 'awaiting-human',
    branch: `task/${task.id}`,
    worktreePath: worktreePath ?? null,
    leaseOwner,
    leasedAt: leaseOwner !== null ? new Date().toISOString() : null,
  })
  return task.id
}

beforeEach(() => {
  repo = setupRepo()
  vi.resetModules()
  process.env.MARS_REPO = repo
})

afterEach(() => {
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// mars release
// ---------------------------------------------------------------------------

describe('mars release', () => {
  it('sends release-lease request and outputs re-queued message', async () => {
    // Create a clean git worktree so the dirty-worktree check passes.
    const wt = mkdtempSync(resolve(tmpdir(), 'mars-wt-clean-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: wt })
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: wt })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: wt })
      // Commit something so the worktree is clean (no staged/unstaged)
      writeFileSync(resolve(wt, 'README.md'), 'hello')
      execFileSync('git', ['add', '.'], { cwd: wt })
      execFileSync('git', ['commit', '-m', 'initial', '--allow-empty'], { cwd: wt })

      const taskId = await createAwaitingHumanTask('user@host', wt)
      const fake = makeFakeDaemon(() => undefined)
      const { store, ctx } = await loadStoreAndCtx()

      const r = await runCommandInProcess(['release', taskId], { store, ctx, daemon: fake })

      expect(r.code).toBe(0)
      expect(fake.calls).toHaveLength(1)
      const req = fake.calls[0] as { op: string; id: string; abort: boolean }
      expect(req.op).toBe('release-lease')
      expect(req.id).toBe(taskId)
      expect(req.abort).toBe(false)
      expect(r.out.join('\n')).toContain('re-queued')
    } finally {
      rmSync(wt, { recursive: true, force: true })
    }
  })

  it('--abort: sends release-lease with abort=true and outputs failure-path message', async () => {
    const wt = mkdtempSync(resolve(tmpdir(), 'mars-wt-abort-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: wt })
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: wt })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: wt })
      writeFileSync(resolve(wt, 'README.md'), 'hello')
      execFileSync('git', ['add', '.'], { cwd: wt })
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: wt })

      const taskId = await createAwaitingHumanTask('user@host', wt)
      const fake = makeFakeDaemon(() => undefined)
      const { store, ctx } = await loadStoreAndCtx()

      const r = await runCommandInProcess(['release', '--abort', taskId], {
        store,
        ctx,
        daemon: fake,
      })

      expect(r.code).toBe(0)
      expect(fake.calls).toHaveLength(1)
      const req = fake.calls[0] as { op: string; id: string; abort: boolean }
      expect(req.op).toBe('release-lease')
      expect(req.abort).toBe(true)
      expect(r.out.join('\n')).toContain('failure path')
    } finally {
      rmSync(wt, { recursive: true, force: true })
    }
  })

  it('refuses on dirty worktree (real git check)', async () => {
    // Create a worktree with an uncommitted (untracked) file — git status
    // returns non-empty output so the guard fires.
    const wt = mkdtempSync(resolve(tmpdir(), 'mars-wt-dirty-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: wt })
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: wt })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: wt })
      // Add an untracked file (dirty worktree)
      writeFileSync(resolve(wt, 'dirty.txt'), 'uncommitted')

      const taskId = await createAwaitingHumanTask('user@host', wt)
      const fake = makeFakeDaemon(() => undefined)
      const { store, ctx } = await loadStoreAndCtx()

      const r = await runCommandInProcess(['release', taskId], { store, ctx, daemon: fake })

      expect(r.code).toBe(1)
      const errJoined = r.err.join('\n')
      expect(errJoined).toContain('uncommitted changes')
      // Daemon should NOT have been called
      expect(fake.calls).toHaveLength(0)
    } finally {
      rmSync(wt, { recursive: true, force: true })
    }
  })

  it('refuses when task is not in awaiting-human status', async () => {
    // Create a task in 'queued' status (not awaiting-human)
    const { enqueueTask } = await import('../../core/queue')
    const task = await enqueueTask('test queued task', undefined, { skipTriage: true })
    const fake = makeFakeDaemon(() => undefined)
    const { store, ctx } = await loadStoreAndCtx()

    const r = await runCommandInProcess(['release', task.id], { store, ctx, daemon: fake })

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toMatch(/awaiting-human/)
    expect(fake.calls).toHaveLength(0)
  })

  it('refuses when no active lease is set', async () => {
    const taskId = await createAwaitingHumanTask(null)
    const fake = makeFakeDaemon(() => undefined)
    const { store, ctx } = await loadStoreAndCtx()

    const r = await runCommandInProcess(['release', taskId], { store, ctx, daemon: fake })

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('no active lease')
    expect(fake.calls).toHaveLength(0)
  })

  it('returns usage error when no task id is provided', async () => {
    const opts = await baseOpts()
    const r = await runCommandInProcess(['release'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('usage: mars release')
  })
})
