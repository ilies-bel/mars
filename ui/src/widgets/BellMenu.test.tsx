// @vitest-environment happy-dom
/**
 * BellMenu tests.
 *
 * The bell now carries a single ranked list of all open action-queue items
 * (Alerts and Notices together) from useActionQueue. Tests cover:
 *   - Badge count rendering (renderToStaticMarkup, initial closed state)
 *   - Popover heading "Needs You"
 *   - Notice Acknowledge button present
 *   - Alert Acknowledge button absent
 *   - Open-into-conversation button on resolvable alert items
 *   - Empty-state "Nothing needs you"
 *
 * Popover-content tests use createRoot + act (happy-dom environment) to open
 * the popover via a simulated click before asserting on the DOM.
 */

import { afterEach, describe, expect, it, mock, vi } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

// ---------------------------------------------------------------------------
// Fixtures — one notice-class item, one alert-class item with a resolvable task
// ---------------------------------------------------------------------------

const NOTICE_FIXTURE = {
  id: 'notice-1',
  kind: 'spend-control-notice',
  entityId: 'entity-1',
  priority: 'normal' as const,
  title: 'Budget notice',
  body: 'Spend limit approaching',
  at: '2024-01-01T10:00:00Z',
  dag: null,
  errorKind: 'spend-control-notice',
  actions: [],
  recoveryExhausted: false,
  humanSummary: 'Budget notice',
  verbs: [],
  decisions: [],
  noticeKey: 'spend-control:entity-1',
}

// dag non-null → hasResolvableTask returns true for this item.
const ALERT_FIXTURE = {
  id: 'alert-1',
  kind: 'failed' as const,
  entityId: 'task-1',
  priority: 'high' as const,
  title: 'Task failed',
  body: 'The task failed for some reason',
  at: '2024-01-01T09:00:00Z',
  dag: { blockers: [], blocking: [], descendants: [], proposalId: null, edges: [] },
  errorKind: 'failed',
  actions: [],
  recoveryExhausted: false,
  humanSummary: 'Task failed',
  verbs: [],
  decisions: [],
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Mutable store so individual tests can override the item list. The factory
// closure captures a reference, so reassigning mockItems before rendering
// changes what useActionQueue() returns without rebuilding the module mock.
let mockItems: unknown[] = [NOTICE_FIXTURE, ALERT_FIXTURE]

mock.module('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: () => ({
    items: mockItems,
    error: null,
    projectsError: null,
    projectsEmpty: false,
  }),
}))

// useCounts is the single source of truth for the badge number.
let mockNeedsYou = 1
mock.module('@/entities/counts/useCounts', () => ({
  useCounts: () => ({
    needsYou: mockNeedsYou,
    running: 0, verifying: 0, merging: 0,
    queued: 0, blocked: 0, failed: 0, doneToday: 0,
    proposals: { draft: 0, total: 0 },
    known: true,
  }),
}))

mock.module('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

mock.module('@/shared/api', () => ({
  dismissActionQueueItem: vi.fn().mockResolvedValue(undefined),
}))

mock.module('@/entities/alerts/api', () => ({
  startThreadFromAlert: vi.fn().mockResolvedValue({ threadId: 'thread-1' }),
}))

// Dynamic imports run after all mocks are registered.
const { renderToStaticMarkup } = await import('react-dom/server')
const { BellMenu } = await import('./BellMenu')

// ---------------------------------------------------------------------------
// Reset mutable mock state between tests
// ---------------------------------------------------------------------------

afterEach(() => {
  mockItems = [NOTICE_FIXTURE, ALERT_FIXTURE]
})

// ---------------------------------------------------------------------------
// Helpers for DOM-based (popover-open) tests
// ---------------------------------------------------------------------------

/** Mount BellMenu in the real DOM and open the popover. */
const mountAndOpen = async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(<BellMenu />)
  })

  const bellButton = container.querySelector('button[aria-label="Bell"]')!
  await act(async () => {
    bellButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })

  return { root, container }
}

/** Unmount and remove the container from the document. */
const teardown = async (root: ReturnType<typeof createRoot>, container: HTMLElement) => {
  await act(async () => {
    root.unmount()
  })
  document.body.removeChild(container)
}

// ---------------------------------------------------------------------------
// Tests: badge (initial closed state, readable from renderToStaticMarkup)
// ---------------------------------------------------------------------------

// The badge reads useCounts().needsYou — the server-side population figure —
// rather than recounting the fetched page, so that the bell, the sidebar and
// the Needs You header can never disagree. These tests drive that source.
describe('BellMenu – badge', () => {
  it('renders the needsYou count on the bell button', () => {
    mockNeedsYou = 2
    const html = renderToStaticMarkup(<BellMenu />)
    expect(html).toContain('>2<')
    expect(html).toContain('2 items need attention')
  })

  it('hides the badge when the count is zero', () => {
    mockNeedsYou = 0
    const html = renderToStaticMarkup(<BellMenu />)
    expect(html).not.toContain('items need attention')
    mockNeedsYou = 1
  })

  it('caps badge at 99+ when count exceeds 99', () => {
    mockNeedsYou = 100
    const html = renderToStaticMarkup(<BellMenu />)
    expect(html).toContain('99+')
    expect(html).toContain('99+ items need attention')
    mockNeedsYou = 1
  })
})

// ---------------------------------------------------------------------------
// Tests: popover content (DOM interaction via createRoot + act)
// ---------------------------------------------------------------------------

describe('BellMenu – popover content', () => {
  it('shows heading "Needs You" (not "Alerts")', async () => {
    const { root, container } = await mountAndOpen()
    try {
      expect(container.innerHTML).toContain('Needs You')
      expect(container.innerHTML).not.toContain('>Alerts<')
    } finally {
      await teardown(root, container)
    }
  })

  it('shows an Acknowledge button for notice-class items', async () => {
    const { root, container } = await mountAndOpen()
    try {
      const buttons = Array.from(container.querySelectorAll('button'))
      const ackButtons = buttons.filter((btn) => btn.textContent?.trim() === 'Acknowledge')
      // NOTICE_FIXTURE is a notice kind → gets one Acknowledge button
      expect(ackButtons.length).toBe(1)
    } finally {
      await teardown(root, container)
    }
  })

  it('does not show an Acknowledge button for alert-class items', async () => {
    const { root, container } = await mountAndOpen()
    try {
      const buttons = Array.from(container.querySelectorAll('button'))
      const ackButtons = buttons.filter((btn) => btn.textContent?.trim() === 'Acknowledge')
      // Only 1 notice item → exactly 1 ack button; ALERT_FIXTURE has no ack button
      expect(ackButtons.length).toBe(1)
    } finally {
      await teardown(root, container)
    }
  })

  it('shows an open-into-conversation button for resolvable alert items', async () => {
    const { root, container } = await mountAndOpen()
    try {
      const buttons = Array.from(container.querySelectorAll('button'))
      const discussButtons = buttons.filter((btn) => btn.textContent?.trim() === 'Discuss')
      // ALERT_FIXTURE has dag non-null → hasResolvableTask = true → shows Discuss
      expect(discussButtons.length).toBe(1)
    } finally {
      await teardown(root, container)
    }
  })

  it('shows "Nothing needs you" when there are no items', async () => {
    mockItems = []
    const { root, container } = await mountAndOpen()
    try {
      expect(container.innerHTML).toContain('Nothing needs you')
    } finally {
      await teardown(root, container)
    }
  })
})
