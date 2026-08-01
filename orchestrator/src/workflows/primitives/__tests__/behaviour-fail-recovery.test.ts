/**
 * behaviour-fail-recovery.test.ts
 *
 * Verifies the FAIL path of behaviourVerify — specifically that:
 *  1. A FAIL verdict triggers handleTaskFailure exactly once.
 *  2. The errorOutput passed to handleTaskFailure contains criterion text
 *     AND the screenshot path.
 *  3. behaviourVerify throws (so merge never runs) on a FAIL.
 *  4. A second run (kind='fix') with PASS verdicts returns outcome:'pass'
 *     and does NOT call handleTaskFailure.
 *  5. A second (fix) run reads criteria from the ORIGIN task (fixForTaskId),
 *     not from the fix task itself.
 *  6. A FAIL on the recovery run calls handleTaskFailure exactly once
 *     (single-recovery invariant — no double spawn).
 *  7. handleTaskFailure on a recovery run receives the FIX task id, not the
 *     origin id, so the real handleTaskFailureWithFixTask escalates rather
 *     than spawning another recovery.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  behaviourVerify,
  type BehaviourVerifyDeps,
} from '../behaviour-verify'
import type { MarsCtx, MarsWorkflowInput } from '../index'
import type { Task } from '../../../core/queue'
import type { TraceEventStore } from '../../../core/lib/trace-events-store'
import type { HandleTaskFailureViaTaskResult } from '../../../core/queue-fix-tasks'
import type { DomainTaskStore } from '../../../core/store/task-store'
import { __resetContextCacheForTests } from '../../../core/context'

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

let tmpRepo: string

beforeAll(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), 'mars-behav-fail-'))
  process.env.MARS_REPO = tmpRepo
  __resetContextCacheForTests()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeTraceStore = (): { store: TraceEventStore } => {
  const store = {
    record: vi.fn(async () => {}),
  } as unknown as TraceEventStore
  return { store }
}

const makeCtx = (input: MarsWorkflowInput, traceStore: TraceEventStore): MarsCtx =>
  ({
    runId: input.taskId ?? 'mars-behav01',
    input,
    services: {
      store: { setQaReport: vi.fn(async () => {}) } as unknown as DomainTaskStore,
      traceStore,
    },
    emit: () => {},
    currentStep: undefined,
  }) as unknown as MarsCtx

type BrowserResult = { criterion: string; verdict: 'pass' | 'fail' | 'unverifiable'; screenshotPath: string | null; note: string }

const makeDeps = (args: {
  /** Task returned for the primary taskId (and any unrecognised id). */
  task: Task | null
  /** Per-id overrides for getTask — keyed by task id. */
  getTaskById?: Record<string, Task | null>
  /** Results runBrowserCheck should return; defaults to single-fail. */
  browserResults?: BrowserResult[]
  /** Result handleTaskFailure should return. */
  handleTaskFailureResult?: HandleTaskFailureViaTaskResult
}): { deps: BehaviourVerifyDeps; handleTaskFailure: ReturnType<typeof vi.fn> } => {
  const handleTaskFailure = vi.fn(
    async () => args.handleTaskFailureResult ?? { outcome: 'blocked' as const },
  )

  const defaultBrowserResults: BrowserResult[] = [
    {
      criterion: 'banner renders on the home page',
      verdict: 'fail',
      screenshotPath: 'qa/0.png',
      note: 'banner not visible',
    },
  ]

  const deps: BehaviourVerifyDeps = {
    getTask: vi.fn(async (id: string) => {
      if (args.getTaskById && id in args.getTaskById) {
        return args.getTaskById[id]
      }
      return args.task
    }),
    createProposal: vi.fn(async (title: string) => ({ id: 'prop-1', title }) as never),
    findOpenDraftByKpiTag: vi.fn(async () => null),
    raiseActionQueueItem: vi.fn(async () => 'aq-1'),
    getDiff: vi.fn(async () => 'ui/src/App.tsx\n'),
    runBrowserCheck: vi.fn(async () => args.browserResults ?? defaultBrowserResults),
    handleTaskFailure,
  }

  return { deps, handleTaskFailure }
}

const taskWithCriteria = (id: string, doneCriteria: string[]): Task =>
  ({
    id,
    spec: {
      files: [],
      verifyCmd: null,
      doneCriteria,
      mergeMode: 'auto',
    },
    fixForTaskId: null,
  }) as unknown as Task

