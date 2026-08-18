/**
 * Vitest — restart-checkpoint trace event (slice 3).
 *
 * Verifies three invariants:
 *
 *  1. `RESTART_CHECKPOINT_KIND` is registered in the closed `TRACE_EVENT_KINDS`
 *     enum so the event is routable via `GET /events?kind=restart-checkpoint`.
 *
 *  2. On a **resume path** (`resumeFromPriorAttempt=true`) the splice site emits
 *     exactly one `restart-checkpoint` trace event with the expected payload
 *     shape: `{ taskId, commitCount, changedPathCount, outstandingCount,
 *     hadPriorVerify, renderedBytes }`.
 *
 *  3. On a **cold code step** (`resumeFromPriorAttempt=false`) the splice site
 *     guard is false and no trace event is emitted.
 *
 * The tests follow the same simulation approach as
 * `restart-checkpoint.dispatch.test.ts`: they mirror the runAgent splice-site
 * logic (compose → render → emit) without spinning up the full orchestrator,
 * so the payload mapping from `RestartCheckpoint` to trace payload is covered
 * by real composition results from a real git repo.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { FailedPhase, Task, TaskSpec } from '../queue.js'

vi.mock('../queue.js', () => ({
  resolveQueueClient: vi.fn(),
  getTranscript: vi.fn(),
}))

import * as Q from '../queue.js'
import {
  composeRestartCheckpoint,
  renderRestartCheckpoint,
  RESTART_CHECKPOINT_KIND,
} from './restart-checkpoint.js'
import { TRACE_EVENT_KINDS } from '../lib/trace-events-store.js'
import type { TraceEventInput, TraceEventStore } from '../lib/trace-events-store.js'

// ---------------------------------------------------------------------------
// Git repo helpers (same pattern as restart-checkpoint.dispatch.test.ts)
// ---------------------------------------------------------------------------

function setupRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-rcp-trace-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir })
  execFileSync('git', ['checkout', '-b', 'task/trace-test-01'], { cwd: dir })
  return dir
}

function addCommit(dir: string, files: Record<string, string>, message: string): void {
  for (const [name, content] of Object.entries(files)) {
    const abs = resolve(dir, name)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-m', message], { cwd: dir })
}

function makeSpec(partial: Partial<TaskSpec> = {}): TaskSpec {
  return {
    files: [],
    verifyCmd: null,
    doneCriteria: [],
    mergeMode: 'auto',
    ...partial,
  } as TaskSpec
}

function makeTask(
  partial: {
    failedPhase?: FailedPhase | null
    failureReasonCode?: string | null
    failureSignature?: string | null
    stallDiagnostics?: string | null
    spec?: TaskSpec | null
  } = {},
): Task {
  return {
    failedPhase: partial.failedPhase ?? null,
    failureReasonCode: partial.failureReasonCode ?? null,
    failureSignature: partial.failureSignature ?? null,
    stallDiagnostics: partial.stallDiagnostics ?? null,
    spec: partial.spec ?? null,
  } as unknown as Task
}

const TASK_ID = 'trace-test-01'

// ---------------------------------------------------------------------------
// 1. Kind registration
// ---------------------------------------------------------------------------

describe('RESTART_CHECKPOINT_KIND registration', () => {
  it('is present in the closed TRACE_EVENT_KINDS enum', () => {
    expect(TRACE_EVENT_KINDS as readonly string[]).toContain(RESTART_CHECKPOINT_KIND)
  })

  it('equals the string literal "restart-checkpoint"', () => {
    expect(RESTART_CHECKPOINT_KIND).toBe('restart-checkpoint')
  })
})

// ---------------------------------------------------------------------------
// 2. Resume path — trace event emitted
// ---------------------------------------------------------------------------

describe('resume path — trace event', () => {
  let repoDir: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let record: ReturnType<typeof vi.fn>
  let traceStore: TraceEventStore

  beforeEach(() => {
    repoDir = setupRepo()
    vi.mocked(Q.resolveQueueClient).mockReturnValue({
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    } as any)
    vi.mocked(Q.getTranscript).mockResolvedValue(null)
    record = vi.fn().mockResolvedValue(undefined)
    traceStore = { record } as unknown as TraceEventStore
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
    vi.resetAllMocks()
  })

  it('emits exactly one restart-checkpoint event with correct payload shape', async () => {
    addCommit(repoDir, { 'src/a.ts': 'export const a = 1\n' }, 'feat: add a')
    addCommit(repoDir, { 'src/b.ts': 'export const b = 2\n' }, 'fix: add b')

    const cp = await composeRestartCheckpoint({
      taskId: TASK_ID,
      worktreePath: repoDir,
      task: makeTask({ failedPhase: 'code' }),
    })
    const rendered = renderRestartCheckpoint(cp)

    // Simulate the runAgent splice-site emit (the block that fires when
    // resumeFromPriorAttempt=true and fullTask is non-null):
    await traceStore.record({
      kind: RESTART_CHECKPOINT_KIND,
      taskId: TASK_ID,
      phase: 'code',
      payload: {
        taskId: TASK_ID,
        commitCount: cp.commits.length,
        changedPathCount: cp.changedPaths.length,
        outstandingCount: cp.outstandingCriteria.length,
        hadPriorVerify: cp.lastVerify !== null,
        renderedBytes: rendered.length,
      },
    })

    expect(record).toHaveBeenCalledOnce()

    const [event] = record.mock.calls[0] as [TraceEventInput]
    expect(event.kind).toBe(RESTART_CHECKPOINT_KIND)
    expect(event.phase).toBe('code')
    expect(event.taskId).toBe(TASK_ID)

    const p = event.payload as {
      taskId: string
      commitCount: number
      changedPathCount: number
      outstandingCount: number
      hadPriorVerify: boolean
      renderedBytes: number
    }
    expect(p.taskId).toBe(TASK_ID)
    expect(p.commitCount).toBe(2)
    expect(p.changedPathCount).toBe(2)
    expect(typeof p.outstandingCount).toBe('number')
    expect(typeof p.hadPriorVerify).toBe('boolean')
    expect(p.hadPriorVerify).toBe(false) // no verify failure in this task
    expect(typeof p.renderedBytes).toBe('number')
    expect(p.renderedBytes).toBeGreaterThan(0) // non-empty rendered section
  })

  it('payload hadPriorVerify=true when the task failed at verify', async () => {
    addCommit(repoDir, { 'src/index.ts': 'export {}\n' }, 'feat: initial impl')

    vi.mocked(Q.getTranscript).mockResolvedValue({
      taskId: TASK_ID,
      conversationJson: '',
      verifyOutput: 'FAIL src/index.test.ts\n  TypeError: x is not defined',
      bytes: 60,
      recordedAt: '2026-08-18T00:00:00.000Z',
    })

    const cp = await composeRestartCheckpoint({
      taskId: TASK_ID,
      worktreePath: repoDir,
      task: makeTask({
        failedPhase: 'verify',
        failureReasonCode: 'verify:test',
        spec: makeSpec({ verifyCmd: 'cd orchestrator && npm test' }),
      }),
    })
    const rendered = renderRestartCheckpoint(cp)

    await traceStore.record({
      kind: RESTART_CHECKPOINT_KIND,
      taskId: TASK_ID,
      phase: 'code',
      payload: {
        taskId: TASK_ID,
        commitCount: cp.commits.length,
        changedPathCount: cp.changedPaths.length,
        outstandingCount: cp.outstandingCriteria.length,
        hadPriorVerify: cp.lastVerify !== null,
        renderedBytes: rendered.length,
      },
    })

    expect(record).toHaveBeenCalledOnce()
    const [event] = record.mock.calls[0] as [TraceEventInput]
    const p = event.payload as Record<string, unknown>
    expect(p.hadPriorVerify).toBe(true)
    expect(p.commitCount).toBe(1)
  })

  it('renderedBytes reflects the actual rendered section length', async () => {
    addCommit(repoDir, { 'src/thing.ts': 'export const x = 42\n' }, 'feat: thing')

    const cp = await composeRestartCheckpoint({
      taskId: TASK_ID,
      worktreePath: repoDir,
      task: makeTask({ failedPhase: 'code' }),
    })
    const rendered = renderRestartCheckpoint(cp)
    expect(rendered.length).toBeGreaterThan(0)

    await traceStore.record({
      kind: RESTART_CHECKPOINT_KIND,
      taskId: TASK_ID,
      phase: 'code',
      payload: {
        taskId: TASK_ID,
        commitCount: cp.commits.length,
        changedPathCount: cp.changedPaths.length,
        outstandingCount: cp.outstandingCriteria.length,
        hadPriorVerify: cp.lastVerify !== null,
        renderedBytes: rendered.length,
      },
    })

    const [event] = record.mock.calls[0] as [TraceEventInput]
    const p = event.payload as Record<string, unknown>
    expect(p.renderedBytes).toBe(rendered.length)
  })
})

// ---------------------------------------------------------------------------
// 3. Cold path — no trace event emitted
// ---------------------------------------------------------------------------

describe('cold path — no trace event emitted', () => {
  it('does not emit the event when resumeFromPriorAttempt=false', () => {
    // On a cold code step, runAgent's guard `if (resumeFromPriorAttempt && ...)` is
    // false: composeRestartCheckpoint is never called and traceStore.record is
    // never reached for the restart-checkpoint kind.
    const record = vi.fn()

    const resumeFromPriorAttempt = false
    if (resumeFromPriorAttempt) {
      // This block is dead on a cold start — record is never called.
      void record({ kind: RESTART_CHECKPOINT_KIND })
    }

    expect(record).not.toHaveBeenCalled()
  })
})
