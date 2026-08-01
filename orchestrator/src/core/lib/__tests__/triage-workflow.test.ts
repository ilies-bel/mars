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

const originalProvider = process.env.MARS_WORKER_PROVIDER

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

const setCodexStub = (stub: ClaudeStub): void => {
  vi.doMock('../git/claude', async () => {
    const actual = await vi.importActual<typeof import('../git/claude')>('../git/claude')
    return {
      ...actual,
      runSubprocessStreaming: vi.fn(async (
        _command: string,
        _args: readonly string[],
        _cwd: string,
        onLine?: (event: { stream: 'stdout' | 'stderr'; line: string }) => void | Promise<void>,
      ) => {
        if (onLine) {
          for (const line of stub.stdout.split('\n')) {
            await onLine({ stream: 'stdout', line })
          }
        }
        return { exitCode: stub.exitCode, stdout: stub.stdout, stderr: stub.stderr ?? '' }
      }),
    }
  })
}

const envelope = (jsonResult: unknown): string =>
  JSON.stringify({ result: JSON.stringify(jsonResult), is_error: false })

// Must match TRIVIAL_GRAPH_SIZE in src/workflows/triage-workflow.ts. An open
// graph with at most this many OTHER non-done tasks short-circuits the LLM.
const TRIVIAL_GRAPH_SIZE = 5

// Enqueue `count` filler tasks so the open graph is big enough for the
// trivial-graph rule NOT to fire and LLM triage to run.
const fillGraph = async (
  queue: { enqueueTask: (prompt: string) => Promise<{ id: string }> },
  count: number,
): Promise<void> => {
  for (let i = 0; i < count; i++) {
    await queue.enqueueTask(`filler task ${i}`)
  }
}

const busyGraph = TRIVIAL_GRAPH_SIZE + 1

