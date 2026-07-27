import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

vi.mock('../../../core/lib/claude-stream', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/claude-stream')>()
  return { ...orig }
})

vi.mock('../../../core/lib/trace-events-store', () => ({
  createTraceEventStore: () => ({
    record: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
  }),
}))

vi.mock('../../../core/lib/git/worktree', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/worktree')>()
  return {
    ...orig,
    createWorktree: vi.fn().mockResolvedValue({
      path: '/tmp/test-worktree',
      branch: 'task/test-task',
    }),
  }
})

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
          worktree_path: '/tmp/test-worktree',
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

afterAll(() => {
  __resetContextCacheForTests()
})

describe('review primitive — full-review type', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('spawns a review agent and persists the ReviewPacket', async () => {
    const packet = {
      type: 'full-review',
      findings: [
        { category: 'correctness', severity: 'error', message: 'Bug in auth logic', file: 'src/auth.ts', line: 42 },
        { category: 'security', severity: 'warn', message: 'Potential XSS', file: 'src/render.ts', line: 10 },
      ],
      generatedAt: '2026-07-24T12:00:00.000Z',
    }
    const packetJson = JSON.stringify(packet)

    mockRunWorkerWithSpan.mockResolvedValue({
      exitCode: 0,
      stdout: packetJson,
      stderr: '',
      sessionId: 'test-session',
      conversation: [
        { type: 'result', result: packetJson },
      ],
      quotaRejected: null,
    })

    const ctx = buildCtx()
    const worktree = { path: '/tmp/test-worktree', branch: 'task/test-task' }
    const result = await review(ctx, { reviewType: 'full-review', worktree })

    expect(result).toEqual({ verified: true })
    expect(mockRunWorkerWithSpan).toHaveBeenCalledOnce()
    expect(mockSetReviewPacket).toHaveBeenCalledOnce()

    const [taskId, persisted] = mockSetReviewPacket.mock.calls[0]!
    expect(taskId).toBe('test-task')
    expect(persisted.type).toBe('full-review')
    expect(Array.isArray(persisted.findings)).toBe(true)
    expect(persisted.findings.length).toBeGreaterThanOrEqual(1)
  })

  it('falls back to a single-finding packet when agent output is unparsable', async () => {
    mockRunWorkerWithSpan.mockResolvedValue({
      exitCode: 0,
      stdout: 'not valid json at all',
      stderr: '',
      sessionId: 'test-session',
      conversation: [],
      quotaRejected: null,
    })

    const ctx = buildCtx()
    const worktree = { path: '/tmp/test-worktree', branch: 'task/test-task' }
    const result = await review(ctx, { reviewType: 'full-review', worktree })

    expect(result).toEqual({ verified: true })
    expect(mockSetReviewPacket).toHaveBeenCalledOnce()

    const [, persisted] = mockSetReviewPacket.mock.calls[0]!
    expect(persisted.type).toBe('full-review')
    expect(persisted.findings).toHaveLength(1)
    expect(persisted.findings[0].message).toContain('could not be parsed')
  })
})
