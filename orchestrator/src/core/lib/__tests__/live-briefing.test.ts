import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoist mock factories so vi.mock() factory closures can reference them.
const mockGetTask = vi.hoisted(() => vi.fn())
const mockListAcceptance = vi.hoisted(() => vi.fn())
const mockListProgress = vi.hoisted(() => vi.fn())
const mockDeriveChecklist = vi.hoisted(() => vi.fn())

vi.mock('../../queue', () => ({
  getTask: mockGetTask,
}))

vi.mock('../../arc', () => ({
  Arc: {
    listAcceptance: mockListAcceptance,
    listProgress: mockListProgress,
    deriveChecklist: mockDeriveChecklist,
  },
}))

import { composeLiveBriefing, LiveBriefingError } from '../live-briefing'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PartialTask = {
  id?: string
  status?: string
  prompt?: string
  spec?: { doneCriteria: string[] }
  currentStepGuide?: string | null
}

const makeTask = (overrides: PartialTask = {}) => ({
  id: 'task-abc',
  status: 'awaiting-human',
  prompt: 'Do the work',
  spec: { doneCriteria: ['criterion A', 'criterion B'] },
  currentStepGuide: 'Follow these steps carefully',
  ...overrides,
})

const makeAcceptance = (position: number, text: string, met: boolean) => ({
  id: `acc-${position}`,
  taskId: 'task-abc',
  position,
  text,
  status: met ? 'met' : 'pending',
  note: null,
  updatedAt: 1000,
})

