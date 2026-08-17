/**
 * Tests for `mars step abort <task-id> --reason <text>`.
 *
 * Covers:
 *   1. Happy path — task is awaiting-human; command sends step-abort op to daemon.
 *   2. Missing --reason — exits non-zero before contacting the daemon.
 *   3. Wrong status — task is not awaiting-human; exits non-zero.
 *   4. Unknown task — exits non-zero.
 *   5. DB integration — status transition, preserved worktree row, action-queue row.
 *
 * CLI cases use the in-process command seam (ADR-0023) with a recording fake daemon.
 * DB cases exercise the underlying storage functions directly so the test asserts
 * on observable state rather than implementation details.
 */

import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  runCommandInProcess,
  makeFakeDaemon,
  type InProcessOptions,
} from '../../test-adapter'
import type { DomainTaskStore } from '../../../core/store/task-store'
import type { OrchestratorContext } from '../../../core/context'

// PGlite cold-start can be slow on CI.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

// ── Shared DB module refs (loaded once in beforeAll) ──────────────────────────

let repo: string
let q: typeof import('../../../core/queue')
let actionQueue: typeof import('../../../core/lib/action-queue')
let Arc: typeof import('../../../core/arc').Arc

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-step-abort-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

beforeAll(async () => {
  repo = setupRepo()
  vi.resetModules()
  process.env.MARS_REPO = repo
  q = await import('../../../core/queue')
  await q.migrateQueueSchema()
  actionQueue = await import('../../../core/lib/action-queue')
  await actionQueue.initActionQueue()
  const arcMod = await import('../../../core/arc')
  Arc = arcMod.Arc
})

afterAll(() => {
  delete process.env.MARS_REPO
  vi.resetModules()
  rmSync(repo, { recursive: true, force: true })
})

// ── Helpers ───────────────────────────────────────────────────────────────────

