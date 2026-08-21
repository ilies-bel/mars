/**
 * Coverage for `parkTaskForHuman` — the one park body, called by
 * `createDefaultManualPark` (and so by every `onManualPark` hook).
 *
 * Follow-up 2/3 of the HITL park-path unification (PRD
 * ae17340a-modular-core-program-make-every-mars-mod slice 27, task
 * `mars-18e6e0b5`) threaded `previewUrl`/`logPath` through `onManualPark` so a
 * park raises the richer action-queue payload the since-deleted sentinel-throw
 * fallback used to build. This pins that the payload actually lands on the
 * raised row.
 *
 * `raiseActionQueueItem` is mocked (rather than driven through a real DB)
 * because `parkTaskForHuman` fires it off without awaiting the result (it is
 * intentionally fire-and-forget — see the `.catch()` in `park-for-human.ts`),
 * so asserting on the row via a real store would be racy. Mocking captures
 * the call args synchronously, which is all this test needs.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockUpdateTask, mockGetTask, mockRaiseActionQueueItem } = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockGetTask: vi.fn().mockResolvedValue(null),
  mockRaiseActionQueueItem: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../queue', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../queue')>()
  return { ...original, updateTask: mockUpdateTask, getTask: mockGetTask }
})

vi.mock('../action-queue', () => ({
  raiseActionQueueItem: mockRaiseActionQueueItem,
}))

const { parkTaskForHuman } = await import('../park-for-human')

const makeStubStore = () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
  batch: vi.fn().mockResolvedValue([]),
})

describe('parkTaskForHuman: previewUrl/logPath on the promise-based variant', () => {
  beforeEach(() => {
    mockUpdateTask.mockClear()
    mockGetTask.mockClear().mockResolvedValue(null)
    mockRaiseActionQueueItem.mockClear()
  })

  it('raises an action-queue row whose payload carries previewUrl and logPath', async () => {
    await parkTaskForHuman('test-task-id', 'review', 'QA the preview', makeStubStore() as never, {
      raisedBy: 'primitive:manual-step',
      previewUrl: 'http://localhost:3000',
      logPath: '/fake/.mars/previews/preview.log',
    })

    expect(mockRaiseActionQueueItem).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'awaiting-human',
        originTaskId: 'test-task-id',
        payload: expect.objectContaining({
          situation: 'lease-park',
          previewUrl: 'http://localhost:3000',
          logPath: '/fake/.mars/previews/preview.log',
        }),
      }),
    )
  })

  it('omits previewUrl/logPath from the payload when not provided', async () => {
    await parkTaskForHuman('test-task-id', 'code', 'do the work', makeStubStore() as never, {
      raisedBy: 'primitive:manual-step',
    })

    expect(mockRaiseActionQueueItem).toHaveBeenCalledTimes(1)
    const call = mockRaiseActionQueueItem.mock.calls[0] as [{ payload: Record<string, unknown> }]
    expect(call[0].payload.previewUrl).toBeUndefined()
    expect(call[0].payload.logPath).toBeUndefined()
  })
})