describe('triage workflow', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    process.env.MARS_WORKER_PROVIDER = 'claude'
  })

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../git/claude')
    delete process.env.MARS_REPO
    if (originalProvider === undefined) delete process.env.MARS_WORKER_PROVIDER
    else process.env.MARS_WORKER_PROVIDER = originalProvider
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
    await fillGraph(queue, busyGraph)
    const task = await queue.enqueueTask('implement X')

    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(task.id)

    expect(result.triageSkipReason).toBeUndefined()
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
    await fillGraph(queue, busyGraph)
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
    await fillGraph(queue, busyGraph)
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
    // Enough other tasks that the graph is NOT trivial, so the structured-spec
    // rule is what fires rather than trivial-graph.
    await fillGraph(queue, busyGraph)
    const task = await queue.enqueueTask('implement X', undefined, {
      spec: {
        files: ['src/foo.ts'],
        verifyCmd: null,
        doneCriteria: ['foo is implemented'],
        mergeMode: 'auto' as const,
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

  // ── trivial-graph threshold: boundary + verdict equivalence ───────────────
  //
  // The short-circuit is only safe if it lands on the SAME classification the
  // LLM would have produced. These tests pin both halves of that claim:
  // the skip fires exactly up to the threshold, and the outcome it writes is
  // byte-for-byte the outcome of an LLM verdict of "actionable, no blockers"
  // on the very same graph.

  for (const otherTasks of [0, 1, TRIVIAL_GRAPH_SIZE - 1, TRIVIAL_GRAPH_SIZE]) {
    it(`skips LLM with ${otherTasks} other open task(s) (at or below the threshold)`, async () => {
      // No Claude stub — if the LLM were called the run would fail outright.
      vi.resetModules()
      const queue = await import('../../queue')
      await queue.migrateQueueSchema()
      await fillGraph(queue, otherTasks)
      const task = await queue.enqueueTask('free-prose task')

      const triage = await import('../../../workflows/triage-workflow')
      const result = await triage.runTriage(task.id)

      expect(result.triageSkipReason).toBe('trivial-graph')
      expect(result.actionable).toBe(true)
      expect(result.blockerCount).toBe(0)
      expect(await queue.listBlockers(task.id)).toEqual([])
      expect((await queue.getTask(task.id))?.status).toBe('queued')
    })
  }

  it(`runs LLM triage at ${TRIVIAL_GRAPH_SIZE + 1} other open tasks (just past the threshold)`, async () => {
    setClaudeStub({
      exitCode: 0,
      stdout: envelope({ actionable: true, reason: 'fine', blockerTaskIds: [] }),
    })
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    await fillGraph(queue, TRIVIAL_GRAPH_SIZE + 1)
    const task = await queue.enqueueTask('free-prose task')

    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(task.id)

    expect(result.triageSkipReason).toBeUndefined()
  })

  it('the skipped verdict equals the LLM verdict on the same trivial graph', async () => {
    // Same graph shape, run twice: once through the short-circuit, once through
    // the LLM path with the verdict the LLM returns for a graph that holds no
    // candidate blockers. Task state and triage result must match.
    vi.resetModules()
    let queue = await import('../../queue')
    await queue.migrateQueueSchema()
    await fillGraph(queue, TRIVIAL_GRAPH_SIZE)
    const skipped = await queue.enqueueTask('do the thing')

    let triage = await import('../../../workflows/triage-workflow')
    const skippedResult = await triage.runTriage(skipped.id)
    const skippedStatus = (await queue.getTask(skipped.id))?.status
    const skippedBlockers = await queue.listBlockers(skipped.id)

    // Now the LLM path, on a graph one task larger so the short-circuit does
    // not fire, with the verdict such a graph yields.
    vi.resetModules()
    setClaudeStub({
      exitCode: 0,
      stdout: envelope({ actionable: true, reason: 'nothing blocks it', blockerTaskIds: [] }),
    })
    queue = await import('../../queue')
    await fillGraph(queue, 1)
    const judged = await queue.enqueueTask('do the thing')
    triage = await import('../../../workflows/triage-workflow')
    const judgedResult = await triage.runTriage(judged.id)

    expect(judgedResult.triageSkipReason).toBeUndefined()
    expect(skippedResult.triageSkipReason).toBe('trivial-graph')
    // The classification itself — actionable, no blockers, promoted to queued —
    // is identical. Only the reason string (and the token bill) differ.
    expect(skippedResult.actionable).toBe(judgedResult.actionable)
    expect(skippedResult.blockerCount).toBe(judgedResult.blockerCount)
    expect(skippedStatus).toBe((await queue.getTask(judged.id))?.status)
    expect(skippedBlockers).toEqual(await queue.listBlockers(judged.id))
  })

  it('an explicitly declared blocker still wins over the trivial-graph skip', async () => {
    // has-blockers is checked first, so raising the threshold cannot swallow an
    // operator-declared prerequisite in a small graph.
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const a = await queue.enqueueTask('needs b first')
    const b = await queue.enqueueTask('b')
    await queue.addBlockers(a.id, [b.id])

    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(a.id)

    expect(result.triageSkipReason).toBe('has-blockers')
    expect(await queue.listBlockers(a.id)).toEqual([b.id])
    expect((await queue.getTask(a.id))?.status).toBe('draft')
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
    // TRIVIAL_GRAPH_SIZE + 1 other open tasks: past the short-circuit, so none
    // of the skip rules fire and the LLM path executes normally.
    await fillGraph(queue, busyGraph)
    const task = await queue.enqueueTask('free-prose task')

    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(task.id)

    // No skip reason — LLM ran normally
    expect(result.triageSkipReason).toBeUndefined()
    expect(result.actionable).toBe(true)
    const reloaded = await queue.getTask(task.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('triages a Codex NDJSON response through the configured provider reader', async () => {
    process.env.MARS_WORKER_PROVIDER = 'codex'
    setCodexStub({
      exitCode: 0,
      stdout: [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
        '',
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: JSON.stringify({
              actionable: true,
              reason: 'ready',
              blockerTaskIds: [],
            }),
          },
        }),
        JSON.stringify({ type: 'turn.completed' }),
        '{"type":"item.completed"',
      ].join('\n'),
    })
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    await fillGraph(queue, busyGraph)
    const task = await queue.enqueueTask('Codex triage fixture')

    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(task.id)

    expect(result).toMatchObject({
      taskId: task.id,
      actionable: true,
      blockerCount: 0,
      reason: 'ready',
    })
    expect((await queue.getTask(task.id))?.status).toBe('queued')
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
    await fillGraph(queue, busyGraph)
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
//  • known task ids reject hallucinated blocker references and only the first
//    MAX_BLOCKERS valid references are persisted.

describe('triage workflow — optimised data access', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    process.env.MARS_WORKER_PROVIDER = 'claude'
  })

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../git/claude')
    delete process.env.MARS_REPO
    if (originalProvider === undefined) delete process.env.MARS_WORKER_PROVIDER
    else process.env.MARS_WORKER_PROVIDER = originalProvider
    rmSync(repo, { recursive: true, force: true })
  })

  it('has-blockers skip does not call listNonDoneTasks', async () => {
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const a = await queue.enqueueTask('task with pre-declared blocker')
    const b = await queue.enqueueTask('prerequisite task')
    await queue.addBlockers(a.id, [b.id])
    // Enough tasks that the graph would be non-trivial if fetched
    await fillGraph(queue, busyGraph)

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
    // Enough tasks that the graph would be non-trivial if fetched
    await fillGraph(queue, busyGraph)
    const task = await queue.enqueueTask('implement X', undefined, {
      spec: {
        files: ['src/foo.ts'],
        verifyCmd: null,
        doneCriteria: ['foo is implemented'],
        mergeMode: 'auto' as const,
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
        mergeMode: 'auto' as const,
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
    await fillGraph(queue, busyGraph)
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

  it('records only the first ten valid blocker references', async () => {
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    await fillGraph(queue, busyGraph)
    const task = await queue.enqueueTask('main task')
    const blockers = []
    for (let i = 0; i < 11; i++) {
      blockers.push(await queue.enqueueTask(`blocker ${i}`))
    }

    vi.resetModules()
    setClaudeStub({
      exitCode: 0,
      stdout: envelope({
        actionable: false,
        reason: 'many deps',
        blockerTaskIds: blockers.map((blocker) => blocker.id),
      }),
    })

    const queue2 = await import('../../queue')
    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(task.id)

    expect(result.blockerCount).toBe(10)
    expect(await queue2.listBlockers(task.id)).toEqual(
      blockers.slice(0, 10).map((blocker) => blocker.id),
    )
  })
})
