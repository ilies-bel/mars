/**
 * Tests for `mars enter <task-id>`.
 *
 * Covers:
 *   1. Happy path — task is awaiting-human with a worktree; agent is spawned
 *      with the correct cwd and receives the briefing on stdin.
 *   2. Wrong-status rejection — task is not awaiting-human; exits non-zero.
 *   3. Missing-worktree rejection — task is awaiting-human but has no
 *      worktreePath; exits non-zero.
 *
 * `child_process.spawn` and `composeLiveBriefing` are stubbed so no real
 * process is launched and no live DB briefing-assembly runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// ── Hoist mock factories ──────────────────────────────────────────────────────
// vi.hoisted ensures these are available inside vi.mock factory closures.

const mockSpawn = vi.hoisted(() => vi.fn())
const mockComposeLiveBriefing = vi.hoisted(() => vi.fn())

// Mock child_process: keep all real exports (execFileSync etc.) but replace spawn.
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return { ...orig, spawn: mockSpawn }
})

// Mock composeLiveBriefing so tests don't need a live DB state for briefing assembly.
vi.mock('../../../core/lib/live-briefing', () => ({
  composeLiveBriefing: mockComposeLiveBriefing,
  LiveBriefingError: class extends Error {
    public readonly taskId: string
    public readonly actualStatus: string
    constructor(taskId: string, actualStatus: string) {
      super(`Task ${taskId} is not awaiting-human (status=${actualStatus})`)
      this.taskId = taskId
      this.actualStatus = actualStatus
    }
  },
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-enter-test-'))
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

const baseOpts = async (): Promise<InProcessOptions> => {
  const { store, ctx } = await loadStoreAndCtx()
  return { store, ctx, daemon: makeFakeDaemon() }
}

const createTask = async (
  status: string,
  worktreePath: string | null = null,
): Promise<string> => {
  const { enqueueTask, updateTask } = await import('../../../core/queue')
  const task = await enqueueTask('test enter task', undefined, { skipTriage: true })
  await updateTask(task.id, {
    status: status as Parameters<typeof updateTask>[1]['status'],
    branch: `task/${task.id}`,
    worktreePath,
    leaseOwner: worktreePath !== null ? 'operator@host' : null,
    leasedAt: worktreePath !== null ? new Date().toISOString() : null,
  })
  return task.id
}

/**
 * Build a fake child process whose close event fires asynchronously after
 * stdin.end() is called, and which records what was written to stdin.
 */
const makeFakeChild = (exitCode: number) => {
  const closeHandlers: Array<(code: number | null) => void> = []
  const errorHandlers: Array<(err: Error) => void> = []
  let stdinContent = ''

  const child = {
    stdin: {
      write: vi.fn((chunk: string | Buffer) => {
        stdinContent += String(chunk)
      }),
      end: vi.fn(() => {
        // Defer so child.on('close', …) is registered before the event fires.
        setImmediate(() => {
          for (const h of closeHandlers) h(exitCode)
        })
      }),
    },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'close') closeHandlers.push(handler as (code: number | null) => void)
      if (event === 'error') errorHandlers.push(handler as (err: Error) => void)
      return child
    }),
  }

  return {
    fakeChild: child,
    stdinContent: () => stdinContent,
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  repo = setupRepo()
  vi.resetModules()
  vi.resetAllMocks()
  process.env.MARS_REPO = repo
  delete process.env.MARS_LIVE_AGENT_CMD
})

afterEach(() => {
  delete process.env.MARS_REPO
  delete process.env.MARS_LIVE_AGENT_CMD
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

// ── Happy path ────────────────────────────────────────────────────────────────

describe('mars enter — happy path', () => {
  it('spawns claude with the task worktree as cwd and pipes the briefing into stdin', async () => {
    const worktreePath = resolve(repo, '.mars', 'worktrees', 'test-task')
    const taskId = await createTask('awaiting-human', worktreePath)
    const { store, ctx } = await loadStoreAndCtx()

    const briefingText = '## Task\n\ntest-task\n\nDo the work'
    mockComposeLiveBriefing.mockResolvedValue(briefingText)

    const { fakeChild, stdinContent } = makeFakeChild(0)
    mockSpawn.mockReturnValue(fakeChild)

    const r = await runCommandInProcess(['enter', taskId], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })

    expect(r.code).toBe(0)

    // Correct binary (default: claude) and cwd.
    expect(mockSpawn).toHaveBeenCalledOnce()
    const [spawnBin, spawnArgs, spawnOpts] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      { cwd: string; stdio: unknown[] },
    ]
    expect(spawnBin).toBe('claude')
    expect(spawnArgs).toEqual([])
    expect(spawnOpts.cwd).toBe(worktreePath)
    expect(spawnOpts.stdio).toEqual(['pipe', 'inherit', 'inherit'])

    // Briefing written to stdin.
    expect(stdinContent()).toBe(briefingText)
    expect(fakeChild.stdin.end).toHaveBeenCalledOnce()
  })

  it('uses MARS_LIVE_AGENT_CMD when set, split into bin + args', async () => {
    process.env.MARS_LIVE_AGENT_CMD = 'myagent --flag value'
    const worktreePath = resolve(repo, '.mars', 'worktrees', 'test-task')
    const taskId = await createTask('awaiting-human', worktreePath)
    const { store, ctx } = await loadStoreAndCtx()

    mockComposeLiveBriefing.mockResolvedValue('briefing')
    const { fakeChild } = makeFakeChild(0)
    mockSpawn.mockReturnValue(fakeChild)

    await runCommandInProcess(['enter', taskId], { store, ctx, daemon: makeFakeDaemon() })

    const [spawnBin, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]]
    expect(spawnBin).toBe('myagent')
    expect(spawnArgs).toEqual(['--flag', 'value'])
  })
})

// ── Wrong-status rejection ────────────────────────────────────────────────────

describe('mars enter — wrong-status rejection', () => {
  it('exits non-zero with a clear message when task is running', async () => {
    const taskId = await createTask('running')
    const opts = await baseOpts()

    const r = await runCommandInProcess(['enter', taskId], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('awaiting-human')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('exits non-zero with a clear message when task is queued', async () => {
    const taskId = await createTask('queued')
    const opts = await baseOpts()

    const r = await runCommandInProcess(['enter', taskId], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('awaiting-human')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('exits non-zero when the task does not exist', async () => {
    const opts = await baseOpts()

    const r = await runCommandInProcess(['enter', 'mars-nonexistent'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('not found')
    expect(mockSpawn).not.toHaveBeenCalled()
  })
})

// ── Missing-worktree rejection ────────────────────────────────────────────────

describe('mars enter — missing-worktree rejection', () => {
  it('exits non-zero with a clear message when task has no worktreePath', async () => {
    // awaiting-human but worktreePath is null.
    const taskId = await createTask('awaiting-human', null)
    const opts = await baseOpts()

    const r = await runCommandInProcess(['enter', taskId], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('no worktree')
    expect(mockSpawn).not.toHaveBeenCalled()
  })
})
