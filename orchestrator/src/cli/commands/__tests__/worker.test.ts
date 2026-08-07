/**
 * Behaviour tests for `mars worker remove` and `mars worker list` (SOURCE column).
 *
 * Uses a real temp dir for the registry file. The task-store dependency is
 * fulfilled with a lightweight fake that only implements `listTasks` — the
 * only DomainTaskStore method worker-remove calls.
 *
 * Tests verify behaviour through the public CLI interface: exit code,
 * stdout/stderr lines, and resulting registry file state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DomainTaskStore } from '../../../core/store/task-store'
import type { Task, TaskStatus } from '../../../core/queue'
import type { InProcessOptions } from '../../test-adapter'

// ── Helpers ─────────────────────────────────────────────────────────────────

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-worker-cmd-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/**
 * Minimal fake DomainTaskStore. Only `listTasks` is implemented; everything
 * else throws so a test immediately fails if it calls an unexpected method.
 */
const makeFakeStore = (
  runningTasks: Task[] = [],
  queuedTasks: Task[] = [],
): DomainTaskStore => {
  const noop = () => {
    throw new Error('unexpected store call in worker test')
  }
  return {
    listTasks: async (status?: TaskStatus) => {
      if (status === 'running') return runningTasks
      if (status === 'queued') return queuedTasks
      return []
    },
    getTask: noop,
    listTasksPaged: noop,
    listNonDoneTasks: noop,
    listAllTaskIds: noop,
    filterExistingTaskIds: noop,
    enqueueTask: noop,
    updateTask: noop,
    reopenTerminalTask: noop,
    dropTask: noop,
    setTaskPriority: noop,
    addPendingReviewBlockers: noop,
    clearBlockers: noop,
    listBlockers: noop,
    hasIncompleteBlockers: noop,
    listAllBlockers: noop,
    unblockTask: noop,
    promoteDraftToQueued: noop,
    addProposalBlockers: noop,
    removeProposalBlocker: noop,
    listProposalBlockers: noop,
    listTasksBlockedByProposal: noop,
    transferProposalBlockerToTask: noop,
    listSiblings: noop,
    listTasksForProposal: noop,
    upsertTranscript: noop,
    getTranscript: noop,
    arcStatus: noop,
    query: noop,
    execute: noop,
    batch: noop,
    atomic: noop,
  } as unknown as DomainTaskStore
}

const run = async (
  argv: readonly string[],
  opts: InProcessOptions,
): Promise<{ code: number; out: string[]; err: string[] }> => {
  const { runCommandInProcess } = await import('../../test-adapter')
  return runCommandInProcess(argv, opts)
}

const makeFakeDaemon = async () => {
  const { makeFakeDaemon: mfd } = await import('../../test-adapter')
  return mfd()
}

const loadCtx = async () => {
  const contextModule = await import('../../../core/context')
  return contextModule.resolveContext(repo)
}

const registryPath = () => resolve(repo, '.mars', 'worker-registry.json')

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

// ── worker remove ─────────────────────────────────────────────────────────────

