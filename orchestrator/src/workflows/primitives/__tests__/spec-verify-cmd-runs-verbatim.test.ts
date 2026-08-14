/**
 * Acceptance tests — PRD 6bad3849 slice 2
 *
 * Verifies that the `review` primitive:
 *   1. Appends a `spec.verifyCmd` VerifyStepSpec (bash -o pipefail -c) to
 *      the `steps` arg of `verifyChanges` when `spec.verifyCmd` is non-empty.
 *   2. Records the failure in `verifyOutput` with the expected header format
 *      (`=== spec.verifyCmd (fail) ... exit=N ===`) when the step exits non-zero.
 *   3. Does NOT append any extra step when `spec.verifyCmd` is null, empty,
 *      or whitespace-only — leaving existing gate-registry behaviour unchanged.
 *   4. The `spec.verifyCmd` step counts as task-tier coverage, so a task with
 *      no registry gates but a non-null `spec.verifyCmd` does not produce a
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
// 1. Step assembly — spec.verifyCmd present
// ---------------------------------------------------------------------------

describe('spec.verifyCmd step appended when verifyCmd is non-empty', () => {
  it('passes a spec.verifyCmd VerifyStepSpec with bash -o pipefail to verifyChanges', async () => {
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
          name: 'spec.verifyCmd',
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
    const specStep = args.steps.find((s: { name: string }) => s.name === 'spec.verifyCmd')
    expect(specStep?.args).toEqual(['-o', 'pipefail', '-c', 'cd orchestrator && npm test'])
  })
})

// ---------------------------------------------------------------------------
// 2. Failure path — verifyOutput header format
// ---------------------------------------------------------------------------

describe('spec.verifyCmd failure recorded in verifyOutput', () => {
  it('verifyOutput contains the spec.verifyCmd fail header with exit code when step exits non-zero', async () => {
    const taskId = 'mars-specvcmd-fail01'
    const worktreePath = mkdtempSync(join(tmpdir(), 'mars-specvcmd-fail-wt-'))

    // stub verifyChanges to return a failing spec.verifyCmd step
    mockVerifyChanges.mockResolvedValue({
      passed: false,
      verdict: 'FAIL',
      steps: [
        {
          name: 'spec.verifyCmd',
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
    expect(verifyOutput).toContain('spec.verifyCmd')
    expect(verifyOutput).toContain('fail')
    expect(verifyOutput).toContain('exit=2')
  })
})

// ---------------------------------------------------------------------------
// 3. Step NOT appended when verifyCmd is absent or empty
// ---------------------------------------------------------------------------

describe('no spec.verifyCmd step when verifyCmd is null, empty, or whitespace', () => {
  it('does not append a spec.verifyCmd step when spec.verifyCmd is null', async () => {
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
    const hasSpecStep = args.steps.some((s: { name: string }) => s.name === 'spec.verifyCmd')
    expect(hasSpecStep).toBe(false)
  })

  it('does not append a spec.verifyCmd step when spec.verifyCmd is empty string', async () => {
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
    expect(args.steps.some((s: { name: string }) => s.name === 'spec.verifyCmd')).toBe(false)
  })

  it('does not append a spec.verifyCmd step when spec.verifyCmd is whitespace-only', async () => {
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
    expect(args.steps.some((s: { name: string }) => s.name === 'spec.verifyCmd')).toBe(false)
  })

  it('does not append a spec.verifyCmd step when spec is null', async () => {
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
    expect(args.steps.some((s: { name: string }) => s.name === 'spec.verifyCmd')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. Coverage — spec.verifyCmd counts as a task-tier gate
// ---------------------------------------------------------------------------

describe('spec.verifyCmd counts as task-tier gate coverage', () => {
  it('includes the spec.verifyCmd step in the steps arg even when no registry gates are configured', async () => {
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
    // The spec.verifyCmd step is present in steps — it counts as task-tier
    // coverage so verifyChanges will not produce a cant-verify:no-gate-coverage outcome.
    expect(args.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'spec.verifyCmd', tier: 'task' }),
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
    const specStep = args.steps.find((s: { name: string }) => s.name === 'spec.verifyCmd')
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
    const specStep = args.steps.find((s: { name: string }) => s.name === 'spec.verifyCmd')
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