const makeNote = (id: string, body: string, createdAt = 1000) => ({
  id,
  taskId: 'task-abc',
  createdAt,
  author: 'agent',
  kind: 'note' as const,
  body,
  criterionIndex: null,
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('composeLiveBriefing', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockListAcceptance.mockResolvedValue([])
    mockListProgress.mockResolvedValue([])
    mockDeriveChecklist.mockReturnValue([])
  })

  describe('wrong-status rejection', () => {
    it('throws LiveBriefingError when task status is not awaiting-human', async () => {
      mockGetTask.mockResolvedValue(makeTask({ status: 'running' }))
      await expect(composeLiveBriefing('task-abc')).rejects.toBeInstanceOf(LiveBriefingError)
    })

    it('throws LiveBriefingError when task is not found', async () => {
      mockGetTask.mockResolvedValue(null)
      await expect(composeLiveBriefing('task-abc')).rejects.toBeInstanceOf(LiveBriefingError)
    })

    it('includes the actual status in the error', async () => {
      mockGetTask.mockResolvedValue(makeTask({ status: 'verifying' }))
      const err = await composeLiveBriefing('task-abc').catch(e => e)
      expect(err).toBeInstanceOf(LiveBriefingError)
      expect((err as LiveBriefingError).actualStatus).toBe('verifying')
      expect((err as LiveBriefingError).taskId).toBe('task-abc')
    })
  })

  describe('parked task with mixed check state', () => {
    it('contains all four sections in the correct order', async () => {
      mockGetTask.mockResolvedValue(makeTask())
      mockListAcceptance.mockResolvedValue([
        makeAcceptance(0, 'criterion A', true),
        makeAcceptance(1, 'criterion B', false),
      ])
      mockListProgress.mockResolvedValue([
        makeNote('n1', 'first note', 1000),
        makeNote('n2', 'second note', 2000),
      ])

      const briefing = await composeLiveBriefing('task-abc')

      const taskPos = briefing.indexOf('## Task')
      const criteriaPos = briefing.indexOf('## Done criteria')
      const stepPos = briefing.indexOf('## Step guide')
      const journalPos = briefing.indexOf('## Progress journal')

      expect(taskPos).toBeGreaterThanOrEqual(0)
      expect(taskPos).toBeLessThan(criteriaPos)
      expect(criteriaPos).toBeLessThan(stepPos)
      expect(stepPos).toBeLessThan(journalPos)
    })

    it('includes task id and prompt in the Task section', async () => {
      mockGetTask.mockResolvedValue(makeTask())
      mockListAcceptance.mockResolvedValue([makeAcceptance(0, 'criterion A', false)])

      const briefing = await composeLiveBriefing('task-abc')

      expect(briefing).toContain('task-abc')
      expect(briefing).toContain('Do the work')
    })

    it('renders [x] for met criteria and [ ] for pending criteria', async () => {
      mockGetTask.mockResolvedValue(makeTask())
      mockListAcceptance.mockResolvedValue([
        makeAcceptance(0, 'criterion A', true),
        makeAcceptance(1, 'criterion B', false),
      ])

      const briefing = await composeLiveBriefing('task-abc')

      expect(briefing).toContain('[x] criterion A')
      expect(briefing).toContain('[ ] criterion B')
    })

    it('includes the step guide body', async () => {
      mockGetTask.mockResolvedValue(makeTask())
      mockListAcceptance.mockResolvedValue([makeAcceptance(0, 'criterion A', false)])

      const briefing = await composeLiveBriefing('task-abc')

      expect(briefing).toContain('Follow these steps carefully')
    })

    it('outputs notes oldest-first (newest-last)', async () => {
      mockGetTask.mockResolvedValue(makeTask())
      mockListAcceptance.mockResolvedValue([makeAcceptance(0, 'criterion A', false)])
      mockListProgress.mockResolvedValue([
        makeNote('n1', 'older note', 1000),
        makeNote('n2', 'newer note', 2000),
      ])

      const briefing = await composeLiveBriefing('task-abc')

      expect(briefing.indexOf('older note')).toBeLessThan(briefing.indexOf('newer note'))
    })
  })

  describe('task with no progress notes', () => {
    it('shows (none) in the Progress journal section', async () => {
      mockGetTask.mockResolvedValue(makeTask())
      mockListAcceptance.mockResolvedValue([makeAcceptance(0, 'criterion A', false)])
      mockListProgress.mockResolvedValue([])

      const briefing = await composeLiveBriefing('task-abc')

      expect(briefing).toContain('## Progress journal')
      const journalStart = briefing.indexOf('## Progress journal')
      const journalBody = briefing.slice(journalStart)
      expect(journalBody).toContain('(none)')
    })

    it('still includes all other sections when there are no notes', async () => {
      mockGetTask.mockResolvedValue(makeTask())
      mockListAcceptance.mockResolvedValue([makeAcceptance(0, 'criterion A', true)])
      mockListProgress.mockResolvedValue([])

      const briefing = await composeLiveBriefing('task-abc')

      expect(briefing).toContain('## Task')
      expect(briefing).toContain('## Done criteria')
      expect(briefing).toContain('## Step guide')
      expect(briefing).toContain('## Progress journal')
    })
  })

  describe('legacy check path (no acceptance entries)', () => {
    it('falls back to deriveChecklist when listAcceptance returns empty', async () => {
      mockGetTask.mockResolvedValue(makeTask())
      mockListAcceptance.mockResolvedValue([])
      mockListProgress.mockResolvedValue([])
      mockDeriveChecklist.mockReturnValue([
        { criterion: 'criterion A', checked: true },
        { criterion: 'criterion B', checked: false },
      ])

      const briefing = await composeLiveBriefing('task-abc')

      expect(briefing).toContain('[x] criterion A')
      expect(briefing).toContain('[ ] criterion B')
    })
  })

  describe('step guide absent', () => {
    it('renders (none) when currentStepGuide is null', async () => {
      mockGetTask.mockResolvedValue(makeTask({ currentStepGuide: null }))
      mockListAcceptance.mockResolvedValue([makeAcceptance(0, 'criterion A', false)])

      const briefing = await composeLiveBriefing('task-abc')

      const stepStart = briefing.indexOf('## Step guide')
      const stepBody = briefing.slice(stepStart)
      expect(stepBody).toContain('(none)')
    })
  })
})