const loadStoreAndCtx = async (): Promise<{
  store: DomainTaskStore
  ctx: OrchestratorContext
}> => {
  const queueModule = await import('../../../core/queue')
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

const createTask = async (
  status: string,
  opts: { worktreePath?: string; branch?: string; leaseOwner?: string } = {},
): Promise<string> => {
  const task = await q.enqueueTask('test step-abort task', undefined, { skipTriage: true })
  await q.updateTask(task.id, {
    status: status as Parameters<typeof q.updateTask>[1]['status'],
    branch: opts.branch ?? `task/${task.id}`,
    worktreePath: opts.worktreePath ?? null,
    leaseOwner: opts.leaseOwner ?? 'operator@host',
    leasedAt: new Date().toISOString(),
  })
  return task.id
}

// ── CLI seam tests ────────────────────────────────────────────────────────────

describe('mars step abort — happy path', () => {
  it('sends step-abort op to daemon and prints success', async () => {
    const taskId = await createTask('awaiting-human')
    const fake = makeFakeDaemon(() => ({}))
    const { store, ctx } = await loadStoreAndCtx()

    const r = await runCommandInProcess(
      ['step', 'abort', taskId, '--reason', 'ran out of time'],
      { store, ctx, daemon: fake },
    )

    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    const req = fake.calls[0] as { op: string; id: string; reason: string }
    expect(req.op).toBe('step-abort')
    expect(req.id).toBe(taskId)
    expect(req.reason).toBe('ran out of time')
    expect(r.out.join('\n')).toContain('aborted')
    expect(r.out.join('\n')).toContain('mars continue')
  })
})

describe('mars step abort — missing --reason', () => {
  it('exits non-zero and prints usage when --reason is absent', async () => {
    const taskId = await createTask('awaiting-human')
    const opts = await baseOpts()

    const r = await runCommandInProcess(['step', 'abort', taskId], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('--reason')
    expect((opts.daemon as ReturnType<typeof makeFakeDaemon>).calls).toHaveLength(0)
  })

  it('exits non-zero when --reason is empty', async () => {
    const taskId = await createTask('awaiting-human')
    const opts = await baseOpts()

    const r = await runCommandInProcess(['step', 'abort', taskId, '--reason', '   '], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('--reason')
    expect((opts.daemon as ReturnType<typeof makeFakeDaemon>).calls).toHaveLength(0)
  })

  it('exits non-zero when no task-id is supplied', async () => {
    const opts = await baseOpts()

    const r = await runCommandInProcess(['step', 'abort', '--reason', 'some reason'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('task-id')
    expect((opts.daemon as ReturnType<typeof makeFakeDaemon>).calls).toHaveLength(0)
  })
})

describe('mars step abort — wrong status', () => {
  it('exits non-zero when task is running (auto step)', async () => {
    const taskId = await createTask('running')
    const opts = await baseOpts()

    const r = await runCommandInProcess(
      ['step', 'abort', taskId, '--reason', 'bail out'],
      opts,
    )

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('awaiting-human')
    expect((opts.daemon as ReturnType<typeof makeFakeDaemon>).calls).toHaveLength(0)
  })

  it('exits non-zero when task is queued', async () => {
    const taskId = await createTask('queued')
    const opts = await baseOpts()

    const r = await runCommandInProcess(
      ['step', 'abort', taskId, '--reason', 'bail out'],
      opts,
    )

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('awaiting-human')
    expect((opts.daemon as ReturnType<typeof makeFakeDaemon>).calls).toHaveLength(0)
  })

  it('exits non-zero when task is already failed', async () => {
    const taskId = await createTask('failed')
    const opts = await baseOpts()

    const r = await runCommandInProcess(
      ['step', 'abort', taskId, '--reason', 'bail out'],
      opts,
    )

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('awaiting-human')
    expect((opts.daemon as ReturnType<typeof makeFakeDaemon>).calls).toHaveLength(0)
  })
})

describe('mars step abort — unknown task', () => {
  it('exits non-zero when the task does not exist', async () => {
    const opts = await baseOpts()

    const r = await runCommandInProcess(
      ['step', 'abort', 'mars-nonexistent', '--reason', 'bail out'],
      opts,
    )

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('not found')
    expect((opts.daemon as ReturnType<typeof makeFakeDaemon>).calls).toHaveLength(0)
  })
})

// ── DB integration: status transition, preserved worktree, action-queue row ──

describe('mars step abort — DB integration', () => {
  it('sets status=failed, failed_phase=code, records task note, preserves worktree, raises failed action-queue row', async () => {
    const fakeWorktreePath = resolve(repo, '.mars', 'worktrees', 'test-wt')
    const taskId = await createTask('awaiting-human', {
      worktreePath: fakeWorktreePath,
      branch: 'task/test-abort',
    })

    const reason = 'operator could not finish the manual step'

    // Simulate what handleStepAbort does: update task, append note, raise action-queue item.
    await q.updateTask(taskId, {
      status: 'failed',
      failedPhase: 'code',
      error: reason,
    })
    await Arc.appendProgress({
      taskId,
      author: 'cli',
      kind: 'note',
      body: `step-abort: ${reason}`,
    })
    const aqItemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'daemon',
      priority: 'high',
      title: `Task ${taskId} aborted by operator`,
      body: `Operator aborted manual step for task ${taskId}. Reason: ${reason}.`,
      payload: { taskId, reason },
      context: { taskId },
      raisedBy: 'daemon:step-abort',
      signature: `step-abort:${taskId}`,
      originTaskId: taskId,
    })

    // DB status transition: task must be failed with failed_phase='code'.
    const task = await q.getTask(taskId)
    expect(task?.status).toBe('failed')
    expect(task?.failedPhase).toBe('code')
    expect(task?.error).toBe(reason)

    // Preserved worktree and branch: rows must be untouched (not cleared).
    expect(task?.worktreePath).toBe(fakeWorktreePath)
    expect(task?.branch).toBe('task/test-abort')

    // Task note: the reason must appear in the progress journal.
    const progress = await Arc.listProgress(taskId)
    const noteEntry = progress.find(
      (e) => e.kind === 'note' && e.body.includes('step-abort') && e.body.includes(reason),
    )
    expect(noteEntry).toBeDefined()

    // Action-queue side-effect: exactly one 'failed' row for this task.
    const aqItem = await actionQueue.getActionQueueItem(aqItemId)
    expect(aqItem?.kind).toBe('failed')
    expect(aqItem?.status).toBe('open')
    expect(aqItem?.originTaskId).toBe(taskId)

    // Idempotency: a second raise must not create a new row (dedup by originTaskId).
    const aqItemId2 = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'daemon',
      priority: 'high',
      title: `Task ${taskId} aborted by operator`,
      body: `Operator aborted manual step for task ${taskId}. Reason: ${reason}.`,
      payload: { taskId, reason },
      context: { taskId },
      raisedBy: 'daemon:step-abort',
      signature: `step-abort:${taskId}`,
      originTaskId: taskId,
    })
    expect(aqItemId2).toBe(aqItemId)
  })
})
