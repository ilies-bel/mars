/**
 * Acceptance tests — PRD 6bad3849 slice 2
 *
 * Verifies that the `review` primitive:
 *   1. Appends a `spec-verify-cmd` VerifyStepSpec (bash -o pipefail -c) to
 *      the `steps` arg of `verifyChanges` when `spec-verify-cmd` is non-empty.
 *   2. Records the failure in `verifyOutput` with the expected header format
 *      (`=== spec-verify-cmd (fail) ... exit=N ===`) when the step exits non-zero.
 *   3. Does NOT append any extra step when `spec-verify-cmd` is null, empty,
 *      or whitespace-only — leaving existing gate-registry behaviour unchanged.
 *   4. The `spec-verify-cmd` step counts as task-tier coverage, so a task with
 *      no registry gates but a non-null `spec-verify-cmd` does not produce a
 *      `cant-verify:no-gate-coverage` outcome (verified by asserting that
 *      `steps` passed to `verifyChanges` includes the spec step).
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
  mockGetChangedFiles,
  mockLoadVerifyGates,
  mockAppendEnrichmentScopes,
  mockRecordEnrichmentShadowRuns,
  mockHandleTaskFailureWithFixTask,
} = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockVerifyChanges: vi.fn(),
  mockGetChangedFiles: vi.fn().mockResolvedValue([]),
  mockLoadVerifyGates: vi.fn().mockResolvedValue([]),
  mockAppendEnrichmentScopes: vi.fn(),
  mockRecordEnrichmentShadowRuns: vi.fn().mockResolvedValue(undefined),
  mockHandleTaskFailureWithFixTask: vi.fn().mockResolvedValue({ outcome: 'fix-task-spawned' }),
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
    getChangedFiles: mockGetChangedFiles,
  }
})

vi.mock('../../../core/lib/gate-enrichment', () => ({
  appendEnrichmentScopes: mockAppendEnrichmentScopes,
  recordEnrichmentShadowRuns: mockRecordEnrichmentShadowRuns,
}))

vi.mock('../../../core/verify-gates', () => ({
  loadVerifyGates: mockLoadVerifyGates,
}))

vi.mock('../../../core/queue-fix-tasks', () => ({
  handleTaskFailureWithFixTask: mockHandleTaskFailureWithFixTask,
}))

// Import the primitive AFTER vi.mock() calls so hoisting applies.
const { review } = await import('../index')

// ---------------------------------------------------------------------------
// Sandbox helpers
// ---------------------------------------------------------------------------

let tmpRepo: string

beforeAll(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), 'mars-spec-verify-cmd-'))
})

afterAll(() => {
  delete process.env.MARS_REPO
  __resetContextCacheForTests()
})

/** Minimal MarsCtx stub for the review primitive. */
const makeCtx = (taskId: string) =>
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

beforeEach(() => {
  process.env.MARS_REPO = tmpRepo
  __resetContextCacheForTests()

  mockUpdateTask.mockClear().mockResolvedValue(undefined)
  mockVerifyChanges.mockReset().mockResolvedValue({
    passed: true,
    verdict: 'PASS',
    steps: [],
  })
  mockGetChangedFiles.mockReset().mockResolvedValue([])
  mockLoadVerifyGates.mockReset().mockResolvedValue([])
  mockAppendEnrichmentScopes
    .mockReset()
    .mockImplementation((_store: unknown, scopes: unknown[]) => Promise.resolve(scopes))
  mockRecordEnrichmentShadowRuns.mockClear().mockResolvedValue(undefined)
  mockHandleTaskFailureWithFixTask.mockClear().mockResolvedValue({ outcome: 'fix-task-spawned' })
})

// ---------------------------------------------------------------------------
// 1. Step assembly — spec-verify-cmd present
// ---------------------------------------------------------------------------

