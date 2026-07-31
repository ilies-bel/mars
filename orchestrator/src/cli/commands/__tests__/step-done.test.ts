/**
 * Tests for `mars step done [<task-id>]` (slice mars-b0d5bbe4).
 *
 * Covers the four required behaviours:
 *   1. Happy path — task is awaiting-human with an active lease.
 *   2. Task-id lookup by CWD — no id arg; CWD is inside a worktree path.
 *   3. Wrong-mode-step error — task is running (auto step).
 *   4. Unknown-task error — task does not exist in the store.
 *
 * Uses the in-process command seam (ADR-0023) with a recording fake daemon so
 * tests assert on CLI behaviour without spawning a real daemon.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  runCommandInProcess,
  makeFakeDaemon,
  type InProcessOptions,
} from '../../test-adapter'
import type { DomainTaskStore } from '../../../core/store/task-store'
import type { OrchestratorContext } from '../../../core/context'

const _here = dirname(fileURLToPath(import.meta.url))

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-step-done-test-'))
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
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../../core/store/task-store')
  const contextModule = await import('../../../core/context')
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
 * Create a task in the given status with an optional leaseOwner.
 * Uses `updateTask` directly (bypasses Arc) for test setup only.
 */
const createTask = async (
  status: string,
  leaseOwner: string | null = null,
  worktreePath: string | null = null,
): Promise<string> => {
  const { enqueueTask, updateTask } = await import('../../../core/queue')
  const task = await enqueueTask('test step-done task', undefined, {
    skipTriage: true,
  })
  await updateTask(task.id, {
    status: status as Parameters<typeof updateTask>[1]['status'],
    branch: `task/${task.id}`,
    worktreePath,
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
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('mars step done — happy path', () => {
  it('sends step-done op to daemon and prints success', async () => {
    const taskId = await createTask('awaiting-human', 'user@host')
    const fake = makeFakeDaemon(() => ({}))
    const { store, ctx } = await loadStoreAndCtx()

    const r = await runCommandInProcess(['step', 'done', taskId], {
      store,
      ctx,
      daemon: fake,
    })

    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    const req = fake.calls[0] as { op: string; id: string }
    expect(req.op).toBe('step-done')
    expect(req.id).toBe(taskId)
    expect(r.out.join('\n')).toContain('manual step complete')
  })
})

// ---------------------------------------------------------------------------
// Task-id lookup by CWD
// ---------------------------------------------------------------------------

describe('mars step done — task-id from CWD', () => {
  it('detects task-id from CWD when no id arg is supplied', async () => {
    const taskId = await createTask('awaiting-human', 'user@host')
    const fake = makeFakeDaemon(() => ({}))
    const { store, ctx } = await loadStoreAndCtx()

    // Simulate operator CWD being inside the worktree for this task.
    const worktreeCwd = `${repo}${sep}.mars${sep}worktrees${sep}${taskId}`
    vi.spyOn(process, 'cwd').mockReturnValue(worktreeCwd)

    // No task-id arg supplied — command should derive it from CWD.
    const r = await runCommandInProcess(['step', 'done'], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    const req = fake.calls[0] as { op: string; id: string }
    expect(req.op).toBe('step-done')
    expect(req.id).toBe(taskId)
  })

  it('returns error when no id arg and CWD is not a worktree', async () => {
    const opts = await baseOpts()
    // CWD is the temp repo root — not a worktree path.
    vi.spyOn(process, 'cwd').mockReturnValue(repo)

    const r = await runCommandInProcess(['step', 'done'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('CWD is not inside a worktree')
  })
})

// ---------------------------------------------------------------------------
// Wrong-mode-step error (auto step)
// ---------------------------------------------------------------------------

describe('mars step done — wrong-mode-step error', () => {
  it('errors when task is running (auto step in progress)', async () => {
    const taskId = await createTask('running')
    const fake = makeFakeDaemon()
    const { store, ctx } = await loadStoreAndCtx()

    const r = await runCommandInProcess(['step', 'done', taskId], {
      store,
      ctx,
      daemon: fake,
    })

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('auto')
    // No daemon call should be made — error is caught before dispatching.
    expect(fake.calls).toHaveLength(0)
  })

  it('errors when task is queued (not yet at a manual step)', async () => {
    const taskId = await createTask('queued')
    const fake = makeFakeDaemon()
    const { store, ctx } = await loadStoreAndCtx()

    const r = await runCommandInProcess(['step', 'done', taskId], {
      store,
      ctx,
      daemon: fake,
    })

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('queued')
    expect(fake.calls).toHaveLength(0)
  })

  it('routes preview-gated tasks to the validate and reject commands', async () => {
    const taskId = await createTask('awaiting-validation')
    const fake = makeFakeDaemon()
    const { store, ctx } = await loadStoreAndCtx()

    const r = await runCommandInProcess(['step', 'done', taskId], {
      store,
      ctx,
      daemon: fake,
    })

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain(`mars validate ${taskId}`)
    expect(r.err.join('\n')).toContain(`mars reject ${taskId}`)
    expect(fake.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Unknown-task error
// ---------------------------------------------------------------------------

describe('mars step done — unknown-task error', () => {
  it('errors when the task does not exist', async () => {
    const opts = await baseOpts()

    const r = await runCommandInProcess(['step', 'done', 'mars-nonexistent'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('not found')
    expect((opts.daemon as ReturnType<typeof makeFakeDaemon>).calls).toHaveLength(0)
  })
})
