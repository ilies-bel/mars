import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-triage-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

interface ClaudeStub {
  exitCode: number
  stdout: string
  stderr?: string
}

const setClaudeStub = (stub: ClaudeStub): void => {
  vi.doMock('../git/claude', async () => {
    const actual = await vi.importActual<typeof import('../git/claude')>('../git/claude')
    return {
      ...actual,
      runClaudeCode: vi.fn(async () => ({
        exitCode: stub.exitCode,
        stdout: stub.stdout,
        stderr: stub.stderr ?? '',
        sessionId: 'stub-session',
        conversation: [],
      })),
    }
  })
}

const envelope = (jsonResult: unknown): string =>
  JSON.stringify({ result: JSON.stringify(jsonResult), is_error: false })

describe('triage workflow', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
  })

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../git/claude')
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('promotes a draft to queued when actionable with no blockers', async () => {
    setClaudeStub({
      exitCode: 0,
      stdout: envelope({
        actionable: true,
        reason: 'tight scope',
        blockerTaskIds: [],
      }),
    })
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const task = await queue.enqueueTask('implement X')

    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(task.id)

    expect(result.actionable).toBe(true)
    expect(result.blockerCount).toBe(0)
    const reloaded = await queue.getTask(task.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('records blockers and stays draft when not actionable', async () => {
    setClaudeStub({ exitCode: 0, stdout: '' }) // placeholder, replaced below
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const a = await queue.enqueueTask('depends on b')
    const b = await queue.enqueueTask('prerequisite')

    vi.resetModules()
    setClaudeStub({
      exitCode: 0,
      stdout: envelope({
        actionable: false,
        reason: 'needs prerequisite',
        blockerTaskIds: [b.id],
      }),
    })
    const queue2 = await import('../../queue')
    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(a.id)

    expect(result.actionable).toBe(false)
    expect(result.blockerCount).toBe(1)
    const blockers = await queue2.listBlockers(a.id)
    expect(blockers).toEqual([b.id])
    const reloaded = await queue2.getTask(a.id)
    expect(reloaded?.status).toBe('draft')
  })

  it('filters out hallucinated blocker ids and self-blocks', async () => {
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const a = await queue.enqueueTask('thing')

    vi.resetModules()
    setClaudeStub({
      exitCode: 0,
      stdout: envelope({
        actionable: false,
        reason: 'fake blockers',
        blockerTaskIds: ['nonexistent-id', a.id],
      }),
    })
    const queue2 = await import('../../queue')
    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(a.id)

    expect(result.blockerCount).toBe(0)
    expect(await queue2.listBlockers(a.id)).toEqual([])
  })

  // ── Skip-gate tests ──────────────────────────────────────────────────────

  it('skips LLM and returns has-blockers when task has pre-declared blocker edges', async () => {
    // No Claude stub — if LLM were called it would fail (binary unavailable in CI)
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const a = await queue.enqueueTask('task that has a blocker')
    const b = await queue.enqueueTask('prerequisite task')
    // Simulate --blocked-by at creation time
    await queue.addBlockers(a.id, [b.id])

    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(a.id)

    expect(result.triageSkipReason).toBe('has-blockers')
    expect(result.actionable).toBe(true)
    expect(result.blockerCount).toBe(1)
    // Pre-declared blocker edges are preserved (skip path does not call clearBlockers)
    const blockers = await queue.listBlockers(a.id)
    expect(blockers).toEqual([b.id])
    // Task stays draft: promoteDraftToQueued is a no-op when blocker edges exist
    // (the NOT EXISTS guard prevents premature promotion). When all blockers reach
    // 'done', re-triage promotes the task to 'queued' via the normal path.
    const reloaded = await queue.getTask(a.id)
    expect(reloaded?.status).toBe('draft')
  })

  it('skips LLM and promotes a draft with a structured spec (files + done criteria)', async () => {
    // No Claude stub — if LLM were called it would fail
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    // One extra task so open graph is non-empty (> TRIVIAL_GRAPH_SIZE=0), ensuring
    // the structured-spec rule fires rather than trivial-graph.
    await queue.enqueueTask('other task')
    const task = await queue.enqueueTask('implement X', undefined, {
      spec: {
        files: ['src/foo.ts'],
        verifyCmd: null,
        doneCriteria: ['foo is implemented'],
        taskType: 'auto' as const,
      },
    })

    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(task.id)

    expect(result.triageSkipReason).toBe('structured-spec')
    expect(result.actionable).toBe(true)
    const reloaded = await queue.getTask(task.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('skips LLM when the open task graph is trivially small', async () => {
    // No Claude stub — if LLM were called it would fail
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    // Only one task — open graph (excluding self) is empty, so trivial-graph fires
    const task = await queue.enqueueTask('free-prose task with empty graph')

    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(task.id)

    expect(result.triageSkipReason).toBe('trivial-graph')
    expect(result.actionable).toBe(true)
    const reloaded = await queue.getTask(task.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('runs LLM triage for free-prose tasks in a busy graph', async () => {
    setClaudeStub({
      exitCode: 0,
      stdout: envelope({
        actionable: true,
        reason: 'looks good',
        blockerTaskIds: [],
      }),
    })
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    // One extra task keeps the graph non-empty (> TRIVIAL_GRAPH_SIZE=0) so none
    // of the skip rules fire and the LLM path executes normally.
    await queue.enqueueTask('other task')
    const task = await queue.enqueueTask('free-prose task')

    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(task.id)

    // No skip reason — LLM ran normally
    expect(result.triageSkipReason).toBeUndefined()
    expect(result.actionable).toBe(true)
    const reloaded = await queue.getTask(task.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('reports the tail error instead of successful SessionStart hook events', async () => {
    const successfulHook = JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'SessionStart:startup',
      outcome: 'success',
      session_id: 'boilerplate-session-id',
      uuid: 'boilerplate-uuid',
      output: 'x'.repeat(250),
    })
    const actualError = JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'authentication failed: invalid API key',
    })
    setClaudeStub({
      exitCode: 1,
      stdout: [successfulHook, successfulHook, successfulHook, actualError].join('\n'),
    })
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    await queue.enqueueTask('background task')
    const task = await queue.enqueueTask('task whose triage fails')

    const triage = await import('../../../workflows/triage-workflow')

    const failure = await triage.runTriage(task.id).catch((error: unknown) => String(error))
    expect(failure).toContain('authentication failed: invalid API key')
    expect(failure).not.toContain('SessionStart:startup')
  })

})

// ── Optimised data access: skip-path and store-method tests ─────────────────
//
// These tests verify the lazy-fetch optimisation introduced in the triage
// refactor:
//  • has-blockers and structured-spec skips must NOT call listNonDoneTasks.
//  • trivial-graph fires when listNonDoneTasks returns [].
//  • Rule precedence: has-blockers wins when a task satisfies both rules.
//  • listNonDoneTasks returns newest-first; reversed gives the pre-change
//    display order (oldest-first).
//  • filterExistingTaskIds drops unknown ids and is not called when the LLM
//    returns an empty blockerTaskIds list; it receives at most MAX_BLOCKERS ids.

describe('triage workflow — optimised data access', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
  })

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../git/claude')
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('has-blockers skip does not call listNonDoneTasks', async () => {
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const a = await queue.enqueueTask('task with pre-declared blocker')
    const b = await queue.enqueueTask('prerequisite task')
    await queue.addBlockers(a.id, [b.id])
    // Extra task ensures the graph would be non-trivial if fetched
    await queue.enqueueTask('unrelated background task')

    const { createTaskStore, getCompositionRootClient } = await import(
      '../../../core/store/task-store'
    )
    const store = createTaskStore(getCompositionRootClient())
    const spy = vi.spyOn(store, 'listNonDoneTasks')

    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(a.id, store)

    expect(result.triageSkipReason).toBe('has-blockers')
    expect(spy).not.toHaveBeenCalled()
  })

  it('structured-spec skip does not call listNonDoneTasks', async () => {
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    // Extra task ensures the graph would be non-trivial if fetched
    await queue.enqueueTask('unrelated background task')
    const task = await queue.enqueueTask('implement X', undefined, {
      spec: {
        files: ['src/foo.ts'],
        verifyCmd: null,
        doneCriteria: ['foo is implemented'],
        taskType: 'auto' as const,
      },
    })

    const { createTaskStore, getCompositionRootClient } = await import(
      '../../../core/store/task-store'
    )
    const store = createTaskStore(getCompositionRootClient())
    const spy = vi.spyOn(store, 'listNonDoneTasks')

    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(task.id, store)

    expect(result.triageSkipReason).toBe('structured-spec')
    expect(spy).not.toHaveBeenCalled()
  })

  it('has-blockers wins when task satisfies both has-blockers and structured-spec', async () => {
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const blocker = await queue.enqueueTask('prerequisite')
    // Task carries BOTH a structured spec AND a pre-existing blocker edge
    const task = await queue.enqueueTask('implement X', undefined, {
      spec: {
        files: ['src/foo.ts'],
        verifyCmd: null,
        doneCriteria: ['foo is done'],
        taskType: 'auto' as const,
      },
    })
    await queue.addBlockers(task.id, [blocker.id])

    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(task.id)

    // has-blockers fires first (higher precedence than structured-spec)
    expect(result.triageSkipReason).toBe('has-blockers')
    expect(result.blockerCount).toBe(1)
  })

  it('trivial-graph fires when listNonDoneTasks returns []', async () => {
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    // Lone task — open graph (excluding self) is empty
    const task = await queue.enqueueTask('lone free-prose task')

    const { createTaskStore, getCompositionRootClient } = await import(
      '../../../core/store/task-store'
    )
    const store = createTaskStore(getCompositionRootClient())
    const spy = vi.spyOn(store, 'listNonDoneTasks')

    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(task.id, store)

    expect(result.triageSkipReason).toBe('trivial-graph')
    // listNonDoneTasks WAS called (trivial-graph requires it)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('renders the newest graph rows in the same oldest-first order as before', async () => {
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()

    const t1 = await queue.enqueueTask('oldest task')
    const t2 = await queue.enqueueTask('middle task')
    const t3 = await queue.enqueueTask('newest task')
    const excluded = await queue.enqueueTask('task being triaged (excluded)')

    const { createTaskStore, getCompositionRootClient } = await import(
      '../../../core/store/task-store'
    )
    const store = createTaskStore(getCompositionRootClient())

    const result = await store.listNonDoneTasks(excluded.id, 30)

    // Excluded task must not appear in results
    expect(result.map((t) => t.id)).not.toContain(excluded.id)
    // Results must be newest-first (DESC created_at)
    expect(result.map((t) => t.id)).toEqual([t3.id, t2.id, t1.id])
    const { buildTaskGraph } = await import('../../../workflows/triage-workflow')
    expect(buildTaskGraph([...result].reverse())).toBe(
      `${t1.id} | ${t1.status} | oldest task\n` +
        `${t2.id} | ${t2.status} | middle task\n` +
        `${t3.id} | ${t3.status} | newest task`,
    )
    expect(buildTaskGraph([])).toBe('(no other tasks)')
  })

  it('filterExistingTaskIds returns [] without querying when ids is empty', async () => {
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()

    const { createTaskStore, getCompositionRootClient } = await import(
      '../../../core/store/task-store'
    )
    const store = createTaskStore(getCompositionRootClient())
    const result = await store.filterExistingTaskIds([])
    expect(result).toEqual([])
  })

  it('filterExistingTaskIds drops unknown ids and preserves known ones', async () => {
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const t1 = await queue.enqueueTask('task 1')
    const t2 = await queue.enqueueTask('task 2')

    const { createTaskStore, getCompositionRootClient } = await import(
      '../../../core/store/task-store'
    )
    const store = createTaskStore(getCompositionRootClient())

    const result = await store.filterExistingTaskIds([t1.id, 'nonexistent-id', t2.id])
    expect(result).toHaveLength(2)
    expect(result).toContain(t1.id)
    expect(result).toContain(t2.id)
    expect(result).not.toContain('nonexistent-id')
  })

  it('filterExistingTaskIds is not called when LLM returns empty blockerTaskIds', async () => {
    setClaudeStub({
      exitCode: 0,
      stdout: envelope({ actionable: true, reason: 'all good', blockerTaskIds: [] }),
    })
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    await queue.enqueueTask('background task')
    const task = await queue.enqueueTask('main task')

    const { createTaskStore, getCompositionRootClient } = await import(
      '../../../core/store/task-store'
    )
    const store = createTaskStore(getCompositionRootClient())
    const spy = vi.spyOn(store, 'filterExistingTaskIds')

    const triage = await import('../../../workflows/triage-workflow')
    await triage.runTriage(task.id, store)

    expect(spy).not.toHaveBeenCalled()
  })

  it('filterExistingTaskIds receives at most MAX_BLOCKERS (10) ids', async () => {
    // LLM returns 15 blocker ids; the workflow pre-slices to MAX_BLOCKERS=10
    const manyBlockerIds = Array.from({ length: 15 }, (_, i) => `fake-blocker-${i}`)
    setClaudeStub({
      exitCode: 0,
      stdout: envelope({ actionable: false, reason: 'many deps', blockerTaskIds: manyBlockerIds }),
    })
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    await queue.enqueueTask('background task')
    const task = await queue.enqueueTask('main task')

    const { createTaskStore, getCompositionRootClient } = await import(
      '../../../core/store/task-store'
    )
    const store = createTaskStore(getCompositionRootClient())
    const spy = vi.spyOn(store, 'filterExistingTaskIds')

    const triage = await import('../../../workflows/triage-workflow')
    await triage.runTriage(task.id, store)

    expect(spy).toHaveBeenCalledOnce()
    const [receivedIds] = spy.mock.calls[0]!
    expect(receivedIds.length).toBeLessThanOrEqual(10)
  })
})
