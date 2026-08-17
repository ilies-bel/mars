/**
 * LiveParkedChip tests.
 *
 * Tests three scenarios:
 *   1. count > 0 — chip is rendered and shows the count
 *   2. count === 0 — chip is hidden (renders nothing)
 *   3. filter click — chip href points to the awaiting-human filter URL
 *
 * Uses renderToStaticMarkup so tests run without a real DOM or browser.
 * useActionQueue is mocked so no QueryClient or daemon needed.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LiveParkedChip } from '@/widgets/LiveParkedChip'
import { AWAITING_HUMAN_HREF } from '@/pages/ActionQueuePageFilters'
import type { ActionQueueItem } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Mock useActionQueue — fully controls what the chip sees
// ---------------------------------------------------------------------------

vi.mock('@/entities/actionQueue/useActionQueue')
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
const mockUseActionQueue = vi.mocked(useActionQueue)

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const makeAwaitingItem = (id: string): ActionQueueItem =>
  ({
    id,
    kind: 'awaiting-human',
    entityId: `task-${id}`,
    priority: 'normal',
    title: 'Task parked at manual step',
    body: '',
    at: '2026-01-01T00:00:00Z',
    dag: null,
    errorKind: 'awaiting-human',
    actions: [],
    diagnosis: null,
  }) as ActionQueueItem

const defaultState = (items: ActionQueueItem[]) => ({
  items,
  error: null,
  projectsError: null,
  projectsEmpty: false,
})

const render = () => renderToStaticMarkup(<LiveParkedChip />)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LiveParkedChip — count > 0', () => {
  describe('with 1 awaiting-human item', () => {
    beforeEach(() => {
      mockUseActionQueue.mockReturnValue(defaultState([makeAwaitingItem('i1')]))
    })

    it('renders the chip', () => {
      expect(render()).toContain('live-parked-chip')
    })

    it('shows the count (1)', () => {
      expect(render()).toContain('1')
    })
  })

  describe('with 3 awaiting-human items', () => {
    beforeEach(() => {
      mockUseActionQueue.mockReturnValue(
        defaultState([makeAwaitingItem('i1'), makeAwaitingItem('i2'), makeAwaitingItem('i3')]),
      )
    })

    it('renders the chip', () => {
      expect(render()).toContain('live-parked-chip')
    })

    it('shows the count (3)', () => {
      expect(render()).toContain('3')
    })
  })
})

describe('LiveParkedChip — count === 0', () => {
  it('renders nothing when there are no items', () => {
    mockUseActionQueue.mockReturnValue(defaultState([]))
    expect(render()).toBe('')
  })

  it('renders nothing when items exist but none are awaiting-human', () => {
    mockUseActionQueue.mockReturnValue(
      defaultState([
        { ...makeAwaitingItem('x1'), kind: 'failed' } as ActionQueueItem,
        { ...makeAwaitingItem('x2'), kind: 'draft-proposal' } as ActionQueueItem,
      ]),
    )
    expect(render()).toBe('')
  })
})

describe('LiveParkedChip — filter click', () => {
  beforeEach(() => {
    mockUseActionQueue.mockReturnValue(defaultState([makeAwaitingItem('i1')]))
  })

  it('chip href points to the awaiting-human filter URL', () => {
    expect(render()).toContain(AWAITING_HUMAN_HREF)
  })
})