describe('mars worker remove', () => {
  it('exits 2 with usage when no name is provided', async () => {
    const ctx = await loadCtx()
    const daemon = await makeFakeDaemon()
    const result = await run(['worker', 'remove'], {
      store: makeFakeStore(),
      daemon,
      ctx,
    })
    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain('usage: mars worker remove')
  })

  it('exits 1 with a message when trying to remove a built-in worker', async () => {
    const ctx = await loadCtx()
    const daemon = await makeFakeDaemon()
    const result = await run(['worker', 'remove', 'Coder'], {
      store: makeFakeStore(),
      daemon,
      ctx,
    })
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toMatch(/built-in/i)
    expect(result.err.join('\n')).toContain('Coder')
  })

  it('exits 1 naming valid operator-added workers when unknown name is given', async () => {
    const ctx = await loadCtx()
    const daemon = await makeFakeDaemon()

    // Add a worker to the registry so there are valid operator names to list.
    const { addWorkerToRegistry } = await import('../../../core/workers/persisted-registry')
    addWorkerToRegistry(ctx.stateDir, {
      name: 'ValidOp',
      modelTier: 'balanced',
      effort: 'high',
      permissionMode: 'default',
      bare: false,
      disallowedTools: [],
      outputFormat: 'stream-json',
      runtime: 'headless',
    })

    const result = await run(['worker', 'remove', 'NoSuchWorker'], {
      store: makeFakeStore(),
      daemon,
      ctx,
    })

    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('NoSuchWorker')
    expect(result.err.join('\n')).toContain('ValidOp')
  })

  it('successfully removes an operator-added worker and exits 0', async () => {
    const ctx = await loadCtx()
    const daemon = await makeFakeDaemon()
    const { addWorkerToRegistry, loadWorkerRegistry } = await import(
      '../../../core/workers/persisted-registry'
    )

    addWorkerToRegistry(ctx.stateDir, {
      name: 'ScratchRemove',
      modelTier: 'balanced',
      effort: 'high',
      permissionMode: 'default',
      bare: false,
      disallowedTools: [],
      outputFormat: 'stream-json',
      runtime: 'headless',
    })

    const result = await run(['worker', 'remove', 'ScratchRemove'], {
      store: makeFakeStore(),
      daemon,
      ctx,
    })

    expect(result.code).toBe(0)
    expect(result.out.join('\n')).toContain('removed worker ScratchRemove')
    const remaining = loadWorkerRegistry(ctx.stateDir).map((d) => d.name)
    expect(remaining).not.toContain('ScratchRemove')
  })

  it('add-then-remove leaves registry without the added worker, built-ins preserved', async () => {
    const ctx = await loadCtx()
    const daemon = await makeFakeDaemon()
    const { addWorkerToRegistry, loadWorkerRegistry } = await import(
      '../../../core/workers/persisted-registry'
    )
    const { WORKER_CONFIGS } = await import('../../../core/workers')

    addWorkerToRegistry(ctx.stateDir, {
      name: 'RoundTripWorker',
      modelTier: 'flagship',
      effort: 'high',
      permissionMode: 'default',
      bare: false,
      disallowedTools: [],
      outputFormat: 'stream-json',
      runtime: 'headless',
    })

    const result = await run(['worker', 'remove', 'RoundTripWorker'], {
      store: makeFakeStore(),
      daemon,
      ctx,
    })

    expect(result.code).toBe(0)

    const afterRemove = readFileSync(registryPath(), 'utf8')
    expect(afterRemove).not.toContain('RoundTripWorker')
    for (const name of Object.keys(WORKER_CONFIGS)) {
      expect(afterRemove).toContain(name)
    }
    const remaining = loadWorkerRegistry(ctx.stateDir).map((d) => d.name)
    expect(remaining).not.toContain('RoundTripWorker')
  })

  it('refuses removal when a running task is routed to the worker via tag intersection', async () => {
    const ctx = await loadCtx()
    const daemon = await makeFakeDaemon()
    const { addWorkerToRegistry } = await import(
      '../../../core/workers/persisted-registry'
    )

    addWorkerToRegistry(ctx.stateDir, {
      name: 'TaggedWorker',
      modelTier: 'balanced',
      effort: 'high',
      permissionMode: 'default',
      bare: false,
      disallowedTools: [],
      outputFormat: 'stream-json',
      runtime: 'headless',
      tags: ['mytag'],
    })

    // Fake running task with matching tag.
    const fakeTask = {
      id: 'task-abc123',
      tags: ['mytag'],
      status: 'running',
    } as unknown as Task

    const result = await run(['worker', 'remove', 'TaggedWorker'], {
      store: makeFakeStore([fakeTask]),
      daemon,
      ctx,
    })

    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('task-abc123')
    expect(result.err.join('\n')).toContain('mytag')
  })

  it('refuses removal when a queued task is routed to the worker via tag intersection', async () => {
    const ctx = await loadCtx()
    const daemon = await makeFakeDaemon()
    const { addWorkerToRegistry } = await import(
      '../../../core/workers/persisted-registry'
    )

    addWorkerToRegistry(ctx.stateDir, {
      name: 'TaggedWorker2',
      modelTier: 'balanced',
      effort: 'high',
      permissionMode: 'default',
      bare: false,
      disallowedTools: [],
      outputFormat: 'stream-json',
      runtime: 'headless',
      tags: ['specialtag'],
    })

    const fakeTask = {
      id: 'task-def456',
      tags: ['specialtag'],
      status: 'queued',
    } as unknown as Task

    const result = await run(['worker', 'remove', 'TaggedWorker2'], {
      store: makeFakeStore([], [fakeTask]),
      daemon,
      ctx,
    })

    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('task-def456')
  })

  it('allows removal of a tagged worker when no active tasks reference the tag', async () => {
    const ctx = await loadCtx()
    const daemon = await makeFakeDaemon()
    const { addWorkerToRegistry } = await import(
      '../../../core/workers/persisted-registry'
    )

    addWorkerToRegistry(ctx.stateDir, {
      name: 'SafeTaggedWorker',
      modelTier: 'balanced',
      effort: 'high',
      permissionMode: 'default',
      bare: false,
      disallowedTools: [],
      outputFormat: 'stream-json',
      runtime: 'headless',
      tags: ['uniquetag'],
    })

    // Tasks exist, but none use the 'uniquetag' tag.
    const unrelatedTask = {
      id: 'task-unrelated',
      tags: ['coder'],
      status: 'running',
    } as unknown as Task

    const result = await run(['worker', 'remove', 'SafeTaggedWorker'], {
      store: makeFakeStore([unrelatedTask]),
      daemon,
      ctx,
    })

    expect(result.code).toBe(0)
  })
})

// ── worker list SOURCE column ─────────────────────────────────────────────────

describe('mars worker list SOURCE column', () => {
  it('shows built-in for shipped workers and operator for added workers', async () => {
    const ctx = await loadCtx()
    const daemon = await makeFakeDaemon()
    const { addWorkerToRegistry } = await import(
      '../../../core/workers/persisted-registry'
    )

    addWorkerToRegistry(ctx.stateDir, {
      name: 'OpWorker',
      modelTier: 'balanced',
      effort: 'high',
      permissionMode: 'default',
      bare: false,
      disallowedTools: [],
      outputFormat: 'stream-json',
      runtime: 'headless',
    })

    const result = await run(['worker', 'list'], {
      store: makeFakeStore(),
      daemon,
      ctx,
    })

    expect(result.code).toBe(0)
    const outputText = result.out.join('\n')
    // Header must include SOURCE column.
    expect(outputText).toContain('SOURCE')
    // Built-in workers should show 'built-in'.
    expect(outputText).toContain('built-in')
    // Operator-added worker should show 'operator'.
    expect(outputText).toContain('operator')
  })
})