// ---------------------------------------------------------------------------
// Fail-recovery suite
// ---------------------------------------------------------------------------

describe('behaviourVerify — FAIL verdict triggers recovery', () => {
  let viteRepoRoot: string

  beforeEach(() => {
    __resetContextCacheForTests()
    process.env.MARS_REPO = tmpRepo
    viteRepoRoot = mkdtempSync(join(tmpdir(), 'mars-behav-fail-bv-'))
    // Minimal Vite project so discoverAppBoot finds a BootPlan and the
    // browser-check path runs (boot !== null).
    writeFileSync(join(viteRepoRoot, 'vite.config.ts'), '')
  })

  afterEach(() => {
    rmSync(viteRepoRoot, { recursive: true, force: true })
  })

  // ── Acceptance 1: FAIL verdict calls handleTaskFailure exactly once ────────

  it('calls handleTaskFailure exactly once when a browser-check criterion fails', async () => {
    const { store } = makeTraceStore()
    const ctx = makeCtx({ taskId: 'mars-behav01', kind: 'task' }, store)
    const { deps, handleTaskFailure } = makeDeps({
      task: taskWithCriteria('mars-behav01', ['banner renders on the home page']),
      browserResults: [
        { criterion: 'banner renders on the home page', verdict: 'fail', screenshotPath: 'qa/0.png', note: 'not found' },
      ],
    })

    await expect(
      behaviourVerify(ctx, { worktree: { path: viteRepoRoot, branch: 'task/mars-behav01' }, deps }),
    ).rejects.toThrow()

    expect(handleTaskFailure).toHaveBeenCalledTimes(1)
  })

  // ── Acceptance 2: errorOutput contains criterion text AND screenshot path ──

  it('errorOutput passed to handleTaskFailure includes criterion text and screenshot path', async () => {
    const { store } = makeTraceStore()
    const ctx = makeCtx({ taskId: 'mars-behav01', kind: 'task' }, store)
    const { deps, handleTaskFailure } = makeDeps({
      task: taskWithCriteria('mars-behav01', ['banner renders on the home page']),
      browserResults: [
        { criterion: 'banner renders on the home page', verdict: 'fail', screenshotPath: 'qa/0.png', note: '' },
      ],
    })

    await expect(
      behaviourVerify(ctx, { worktree: { path: viteRepoRoot, branch: 'task/mars-behav01' }, deps }),
    ).rejects.toThrow()

    const call = handleTaskFailure.mock.calls[0][0]
    expect(call.errorOutput).toContain('banner renders on the home page')
    expect(call.errorOutput).toContain('qa/0.png')
  })

  // ── Acceptance 3: behaviourVerify THROWS on FAIL (merge never runs) ────────

  it('throws on a FAIL verdict so the caller merge step never executes', async () => {
    const { store } = makeTraceStore()
    const ctx = makeCtx({ taskId: 'mars-behav01', kind: 'task' }, store)
    const { deps } = makeDeps({
      task: taskWithCriteria('mars-behav01', ['banner renders on the home page']),
    })

    await expect(
      behaviourVerify(ctx, { worktree: { path: viteRepoRoot, branch: 'task/mars-behav01' }, deps }),
    ).rejects.toThrow(/behaviour verification/)
  })

  // ── Acceptance 4: Recovery run with PASS — returns pass, no recovery spawned

  it('returns outcome:pass when a fix-kind run produces all-pass browser results', async () => {
    const originId = 'mars-behav01'
    const fixId = 'mars-behav01-fix'

    const { store } = makeTraceStore()
    const ctx = makeCtx(
      { taskId: fixId, kind: 'fix', fixForTaskId: originId },
      store,
    )
    const { deps, handleTaskFailure } = makeDeps({
      task: taskWithCriteria(fixId, []),
      getTaskById: {
        [fixId]: taskWithCriteria(fixId, []),
        [originId]: taskWithCriteria(originId, ['banner renders on the home page']),
      },
      browserResults: [
        { criterion: 'banner renders on the home page', verdict: 'pass', screenshotPath: 'qa/0.png', note: 'visible' },
      ],
    })

    const result = await behaviourVerify(ctx, {
      worktree: { path: viteRepoRoot, branch: 'task/mars-behav01-fix' },
      deps,
    })

    expect(result.outcome).toBe('pass')
    expect(handleTaskFailure).not.toHaveBeenCalled()
  })

  // ── Acceptance 5: Fix run reads criteria from origin task (fixForTaskId) ───

  it('fix run uses doneCriteria from the origin task (fixForTaskId), not the fix task', async () => {
    const originId = 'mars-origin'
    const fixId = 'mars-fix'

    const { store } = makeTraceStore()
    const ctx = makeCtx(
      { taskId: fixId, kind: 'fix', fixForTaskId: originId },
      store,
    )

    // Fix task has no doneCriteria; origin has one criterion.
    const { deps, handleTaskFailure } = makeDeps({
      task: taskWithCriteria(fixId, []),
      getTaskById: {
        [fixId]: taskWithCriteria(fixId, []),
        [originId]: taskWithCriteria(originId, ['checkout flow completes']),
      },
      browserResults: [
        { criterion: 'checkout flow completes', verdict: 'fail', screenshotPath: 'qa/0.png', note: '' },
      ],
    })

    await expect(
      behaviourVerify(ctx, { worktree: { path: viteRepoRoot, branch: `task/${fixId}` }, deps }),
    ).rejects.toThrow()

    // handleTaskFailure was invoked — proving criteria were resolved from origin
    // (if fix task's empty criteria were used, browser-check would produce 0
    // rows and foldVerdicts would return 'unverifiable', not 'fail').
    expect(handleTaskFailure).toHaveBeenCalledTimes(1)
    const call = handleTaskFailure.mock.calls[0][0]
    expect(call.errorOutput).toContain('checkout flow completes')
  })

  // ── Acceptance 6: Single-recovery invariant — recovery run FAIL calls once ─

  it('calls handleTaskFailure exactly once even on a recovery (fix) run that fails', async () => {
    const originId = 'mars-behav01'
    const fixId = 'mars-behav01-fix'

    const { store } = makeTraceStore()
    const ctx = makeCtx(
      { taskId: fixId, kind: 'fix', fixForTaskId: originId },
      store,
    )
    const { deps, handleTaskFailure } = makeDeps({
      task: taskWithCriteria(fixId, []),
      getTaskById: {
        [fixId]: taskWithCriteria(fixId, []),
        [originId]: taskWithCriteria(originId, ['header text matches design']),
      },
      browserResults: [
        { criterion: 'header text matches design', verdict: 'fail', screenshotPath: 'qa/0.png', note: '' },
      ],
    })

    await expect(
      behaviourVerify(ctx, { worktree: { path: viteRepoRoot, branch: `task/${fixId}` }, deps }),
    ).rejects.toThrow()

    // The single-recovery invariant: exactly one handleTaskFailure call even
    // though this is itself a recovery run. The real handleTaskFailureWithFixTask
    // would see fixForTaskId!=null and escalate rather than spawning another
    // recovery — that logic lives in the real implementation; here we prove the
    // primitive passes the right taskId so that escalation path fires.
    expect(handleTaskFailure).toHaveBeenCalledTimes(1)
  })

  // ── Acceptance 7: handleTaskFailure receives fix task id on recovery run ───

  it('passes the FIX task id (not origin id) to handleTaskFailure on a recovery run', async () => {
    const originId = 'mars-behav01'
    const fixId = 'mars-behav01-fix'

    const { store } = makeTraceStore()
    const ctx = makeCtx(
      { taskId: fixId, kind: 'fix', fixForTaskId: originId },
      store,
    )
    const { deps, handleTaskFailure } = makeDeps({
      task: taskWithCriteria(fixId, []),
      getTaskById: {
        [fixId]: taskWithCriteria(fixId, []),
        [originId]: taskWithCriteria(originId, ['login button is visible']),
      },
      browserResults: [
        { criterion: 'login button is visible', verdict: 'fail', screenshotPath: 'qa/0.png', note: '' },
      ],
    })

    await expect(
      behaviourVerify(ctx, { worktree: { path: viteRepoRoot, branch: `task/${fixId}` }, deps }),
    ).rejects.toThrow()

    expect(handleTaskFailure).toHaveBeenCalledTimes(1)
    const call = handleTaskFailure.mock.calls[0][0]
    // The fix task id must be passed — this is what causes the real
    // handleTaskFailureWithFixTask to escalate (it sees task.fixForTaskId != null)
    // instead of spawning a second recovery (which would violate ADR-0040).
    expect(call.taskId).toBe(fixId)
    expect(call.taskId).not.toBe(originId)
  })
})
