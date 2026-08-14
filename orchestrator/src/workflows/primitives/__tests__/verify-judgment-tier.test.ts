// Unit tests for Phase 4B slice 3: verify-judgment full-review dispatch uses
// modelTier='flagship' so review reasoning always runs on the strongest model.
//
// Two assertions:
//   (a) review(ctx, { reviewType: 'full-review' }) calls runWorkerWithSpan with
//       modelTier='flagship'
//   (b) the step name and phase on that call are 'full-review' / 'verify'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetContextCacheForTests } from '../../../core/context'

const {
  mockRunWorkerWithSpan,
  mockSetReviewPacket,
  mockGetTask,
  mockUpdateTask,
} = vi.hoisted(() => ({
  mockRunWorkerWithSpan: vi.fn(),
  mockSetReviewPacket: vi.fn().mockResolvedValue(undefined),
  mockGetTask: vi.fn().mockResolvedValue(null),
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../core/lib/run-worker-with-span', () => ({
  runWorkerWithSpan: mockRunWorkerWithSpan,
  runNonLlmStepWithSpan: async <T>(opts: { fn: () => Promise<T> }) => opts.fn(),
}))

vi.mock('../../../core/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/queue')>()
  return { ...orig, updateTask: mockUpdateTask, getTask: mockGetTask }
})

vi.mock('../../../core/context', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/context')>()
  return {
    ...orig,
    resolveContext: () => ({
      repoRoot: '/tmp/test-repo',
      stateDir: '/tmp/test-repo/.mars',
      supervisorsManifest: [],
    }),
    getStateDir: () => '/tmp/test-repo/.mars',
    getRepoRoot: () => '/tmp/test-repo',
  }
})

vi.mock('../../../core/lib/origin', () => ({
  resolveOriginIdForTask: async (id: string) => id,
}))

vi.mock('../../../core/arc', () => ({
  Arc: { load: async () => ({ originId: null }) },
}))

vi.mock('../../../core/lib/trace-events-store', () => ({
  createTraceEventStore: () => ({
    record: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
  }),
}))

const { review } = await import('../index')

function buildCtx(taskId = 'test-task') {
  return {
    runId: taskId,
    currentStep: { name: 'review' },
    input: {
      prompt: 'test prompt',
      taskId,
      kind: 'task' as const,
      integrationBranch: 'main',
    },
    services: {
      store: {
        getTask: mockGetTask.mockResolvedValue({
          id: taskId,
          status: 'running',
          worktreePath: '/tmp/test-worktree',
          branch: 'task/test-task',
        }),
        updateTask: mockUpdateTask,
        setReviewPacket: mockSetReviewPacket,
        getWorktreeRef: vi.fn().mockResolvedValue({
          path: '/tmp/test-worktree',
          branch: 'task/test-task',
        }),
      },
      onPid: vi.fn(),
    },
    stash: new Map<string, unknown>([
      [`worktree:${taskId}`, { path: '/tmp/test-worktree', branch: 'task/test-task' }],
    ]),
  } as any
}

describe('review full-review: modelTier=flagship routing (Phase 4B slice 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetContextCacheForTests()
    // Default mock return: successful run with no parseable review output
    // (the fallback packet path is fine for tier-routing assertions).
    mockRunWorkerWithSpan.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      sessionId: 'test-session',
      conversation: [],
      quotaRejected: null,
    })
  })

  // ── (a) modelTier='flagship' on the full-review dispatch ─────────────────────

  it('(a) passes modelTier="flagship" to runWorkerWithSpan for the full-review step', async () => {
    const ctx = buildCtx()
    const worktree = { path: '/tmp/test-worktree', branch: 'task/test-task' }

    await review(ctx, { reviewType: 'full-review', worktree })

    expect(mockRunWorkerWithSpan).toHaveBeenCalledOnce()
    const callArgs = mockRunWorkerWithSpan.mock.calls[0]![0] as Record<string, unknown>
    expect(callArgs.modelTier).toBe('flagship')
  })

  // ── (b) step identity: stepName='full-review', phase='verify' ────────────────

  it('(b) full-review step dispatches with stepName="full-review" and phase="verify"', async () => {
    const ctx = buildCtx()
    const worktree = { path: '/tmp/test-worktree', branch: 'task/test-task' }

    await review(ctx, { reviewType: 'full-review', worktree })

    expect(mockRunWorkerWithSpan).toHaveBeenCalledOnce()
    const callArgs = mockRunWorkerWithSpan.mock.calls[0]![0] as Record<string, unknown>
    expect(callArgs.stepName).toBe('full-review')
    expect(callArgs.phase).toBe('verify')
  })
})
