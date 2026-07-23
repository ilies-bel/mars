/**
 * Tests for `mars step reset <task-id> <step-name>`.
 *
 * Covers the required behaviours:
 *   1. Happy path — failed task, step exists; daemon gets the op and prints
 *      success with the next-step name and queue status.
 *   2. Missing arguments — usage error without contacting daemon.
 *   3. Active task (running) — refused before daemon contact.
 *   4. Leased task (awaiting-human with lease) — refused before daemon contact.
 *   5. Unknown task — not found error without daemon contact.
 *   6. Daemon error propagation — daemon throws, CLI surfaces it.
 *
 * Uses the in-process command seam (ADR-0023) with a recording fake daemon.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'
import {
  runCommandInProcess,
  makeFakeDaemon,
  type InProcessOptions,
} from '../../test-adapter'
import type { DomainTaskStore } from '../../../core/store/task-store'
import type { OrchestratorContext } from '../../../core/context'

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-step-reset-test-'))
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
 * Create a task in the given status, optionally with a lease.
 */
const createTask = async (
  status: string,
  leaseOwner: string | null = null,
): Promise<string> => {
  const { enqueueTask, updateTask } = await import('../../../core/queue')
  const task = await enqueueTask('test step-reset task', undefined, {
    skipTriage: true,
  })
  await updateTask(task.id, {
    status: status as Parameters<typeof updateTask>[1]['status'],
    branch: `task/${task.id}`,
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

describe('mars step reset — happy path', () => {
  it('sends step-reset op to daemon and prints next step + queue status', async () => {
    const taskId = await createTask('failed')
    const fake = makeFakeDaemon(() => ({
      nextStep: 'setup-worktree',
      queued: true,
      cleared: ['setup-worktree', 'run-claude-code', 'verify'],
    }))
    const { store, ctx } = await loadStoreAndCtx()

    const r = await runCommandInProcess(
      ['step', 'reset', taskId, 'setup-worktree'],
      { store, ctx, daemon: fake },
    )

    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    const req = fake.calls[0] as { op: string; id: string; stepName: string }
    expect(req.op).toBe('step-reset')
    expect(req.id).toBe(taskId)
    expect(req.stepName).toBe('setup-worktree')
    // Output must tell the operator the next step and status
    const outText = r.out.join('\n')
    expect(outText).toContain(`reset to step 'setup-worktree'`)
    expect(outText).toContain('queued for dispatch')
  })

  it('reports blocked status when task has incomplete blockers', async () => {
    const taskId = await createTask('failed')
    const fake = makeFakeDaemon(() => ({
      nextStep: 'verify',
      queued: false,
      cleared: ['verify'],
    }))
    const { store, ctx } = await loadStoreAndCtx()

    const r = await runCommandInProcess(
      ['step', 'reset', taskId, 'verify'],
      { store, ctx, daemon: fake },
    )

    expect(r.code).toBe(0)
    const outText = r.out.join('\n')
    expect(outText).toContain(`reset to step 'verify'`)
    expect(outText).toContain('blocked')
  })

  it('prints cleared-checkpoints summary when multiple steps cleared', async () => {
    const taskId = await createTask('failed')
    const fake = makeFakeDaemon(() => ({
      nextStep: 'setup-worktree',
      queued: true,
      cleared: ['setup-worktree', 'run-claude-code', 'verify'],
    }))
    const { store, ctx } = await loadStoreAndCtx()

    const r = await runCommandInProcess(
      ['step', 'reset', taskId, 'setup-worktree'],
      { store, ctx, daemon: fake },
    )

    expect(r.code).toBe(0)
    const outText = r.out.join('\n')
    expect(outText).toContain('cleared 3 step checkpoints')
  })

  it('blocked task can also be reset', async () => {
    const taskId = await createTask('blocked')
    const fake = makeFakeDaemon(() => ({
      nextStep: 'run-claude-code',
      queued: false,
      cleared: ['run-claude-code'],
    }))
    const { store, ctx } = await loadStoreAndCtx()

    const r = await runCommandInProcess(
      ['step', 'reset', taskId, 'run-claude-code'],
      { store, ctx, daemon: fake },
    )

    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

describe('mars step reset — argument validation', () => {
  it('returns usage error when task-id is missing', async () => {
    const opts = await baseOpts()
    const r = await runCommandInProcess(['step', 'reset'], opts)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('usage: mars step reset')
    expect((opts.daemon as ReturnType<typeof makeFakeDaemon>).calls).toHaveLength(0)
  })

  it('returns usage error when step-name is missing', async () => {
    const taskId = await createTask('failed')
    const opts = await baseOpts()
    const r = await runCommandInProcess(['step', 'reset', taskId], opts)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('usage: mars step reset')
    expect((opts.daemon as ReturnType<typeof makeFakeDaemon>).calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Status guard (active task)
// ---------------------------------------------------------------------------

describe('mars step reset — active task guard', () => {
  it('refuses a running task before contacting the daemon', async () => {
    const taskId = await createTask('running')
    const opts = await baseOpts()
    const r = await runCommandInProcess(
      ['step', 'reset', taskId, 'setup-worktree'],
      opts,
    )
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('running')
    expect((opts.daemon as ReturnType<typeof makeFakeDaemon>).calls).toHaveLength(0)
  })

  it('refuses a verifying task', async () => {
    const taskId = await createTask('verifying')
    const opts = await baseOpts()
    const r = await runCommandInProcess(
      ['step', 'reset', taskId, 'verify'],
      opts,
    )
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('verifying')
    expect((opts.daemon as ReturnType<typeof makeFakeDaemon>).calls).toHaveLength(0)
  })

  it('refuses a merging task', async () => {
    const taskId = await createTask('merging')
    const opts = await baseOpts()
    const r = await runCommandInProcess(
      ['step', 'reset', taskId, 'merge'],
      opts,
    )
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('merging')
  })
})

// ---------------------------------------------------------------------------
// Lease guard
// ---------------------------------------------------------------------------

describe('mars step reset — lease guard', () => {
  it('refuses an awaiting-human task with an active lease', async () => {
    const taskId = await createTask('awaiting-human', 'operator@host')
    const opts = await baseOpts()
    const r = await runCommandInProcess(
      ['step', 'reset', taskId, 'setup-worktree'],
      opts,
    )
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('leased')
    expect((opts.daemon as ReturnType<typeof makeFakeDaemon>).calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Unknown task
// ---------------------------------------------------------------------------

describe('mars step reset — unknown task', () => {
  it('errors when the task does not exist', async () => {
    const opts = await baseOpts()
    const r = await runCommandInProcess(
      ['step', 'reset', 'mars-nonexistent', 'setup-worktree'],
      opts,
    )
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('not found')
    expect((opts.daemon as ReturnType<typeof makeFakeDaemon>).calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Daemon error propagation
// ---------------------------------------------------------------------------

describe('mars step reset — daemon error propagation', () => {
  it('surfaces daemon error when step has no checkpoint', async () => {
    const taskId = await createTask('failed')
    const fake = makeFakeDaemon(() => {
      throw new Error(`step 'nonexistent' has no recorded checkpoint for task ${taskId}`)
    })
    const { store, ctx } = await loadStoreAndCtx()

    const r = await runCommandInProcess(
      ['step', 'reset', taskId, 'nonexistent'],
      { store, ctx, daemon: fake },
    )

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('no recorded checkpoint')
  })
})
