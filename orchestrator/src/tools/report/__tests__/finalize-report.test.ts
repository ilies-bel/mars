/**
 * Unit tests for the finalizeReport primitive.
 *
 * Covers:
 *  (a) reportText provided and non-empty → persisted as exactly one task
 *      progress note, task reaches done.
 *  (b) reportText === null → throws (agent ran but produced no text), task
 *      does NOT reach done.
 *  (c) reportText === '' (empty string) → throws, task does NOT reach done.
 *  (d) reportText omitted (undefined) → legitimately empty audit, no note
 *      written, task reaches done.
 *  (e) appendProgress throws → error propagates, task does NOT reach done.
 */
import { describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that load the modules
// ---------------------------------------------------------------------------

const {
  mockRemoveWorktree,
  mockResolveWorktree,
  mockResolveTrace,
  mockUpdateTask,
  mockAppendProgress,
} = vi.hoisted(() => ({
  mockRemoveWorktree: vi.fn().mockResolvedValue(undefined),
  mockResolveWorktree: vi.fn().mockResolvedValue({
    path: '/tmp/worktree/test-task',
    branch: 'task/test-task',
  }),
  mockResolveTrace: vi.fn().mockResolvedValue({}),
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockAppendProgress: vi.fn().mockResolvedValue({
    id: 'prog-00000001',
    taskId: 'test-task',
    createdAt: Date.now(),
    author: 'orchestrator',
    kind: 'note' as const,
    body: '',
    criterionIndex: null,
  }),
}))

vi.mock('../../../core/ports/vcs/registry', () => ({
  resolveVcs: () => ({ removeWorktree: mockRemoveWorktree }),
}))

vi.mock('../../context', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../context')>()
  return {
    ...orig,
    resolveWorktree: mockResolveWorktree,
    resolveTrace: mockResolveTrace,
    resolveTaskId: (_ctx: unknown, override?: string) => override ?? 'test-task',
  }
})

vi.mock('../../../core/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/queue')>()
  return { ...orig, updateTask: mockUpdateTask }
})

vi.mock('../../../core/arc', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/arc')>()
  return {
    ...orig,
    Arc: {
      ...(orig as unknown as { Arc: Record<string, unknown> }).Arc,
      appendProgress: mockAppendProgress,
    },
  }
})

// ---------------------------------------------------------------------------
// Import under test — after mocks are hoisted
// ---------------------------------------------------------------------------

import { finalizeReport } from '../finalize-report'
import type { MarsCtx } from '../../context'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal ctx that satisfies finalizeReport's seams. */
const makeCtx = (): MarsCtx =>
  ({
    runId: 'test-task',
    input: { taskId: 'test-task' },
    services: { store: {} },
    currentStep: null,
    signal: { aborted: false } as AbortSignal,
    emit: vi.fn(),
    step: vi.fn(),
  }) as unknown as MarsCtx

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('finalizeReport', () => {
  it('(a) non-empty reportText: persists exactly one note and marks done', async () => {
    mockAppendProgress.mockClear()
    mockUpdateTask.mockClear()

    const ctx = makeCtx()
    const result = await finalizeReport(ctx, { reportText: 'Agent findings here.' })

    // One appendProgress call with the right shape
    expect(mockAppendProgress).toHaveBeenCalledTimes(1)
    expect(mockAppendProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'test-task',
        author: 'orchestrator',
        kind: 'note',
        body: 'Agent findings here.',
      }),
      expect.anything(),
    )

    // Task was marked done
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'test-task',
      { status: 'done', failedPhase: null },
      expect.anything(),
    )

    expect(result).toMatchObject({ taskId: 'test-task', success: true })
  })

  it('(b) reportText === null: throws, task does NOT reach done', async () => {
    mockAppendProgress.mockClear()
    mockUpdateTask.mockClear()

    const ctx = makeCtx()
    await expect(finalizeReport(ctx, { reportText: null })).rejects.toThrow(
      /reportText was provided but is empty/,
    )

    expect(mockAppendProgress).not.toHaveBeenCalled()
    expect(mockUpdateTask).not.toHaveBeenCalled()
  })

  it('(c) reportText === empty string: throws, task does NOT reach done', async () => {
    mockAppendProgress.mockClear()
    mockUpdateTask.mockClear()

    const ctx = makeCtx()
    await expect(finalizeReport(ctx, { reportText: '   ' })).rejects.toThrow(
      /reportText was provided but is empty/,
    )

    expect(mockAppendProgress).not.toHaveBeenCalled()
    expect(mockUpdateTask).not.toHaveBeenCalled()
  })

  it('(d) reportText omitted (undefined): legitimately empty audit, no note, task reaches done', async () => {
    mockAppendProgress.mockClear()
    mockUpdateTask.mockClear()

    const ctx = makeCtx()
    const result = await finalizeReport(ctx)

    expect(mockAppendProgress).not.toHaveBeenCalled()
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'test-task',
      { status: 'done', failedPhase: null },
      expect.anything(),
    )
    expect(result).toMatchObject({ taskId: 'test-task', success: true })
  })

  it('(e) appendProgress throws: error propagates, done is never written', async () => {
    mockAppendProgress.mockRejectedValueOnce(new Error('DB write failed'))
    mockUpdateTask.mockClear()

    const ctx = makeCtx()
    await expect(
      finalizeReport(ctx, { reportText: 'Some findings.' }),
    ).rejects.toThrow('DB write failed')

    expect(mockUpdateTask).not.toHaveBeenCalled()
  })
})