describe('spec-verify-cmd step appended when verifyCmd is non-empty', () => {
  it('passes a spec-verify-cmd VerifyStepSpec with bash -o pipefail to verifyChanges', async () => {
    const taskId = 'mars-specvcmd-01'
    const worktreePath = mkdtempSync(join(tmpdir(), 'mars-specvcmd-wt-'))

    await expect(
      review(makeCtx(taskId), {
        kind: 'fix',
        worktree: { path: worktreePath, branch: `task/${taskId}` },
        spec: { verifyCmd: 'npm test', files: [], doneCriteria: [], mergeMode: 'auto' },
      }),
    ).resolves.toEqual({ verified: true })

    expect(mockVerifyChanges).toHaveBeenCalledOnce()
    const [args] = mockVerifyChanges.mock.calls[0]
    expect(args.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'spec-verify-cmd',
          required: true,
          tier: 'task',
          cmd: 'bash',
          args: ['-o', 'pipefail', '-c', 'npm test'],
        }),
      ]),
    )
  })

  it('trims leading/trailing whitespace from verifyCmd before building the step', async () => {
    const taskId = 'mars-specvcmd-02'
    const worktreePath = mkdtempSync(join(tmpdir(), 'mars-specvcmd-wt-'))

    await expect(
      review(makeCtx(taskId), {
        kind: 'fix',
        worktree: { path: worktreePath, branch: `task/${taskId}` },
        spec: { verifyCmd: '  cd orchestrator && npm test  ', files: [], doneCriteria: [], mergeMode: 'auto' },
      }),
    ).resolves.toEqual({ verified: true })

    const [args] = mockVerifyChanges.mock.calls[0]
    const specStep = args.steps.find((s: { name: string }) => s.name === 'spec-verify-cmd')
    expect(specStep?.args).toEqual(['-o', 'pipefail', '-c', 'cd orchestrator && npm test'])
  })
})

// ---------------------------------------------------------------------------
// 2. Failure path — verifyOutput header format
// ---------------------------------------------------------------------------

describe('spec-verify-cmd failure recorded in verifyOutput', () => {
  it('verifyOutput contains the spec-verify-cmd fail header with exit code when step exits non-zero', async () => {
    const taskId = 'mars-specvcmd-fail01'
    const worktreePath = mkdtempSync(join(tmpdir(), 'mars-specvcmd-fail-wt-'))

    // stub verifyChanges to return a failing spec-verify-cmd step
    mockVerifyChanges.mockResolvedValue({
      passed: false,
      verdict: 'FAIL',
      steps: [
        {
          name: 'spec-verify-cmd',
          passed: false,
          output: '3 suites failed',
          exitCode: 2,
          cmd: 'bash',
          args: ['-o', 'pipefail', '-c', 'npm test'],
          stepDir: worktreePath,
          tier: 'task' as const,
          duration: 1800,
        },
      ],
    })

    // Three-call updateTask trick to capture verifyOutput via outer catch:
    //   call 1: status=verifying  → resolves (normal path)
    //   call 2: status=failed     → rejects  (prevents _verifyFailedRecorded=true)
    //   call 3: outer catch       → resolves (carries verifyOutput)
    mockUpdateTask
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('simulated db failure'))
      .mockResolvedValue(undefined)

    await expect(
      review(makeCtx(taskId), {
        kind: 'fix',
        worktree: { path: worktreePath, branch: `task/${taskId}` },
        spec: { verifyCmd: 'npm test', files: [], doneCriteria: [], mergeMode: 'auto' },
      }),
    ).rejects.toThrow()

    const withVerifyOutput = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>).verifyOutput !== undefined,
    )
    expect(withVerifyOutput).toHaveLength(1)

    const verifyOutput = withVerifyOutput[0][1].verifyOutput as string
    expect(verifyOutput).toContain('spec-verify-cmd')
    expect(verifyOutput).toContain('fail')
    expect(verifyOutput).toContain('exit=2')
  })

  // Regression — mars-6c83978a: a timed-out spec-verify-cmd step must sign as
  // `verify:timeout/spec-verify-cmd`, not `verify:timeout/unknown` (the old
  // `spec.verifyCmd` step name failed STEP_ID_RE and fell back to the
  // `unknown` bucket) and not a generic `.../unclassified` (the timeout
  // marker living only on the step's `output` field, not `stdout`/`stderr`,
  // used to get lost before it reached computeFailureSignature).
  it('signs a timed-out spec-verify-cmd step as verify:timeout/spec-verify-cmd', async () => {
    const taskId = 'mars-specvcmd-timeout01'
    const worktreePath = mkdtempSync(join(tmpdir(), 'mars-specvcmd-timeout-wt-'))

    // Shape mirrors exactly what runVerifyStep (git/verify.ts) returns when
    // the per-step wall-clock timeout fires: `output` carries the
    // VERIFY_TIMEOUT_MARKER prefix, `stdout`/`stderr` stay unprefixed, and
    // `exitCode` is null (the child was killed, not exited on its own).
    mockVerifyChanges.mockResolvedValue({
      passed: false,
      verdict: 'FAIL',
      steps: [
        {
          name: 'spec-verify-cmd',
          passed: false,
          output: 'verify child timed out after 900000ms (exit null)\nsome partial output',
          exitCode: null,
          cmd: 'bash',
          args: ['-o', 'pipefail', '-c', 'npm test'],
          stdout: 'some partial output',
          stderr: '',
          stepDir: worktreePath,
          tier: 'task' as const,
          duration: 900000,
        },
      ],
    })

    mockUpdateTask
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('simulated db failure'))
      .mockResolvedValue(undefined)

    await expect(
      review(makeCtx(taskId), {
        kind: 'fix',
        worktree: { path: worktreePath, branch: `task/${taskId}` },
        spec: { verifyCmd: 'npm test', files: [], doneCriteria: [], mergeMode: 'auto' },
      }),
    ).rejects.toThrow()

    const failedCall = mockUpdateTask.mock.calls.find(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCall).toBeDefined()
    expect(failedCall![1]).toMatchObject({
      status: 'failed',
      failureReason: 'verify:spec-verify-cmd',
      failureSignature: 'verify:timeout/spec-verify-cmd',
      failureReasonCode: 'verify:timeout/spec-verify-cmd',
    })
  })
})

