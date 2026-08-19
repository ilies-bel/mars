/**
 * Tests for the Progress journal: `mars task note`, `mars task check`,
 * and the journal/checklist rendering in `mars task show`.
 *
 * Uses the in-process command seam (ADR-0023) with a recording fake daemon
 * and an in-memory store. Arc writes are exercised directly for the show
 * roundtrip so the test asserts on observable CLI output rather than on
 * internal state.
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
} from '../test-adapter'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-progress-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const loadStoreAndCtx = async (): Promise<{ store: DomainTaskStore; ctx: OrchestratorContext }> => {
  // Reset module cache so each test gets a fresh PGlite singleton bound to its
  // own MARS_REPO. Without this, the clientSingleton in queue.ts persists across
  // tests and points to the previous test's deleted data directory, causing
  // "could not open file" errors on any table access after the first test.
  vi.resetModules()
  process.env.MARS_REPO = repo
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

beforeEach(() => {
  repo = setupRepo()
})

afterEach(() => {
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helper: create a real task in the in-memory store
// ---------------------------------------------------------------------------

const createTask = async (store: DomainTaskStore, opts?: { doneCriteria?: string[] }) => {
  const { Arc } = await import('../../core/arc')
  const task = await Arc.createOrigin(
    {
      prompt: 'test task',
      opts: opts?.doneCriteria
        ? {
            spec: {
              files: [],
              doneCriteria: opts.doneCriteria,
              readFirst: [],
              prescriptiveAction: null,
              verifyCmd: null,
              mergeMode: 'auto',
            },
          }
        : undefined,
    },
    store,
  )
  return task
}

// ---------------------------------------------------------------------------
// mars task note — sends the right daemon request
// ---------------------------------------------------------------------------

describe('mars task note', () => {
  it('sends task.note to the daemon with id, body, and author', async () => {
    const fake = makeFakeDaemon((_req) => ({ id: 'prog-abc123' }))
    const { store, ctx } = await loadStoreAndCtx()
    const opts: InProcessOptions = { store, ctx, daemon: fake }
    const result = await runCommandInProcess(
      ['task', 'note', 'mars-abc12345', 'making progress'],
      opts,
    )
    expect(result.code).toBe(0)
    expect(result.out).toContain('noted prog-abc123')
    expect(fake.calls).toHaveLength(1)
    const call = fake.calls[0]
    expect(call).toMatchObject({
      op: 'task.note',
      id: 'mars-abc12345',
      body: 'making progress',
    })
  })

  it('prints usage and exits 1 when id is missing', async () => {
    const opts = await baseOpts()
    const result = await runCommandInProcess(['task', 'note'], opts)
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('usage: mars task note')
  })

  it('prints usage and exits 1 when body is missing', async () => {
    const opts = await baseOpts()
    const result = await runCommandInProcess(['task', 'note', 'mars-abc12345'], opts)
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('usage: mars task note')
  })
})

// ---------------------------------------------------------------------------
// mars task check — sends the right daemon request
// ---------------------------------------------------------------------------

describe('mars task check', () => {
  it('sends task.check to the daemon with criterionIndex', async () => {
    const fake = makeFakeDaemon((_req) => ({ id: 'prog-def456' }))
    const { store, ctx } = await loadStoreAndCtx()
    const opts: InProcessOptions = { store, ctx, daemon: fake }
    const result = await runCommandInProcess(
      ['task', 'check', 'mars-abc12345', '2'],
      opts,
    )
    expect(result.code).toBe(0)
    expect(result.out).toContain('checked criterion 2 on mars-abc12345')
    expect(fake.calls).toHaveLength(1)
    const call = fake.calls[0]
    expect(call).toMatchObject({
      op: 'task.check',
      id: 'mars-abc12345',
      criterionIndex: 2,
      uncheck: false,
    })
  })

  it('sends uncheck:true when --uncheck flag is present', async () => {
    const fake = makeFakeDaemon((_req) => ({ id: 'prog-ghi789' }))
    const { store, ctx } = await loadStoreAndCtx()
    const opts: InProcessOptions = { store, ctx, daemon: fake }
    const result = await runCommandInProcess(
      ['task', 'check', 'mars-abc12345', '1', '--uncheck'],
      opts,
    )
    expect(result.code).toBe(0)
    expect(result.out).toContain('unchecked criterion 1 on mars-abc12345')
    const call = fake.calls[0]
    expect(call).toMatchObject({
      op: 'task.check',
      id: 'mars-abc12345',
      criterionIndex: 1,
      uncheck: true,
    })
  })

  it('rejects non-integer criterion index', async () => {
    const opts = await baseOpts()
    const result = await runCommandInProcess(
      ['task', 'check', 'mars-abc12345', 'foo'],
      opts,
    )
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('criterion index must be a positive integer')
  })

  it('rejects zero criterion index', async () => {
    const opts = await baseOpts()
    const result = await runCommandInProcess(
      ['task', 'check', 'mars-abc12345', '0'],
      opts,
    )
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('criterion index must be a positive integer')
  })

  it('prints the numbered done-criteria list on a non-integer index', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const task = await createTask(store, { doneCriteria: ['do thing A', 'do thing B'] })
    const fake = makeFakeDaemon()
    const result = await runCommandInProcess(
      ['task', 'check', task.id, 'foo'],
      { store, ctx, daemon: fake },
    )
    expect(result.code).toBe(1)
    const errStr = result.err.join('\n')
    expect(errStr).toContain('criterion index must be a positive integer')
    expect(errStr).toContain('1. do thing A')
    expect(errStr).toContain('2. do thing B')
  })

  it('prints the numbered done-criteria list on an out-of-range index', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const task = await createTask(store, { doneCriteria: ['do thing A', 'do thing B'] })
    const fake = makeFakeDaemon((req) => {
      if (req.op === 'task.check') {
        throw new Error(
          `criterionIndex ${(req as { criterionIndex: number }).criterionIndex} is out of range; task has 2 done criteria`,
        )
      }
      return {}
    })
    const result = await runCommandInProcess(
      ['task', 'check', task.id, '99'],
      { store, ctx, daemon: fake },
    )
    expect(result.code).toBe(1)
    const errStr = result.err.join('\n')
    expect(errStr).toContain('out of range')
    expect(errStr).toContain('1. do thing A')
    expect(errStr).toContain('2. do thing B')
  })
})

// ---------------------------------------------------------------------------
// Arc.appendProgress — unknown task id rejection
// ---------------------------------------------------------------------------

describe('Arc.appendProgress — input validation', () => {
  it('rejects unknown task id', async () => {
    const { store } = await loadStoreAndCtx()
    const { Arc } = await import('../../core/arc')
    await expect(
      Arc.appendProgress(
        { taskId: 'mars-nonexistent', author: 'test', kind: 'note', body: 'hi' },
        store,
      ),
    ).rejects.toThrow(/not found/)
  })

  it('rejects out-of-range criterion index (too high)', async () => {
    const { store } = await loadStoreAndCtx()
    const task = await createTask(store, { doneCriteria: ['do thing A', 'do thing B'] })
    const { Arc } = await import('../../core/arc')
    await expect(
      Arc.appendProgress(
        { taskId: task.id, author: 'test', kind: 'check', body: '', criterionIndex: 3 },
        store,
      ),
    ).rejects.toThrow(/out of range/)
  })

  it('rejects criterion index less than 1', async () => {
    const { store } = await loadStoreAndCtx()
    const task = await createTask(store, { doneCriteria: ['do thing A'] })
    const { Arc } = await import('../../core/arc')
    await expect(
      Arc.appendProgress(
        { taskId: task.id, author: 'test', kind: 'check', body: '', criterionIndex: 0 },
        store,
      ),
    ).rejects.toThrow(/must be a positive integer/)
  })

  it('rejects missing criterion index for check kind', async () => {
    const { store } = await loadStoreAndCtx()
    const task = await createTask(store, { doneCriteria: ['do thing A'] })
    const { Arc } = await import('../../core/arc')
    await expect(
      Arc.appendProgress(
        { taskId: task.id, author: 'test', kind: 'check', body: '' },
        store,
      ),
    ).rejects.toThrow(/must be a positive integer/)
  })
})

// ---------------------------------------------------------------------------
// Arc.deriveChecklist — check/uncheck fold
// ---------------------------------------------------------------------------

describe('Arc.deriveChecklist — fold semantics', () => {
  it('returns all unchecked when no journal entries', async () => {
    const { Arc } = await import('../../core/arc')
    const checklist = Arc.deriveChecklist([], ['do A', 'do B'])
    expect(checklist).toEqual([
      { criterion: 'do A', checked: false },
      { criterion: 'do B', checked: false },
    ])
  })

  it('reflects a single check', async () => {
    const { Arc } = await import('../../core/arc')
    const entries = [
      { id: 'p1', taskId: 't1', createdAt: 1_704_067_200_000, author: 'x', kind: 'check' as const, body: '', criterionIndex: 1 },
    ]
    const checklist = Arc.deriveChecklist(entries, ['do A', 'do B'])
    expect(checklist).toEqual([
      { criterion: 'do A', checked: true },
      { criterion: 'do B', checked: false },
    ])
  })

  it('latest entry wins: check then uncheck → unchecked', async () => {
    const { Arc } = await import('../../core/arc')
    const entries = [
      { id: 'p1', taskId: 't1', createdAt: 1_704_067_200_000, author: 'x', kind: 'check' as const, body: '', criterionIndex: 1 },
      { id: 'p2', taskId: 't1', createdAt: 1_704_067_260_000, author: 'x', kind: 'uncheck' as const, body: '', criterionIndex: 1 },
    ]
    const checklist = Arc.deriveChecklist(entries, ['do A', 'do B'])
    expect(checklist[0]).toEqual({ criterion: 'do A', checked: false })
  })

  it('latest entry wins: uncheck then check → checked', async () => {
    const { Arc } = await import('../../core/arc')
    const entries = [
      { id: 'p1', taskId: 't1', createdAt: 1_704_067_200_000, author: 'x', kind: 'uncheck' as const, body: '', criterionIndex: 2 },
      { id: 'p2', taskId: 't1', createdAt: 1_704_067_260_000, author: 'x', kind: 'check' as const, body: '', criterionIndex: 2 },
    ]
    const checklist = Arc.deriveChecklist(entries, ['do A', 'do B'])
    expect(checklist[1]).toEqual({ criterion: 'do B', checked: true })
  })

  it('note entries are ignored in fold', async () => {
    const { Arc } = await import('../../core/arc')
    const entries = [
      { id: 'p1', taskId: 't1', createdAt: 1_704_067_200_000, author: 'x', kind: 'note' as const, body: 'hello', criterionIndex: null },
    ]
    const checklist = Arc.deriveChecklist(entries, ['do A'])
    expect(checklist[0]).toEqual({ criterion: 'do A', checked: false })
  })
})

// ---------------------------------------------------------------------------
// mars task show — journal tail and checklist state roundtrip
// ---------------------------------------------------------------------------

describe('mars task show — journal and checklist', () => {
  it('displays journal entries written via Arc.appendProgress', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const task = await createTask(store, { doneCriteria: ['implement', 'test'] })
    const { Arc } = await import('../../core/arc')
    const entry = await Arc.appendProgress(
      { taskId: task.id, author: 'session-abc', kind: 'note', body: 'started work' },
      store,
    )
    expect(typeof entry.createdAt).toBe('number')
    const fake = makeFakeDaemon()
    const result = await runCommandInProcess(
      ['task', 'show', task.id],
      { store, ctx, daemon: fake },
    )
    expect(result.code).toBe(0)
    const outputStr = result.out.join('\n')
    expect(outputStr).toContain('journal')
    expect(outputStr).toContain('started work')
    expect(outputStr).toContain('session-abc')
  })

  it('shows met state (✓) after check — task_acceptance is the verdict table', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const task = await createTask(store, { doneCriteria: ['implement', 'test'] })
    const { Arc } = await import('../../core/arc')
    // Check criterion 1 — appendProgress mirrors to task_acceptance (status='met')
    await Arc.appendProgress(
      { taskId: task.id, author: 'session-xyz', kind: 'check', body: '', criterionIndex: 1 },
      store,
    )
    const fake = makeFakeDaemon()
    const result = await runCommandInProcess(
      ['task', 'show', task.id],
      { store, ctx, daemon: fake },
    )
    expect(result.code).toBe(0)
    const outputStr = result.out.join('\n')
    // New 4-state display: met → [✓], pending → [ ]
    expect(outputStr).toContain('[✓] implement')
    expect(outputStr).toContain('[ ] test')
  })

  it('shows pending ([ ]) after check → uncheck sequence', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const task = await createTask(store, { doneCriteria: ['implement'] })
    const { Arc } = await import('../../core/arc')
    await Arc.appendProgress(
      { taskId: task.id, author: 'u', kind: 'check', body: '', criterionIndex: 1 },
      store,
    )
    await Arc.appendProgress(
      { taskId: task.id, author: 'u', kind: 'uncheck', body: '', criterionIndex: 1 },
      store,
    )
    const fake = makeFakeDaemon()
    const result = await runCommandInProcess(
      ['task', 'show', task.id],
      { store, ctx, daemon: fake },
    )
    expect(result.code).toBe(0)
    // Uncheck → task_acceptance status reverted to 'pending' → shows [ ]
    expect(result.out.join('\n')).toContain('[ ] implement')
  })

  it('renders all four verdict states: met ✓, not-met ✗, cannot-verify ?, pending (space)', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const task = await createTask(store, {
      doneCriteria: ['criterion-met', 'criterion-not-met', 'criterion-cannot-verify', 'criterion-pending'],
    })
    const { Arc } = await import('../../core/arc')
    // Directly record verdicts via Arc.recordCriterionVerdicts
    await Arc.recordCriterionVerdicts(task.id, [
      { position: 0, text: 'criterion-met', status: 'met', note: 'looked good' },
      { position: 1, text: 'criterion-not-met', status: 'not-met', note: 'failed' },
      { position: 2, text: 'criterion-cannot-verify', status: 'cannot-verify', note: 'no surface' },
      // position 3 left as pending (seeded at creation)
    ], store)
    const fake = makeFakeDaemon()
    const result = await runCommandInProcess(
      ['task', 'show', task.id],
      { store, ctx, daemon: fake },
    )
    expect(result.code).toBe(0)
    const outputStr = result.out.join('\n')
    expect(outputStr).toContain('[✓] criterion-met')
    expect(outputStr).toContain('[✗] criterion-not-met')
    expect(outputStr).toContain('[?] criterion-cannot-verify')
    expect(outputStr).toContain('[ ] criterion-pending')
  })

  it('exits 1 with error when task id is unknown', async () => {
    const opts = await baseOpts()
    const result = await runCommandInProcess(
      ['task', 'show', 'mars-nonexistent'],
      opts,
    )
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('mars-nonexistent')
  })
})
