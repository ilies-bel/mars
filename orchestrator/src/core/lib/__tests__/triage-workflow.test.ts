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
        previewCmd: null,
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

})
