/**
 * Regression / acceptance test — PRD 6bad3849 slice 1
 *
 * Asserts that the verifyOutput string produced by the `review` primitive
 * contains, for every non-deferred step that actually shelled out:
 *   • the true exit code  (e.g. `exit=0`, `exit=1`, `exit=killed`)
 *   • the invocation line (e.g. `$ npx tsc --noEmit`)
 *
 * Coverage: one passing step + one failing step, both with cmd metadata.
 *
 * Strategy to observe `verifyOutput`:
 *   `restoreWorktreeIfMissing` is mocked to return 'present' so the verify
 *   body runs past the worktree-hygiene block.  `mockUpdateTask` is then
 *   sequenced:
 *     1. status=verifying  → resolves  (normal first call)
 *     2. status=failed     → rejects   (inside the !r.passed branch)
 *                            This prevents `_verifyFailedRecorded` from being
 *                            set, so the outer catch runs its updateTask call.
 *     3. verifyOutput=...  → resolves  (outer catch call, verifyOutput present)
 *   The test asserts on the third call's `verifyOutput` field.
 *
 * The `gateOutcomes` JSON block (part of `capturedVerifyOutput`) is also
 * checked to verify the `exitCode` field is present per-gate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __resetContextCacheForTests } from '../../../core/context'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockUpdateTask,
  mockVerifyChanges,
  mockLoadVerifyScopes,
  mockGetChangedFiles,
  mockAcquireLock,
  mockAppendEnrichmentScopes,
  mockRecordEnrichmentShadowRuns,
  mockHandleTaskFailureWithFixTask,
  mockRestoreWorktreeIfMissing,
} = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockVerifyChanges: vi.fn(),
  mockLoadVerifyScopes: vi.fn().mockResolvedValue([]),
  mockGetChangedFiles: vi.fn().mockResolvedValue([]),
  mockAcquireLock: vi.fn().mockResolvedValue(() => undefined),
  mockAppendEnrichmentScopes: vi.fn().mockImplementation(
    (_client: unknown, scopes: unknown[]) => Promise.resolve(scopes),
  ),
  mockRecordEnrichmentShadowRuns: vi.fn().mockResolvedValue(undefined),
  mockHandleTaskFailureWithFixTask: vi.fn().mockResolvedValue({ outcome: 'fix-task-spawned' }),
  mockRestoreWorktreeIfMissing: vi.fn().mockResolvedValue('present'),
}))

vi.mock('../../../core/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/queue')>()
  return { ...orig, updateTask: mockUpdateTask }
})

vi.mock('../../../core/lib/git/verify', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/verify')>()
  return {
    ...orig,
    verifyChanges: mockVerifyChanges,
    loadVerifyScopes: mockLoadVerifyScopes,
    getChangedFiles: mockGetChangedFiles,
  }
})

vi.mock('../../../core/lib/gate-enrichment', () => ({
  appendEnrichmentScopes: mockAppendEnrichmentScopes,
  recordEnrichmentShadowRuns: mockRecordEnrichmentShadowRuns,
}))

vi.mock('../../../core/lib/git/lock', () => ({
  acquireLock: mockAcquireLock,
}))

vi.mock('../../../core/queue-fix-tasks', () => ({
  handleTaskFailureWithFixTask: mockHandleTaskFailureWithFixTask,
}))

// Mock restoreWorktreeIfMissing so the verify body runs past the
// worktree-hygiene block even with a non-existent tmp path.
vi.mock('../../../core/lib/git/worktree', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/worktree')>()
  return { ...orig, restoreWorktreeIfMissing: mockRestoreWorktreeIfMissing }
})

// Import the primitive AFTER vi.mock() calls are hoisted.
const { review } = await import('../index')

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

let tmpRepo: string

beforeAll(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), 'mars-verify-output-'))
})

afterAll(() => {
  delete process.env.MARS_REPO
  __resetContextCacheForTests()
})

/** Minimal MarsCtx stub. */
const makeCtx = (taskId = 'mars-test01') =>
  ({
    runId: taskId,
    workflowId: 'task',
    input: { taskId, kind: 'fix' },
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    signal: new AbortController().signal,
    services: {
      store: {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        batch: vi.fn().mockResolvedValue([]),
      },
      traceStore: null,
    },
    currentStep: null,
    emit: vi.fn(),
    step: vi.fn(),
  }) as never

/** Worktree stub — path need not exist for these tests. */
const worktree = (taskId: string) => ({
  path: `/tmp/wt-${taskId}`,
  branch: `task/${taskId}`,
})