// ---------------------------------------------------------------------------
// 3. Step NOT appended when verifyCmd is absent or empty
// ---------------------------------------------------------------------------

describe('no spec-verify-cmd step when verifyCmd is null, empty, or whitespace', () => {
  it('does not append a spec-verify-cmd step when spec-verify-cmd is null', async () => {
    const taskId = 'mars-specvcmd-null01'
    const worktreePath = mkdtempSync(join(tmpdir(), 'mars-specvcmd-wt-'))

    await expect(
      review(makeCtx(taskId), {
        kind: 'fix',
        worktree: { path: worktreePath, branch: `task/${taskId}` },
        spec: { verifyCmd: null, files: [], doneCriteria: [], mergeMode: 'auto' },
      }),
    ).resolves.toEqual({ verified: true })

    const [args] = mockVerifyChanges.mock.calls[0]
    const hasSpecStep = args.steps.some((s: { name: string }) => s.name === 'spec-verify-cmd')
    expect(hasSpecStep).toBe(false)
  })

  it('does not append a spec-verify-cmd step when spec-verify-cmd is empty string', async () => {
    const taskId = 'mars-specvcmd-empty01'
    const worktreePath = mkdtempSync(join(tmpdir(), 'mars-specvcmd-wt-'))

    await expect(
      review(makeCtx(taskId), {
        kind: 'fix',
        worktree: { path: worktreePath, branch: `task/${taskId}` },
        spec: { verifyCmd: '', files: [], doneCriteria: [], mergeMode: 'auto' },
      }),
    ).resolves.toEqual({ verified: true })

    const [args] = mockVerifyChanges.mock.calls[0]
    expect(args.steps.some((s: { name: string }) => s.name === 'spec-verify-cmd')).toBe(false)
  })

  it('does not append a spec-verify-cmd step when spec-verify-cmd is whitespace-only', async () => {
    const taskId = 'mars-specvcmd-ws01'
    const worktreePath = mkdtempSync(join(tmpdir(), 'mars-specvcmd-wt-'))

    await expect(
      review(makeCtx(taskId), {
        kind: 'fix',
        worktree: { path: worktreePath, branch: `task/${taskId}` },
        spec: { verifyCmd: '   ', files: [], doneCriteria: [], mergeMode: 'auto' },
      }),
    ).resolves.toEqual({ verified: true })

    const [args] = mockVerifyChanges.mock.calls[0]
    expect(args.steps.some((s: { name: string }) => s.name === 'spec-verify-cmd')).toBe(false)
  })

  it('does not append a spec-verify-cmd step when spec is null', async () => {
    const taskId = 'mars-specvcmd-nospec01'
    const worktreePath = mkdtempSync(join(tmpdir(), 'mars-specvcmd-wt-'))

    await expect(
      review(makeCtx(taskId), {
        kind: 'fix',
        worktree: { path: worktreePath, branch: `task/${taskId}` },
        spec: null,
      }),
    ).resolves.toEqual({ verified: true })

    const [args] = mockVerifyChanges.mock.calls[0]
    expect(args.steps.some((s: { name: string }) => s.name === 'spec-verify-cmd')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. Coverage — spec-verify-cmd counts as a task-tier gate
// ---------------------------------------------------------------------------

describe('spec-verify-cmd counts as task-tier gate coverage', () => {
  it('includes the spec-verify-cmd step in the steps arg even when no registry gates are configured', async () => {
    const taskId = 'mars-specvcmd-cov01'
    const worktreePath = mkdtempSync(join(tmpdir(), 'mars-specvcmd-wt-'))

    // Simulate a task with changed files but no registry gates
    mockGetChangedFiles.mockResolvedValue(['src/foo.ts'])
    mockLoadVerifyGates.mockResolvedValue([])

    await expect(
      review(makeCtx(taskId), {
        kind: 'fix',
        worktree: { path: worktreePath, branch: `task/${taskId}` },
        spec: { verifyCmd: 'npm test', files: [], doneCriteria: [], mergeMode: 'auto' },
      }),
    ).resolves.toEqual({ verified: true })

    const [args] = mockVerifyChanges.mock.calls[0]
    // The spec-verify-cmd step is present in steps — it counts as task-tier
    // coverage so verifyChanges will not produce a cant-verify:no-gate-coverage outcome.
    expect(args.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'spec-verify-cmd', tier: 'task' }),
      ]),
    )
  })
})

// ---------------------------------------------------------------------------
// 5. Absolute-path translation — repoRoot → worktreePath
// ---------------------------------------------------------------------------

describe('absolute repo-root paths in verifyCmd are rewritten to the task worktree', () => {
  it('translates a repoRoot prefix in verifyCmd to the task worktreePath', async () => {
    const taskId = 'mars-specvcmd-abs01'
    const worktreePath = mkdtempSync(join(tmpdir(), 'mars-specvcmd-abs-wt-'))

    // verifyCmd contains an absolute path under MARS_REPO (tmpRepo)
    const verifyCmd = `(cd ${tmpRepo}/orchestrator && npm test)`
    await expect(
      review(makeCtx(taskId), {
        kind: 'fix',
        worktree: { path: worktreePath, branch: `task/${taskId}` },
        spec: { verifyCmd, files: [], doneCriteria: [], mergeMode: 'auto' },
      }),
    ).resolves.toEqual({ verified: true })

    const [args] = mockVerifyChanges.mock.calls[0]
    const specStep = args.steps.find((s: { name: string }) => s.name === 'spec-verify-cmd')
    // The absolute repoRoot prefix must be replaced with the worktreePath.
    expect(specStep?.args).toEqual([
      '-o',
      'pipefail',
      '-c',
      `(cd ${worktreePath}/orchestrator && npm test)`,
    ])
    // The original repoRoot must NOT appear in the translated command.
    expect(specStep?.args[3]).not.toContain(tmpRepo)
  })

  it('does not modify verifyCmd that contains no repoRoot prefix', async () => {
    const taskId = 'mars-specvcmd-abs02'
    const worktreePath = mkdtempSync(join(tmpdir(), 'mars-specvcmd-abs-wt-'))

    const verifyCmd = 'cd orchestrator && npm test'
    await expect(
      review(makeCtx(taskId), {
        kind: 'fix',
        worktree: { path: worktreePath, branch: `task/${taskId}` },
        spec: { verifyCmd, files: [], doneCriteria: [], mergeMode: 'auto' },
      }),
    ).resolves.toEqual({ verified: true })

    const [args] = mockVerifyChanges.mock.calls[0]
    const specStep = args.steps.find((s: { name: string }) => s.name === 'spec-verify-cmd')
    expect(specStep?.args[3]).toBe('cd orchestrator && npm test')
  })
})

// ---------------------------------------------------------------------------
// 6. Regression — verify cwd is the task worktree, not the repo root
// ---------------------------------------------------------------------------

describe('verify cwd is the task worktree (not the repo root)', () => {
  it('calls verifyChanges with cwd=worktreePath, not cwd=repoRoot', async () => {
    const taskId = 'mars-specvcmd-cwd01'
    const worktreePath = mkdtempSync(join(tmpdir(), 'mars-specvcmd-cwd-wt-'))

    await expect(
      review(makeCtx(taskId), {
        kind: 'fix',
        worktree: { path: worktreePath, branch: `task/${taskId}` },
        spec: { verifyCmd: 'npm test', files: [], doneCriteria: [], mergeMode: 'auto' },
      }),
    ).resolves.toEqual({ verified: true })

    expect(mockVerifyChanges).toHaveBeenCalledOnce()
    const [callArgs] = mockVerifyChanges.mock.calls[0]

    // cwd must be the per-task worktree path, not the repo root (tmpRepo).
    expect(callArgs.cwd).toBe(worktreePath)
    expect(callArgs.cwd).not.toBe(tmpRepo)
  })
})