// ---------------------------------------------------------------------------
// Shared reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  process.env.MARS_REPO = tmpRepo
  __resetContextCacheForTests()

  mockUpdateTask.mockClear().mockResolvedValue(undefined)
  mockVerifyChanges.mockReset()
  mockLoadVerifyScopes.mockClear().mockResolvedValue([])
  mockGetChangedFiles.mockClear().mockResolvedValue([])
  mockAcquireLock.mockClear().mockResolvedValue(() => undefined)
  mockAppendEnrichmentScopes
    .mockClear()
    .mockImplementation((_c: unknown, sc: unknown[]) => Promise.resolve(sc))
  mockRecordEnrichmentShadowRuns.mockClear().mockResolvedValue(undefined)
  mockHandleTaskFailureWithFixTask.mockClear().mockResolvedValue({ outcome: 'fix-task-spawned' })
  mockRestoreWorktreeIfMissing.mockClear().mockResolvedValue('present')
})

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

describe('verifyOutput per-step exit code and invocation', () => {
  it('verifyOutput contains exit code and cmd+args for both the passing and failing step', async () => {
    // One passing step (typecheck, exit=0) and one failing step (test, exit=1).
    mockVerifyChanges.mockResolvedValue({
      passed: false,
      steps: [
        {
          name: 'typecheck',
          passed: true,
          output: 'all types ok',
          exitCode: 0,
          cmd: 'npx',
          args: ['tsc', '--noEmit'],
          stepDir: '/tmp/wt-output01',
          tier: 'task' as const,
          duration: 120,
        },
        {
          name: 'test',
          passed: false,
          output: '5 tests failed',
          exitCode: 1,
          cmd: 'npm',
          args: ['test'],
          stepDir: '/tmp/wt-output01',
          tier: 'task' as const,
          duration: 4800,
        },
      ],
    })

    // Three updateTask calls inside review() for this scenario:
    //   1. status=verifying  (before verifyChanges)          → resolves
    //   2. status=failed     (inside the !r.passed block)    → rejects so
    //                          _verifyFailedRecorded is never set
    //   3. verifyOutput=...  (outer catch, _verifyFailedRecorded=false) → resolves
    mockUpdateTask
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('simulated db write failure'))
      .mockResolvedValue(undefined)

    const taskId = 'mars-output01'
    await expect(
      review(makeCtx(taskId), { kind: 'fix', worktree: worktree(taskId) }),
    ).rejects.toThrow()

    // The third updateTask call (outer catch) carries verifyOutput.
    const withVerifyOutput = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>).verifyOutput !== undefined,
    )
    expect(withVerifyOutput).toHaveLength(1)

    const verifyOutput = withVerifyOutput[0][1].verifyOutput as string

    // ── Passing step (typecheck, exit=0) ─────────────────────────────────
    expect(verifyOutput).toContain('typecheck')
    expect(verifyOutput).toContain('pass')
    expect(verifyOutput).toContain('exit=0')
    expect(verifyOutput).toContain('$ npx tsc --noEmit')

    // ── Failing step (test, exit=1) ───────────────────────────────────────
    expect(verifyOutput).toContain('test')
    expect(verifyOutput).toContain('fail')
    expect(verifyOutput).toContain('exit=1')
    expect(verifyOutput).toContain('$ npm test')

    // ── gateOutcomes JSON block has exitCode per gate ─────────────────────
    expect(verifyOutput).toContain('"exitCode"')
    // Each gate's exitCode is serialised as a JSON number (or null).
    expect(verifyOutput).toContain('"exitCode": 0')
    expect(verifyOutput).toContain('"exitCode": 1')
  })

  it('exit=killed appears in the header when exitCode is null (abort signal)', async () => {
    mockVerifyChanges.mockResolvedValue({
      passed: false,
      steps: [
        {
          name: 'test',
          passed: false,
          output: 'step killed by abort signal\n',
          exitCode: null,
          cmd: 'npm',
          args: ['test'],
          stepDir: '/tmp/wt-output02',
          tier: 'task' as const,
        },
      ],
    })

    mockUpdateTask
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('simulated db write failure'))
      .mockResolvedValue(undefined)

    const taskId = 'mars-output02'
    await expect(
      review(makeCtx(taskId), { kind: 'fix', worktree: worktree(taskId) }),
    ).rejects.toThrow()

    const withVerifyOutput = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>).verifyOutput !== undefined,
    )
    expect(withVerifyOutput).toHaveLength(1)

    const verifyOutput = withVerifyOutput[0][1].verifyOutput as string
    expect(verifyOutput).toContain('exit=killed')
    expect(verifyOutput).toContain('$ npm test')
    // gateOutcomes exitCode for a killed step is null.
    expect(verifyOutput).toContain('"exitCode": null')
  })
})
