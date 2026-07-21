// @vitest-environment happy-dom
/**
 * AlertCard interactive (DOM) tests.
 *
 * These tests exercise the click-driven snooze flow and verb-button invocation
 * using React's createRoot + happy-dom, complementing the SSR-only assertions
 * in AlertCard.test.tsx.
 *
 * Covered scenarios:
 *   - Clicking the Snooze trigger opens the preset menu
 *   - Selecting a preset calls snoozeActionQueueItem and dims the card
 *   - The Restore button calls restoreSnoozedItem and un-dims the card
 *   - Clicking a non-snooze verb button calls invokeAction
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { AlertCard } from './AlertCard'
import type { AlertCardProps } from './AlertCard'

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before imports resolve
// ---------------------------------------------------------------------------

const mockSnoozeActionQueueItem = vi.fn().mockResolvedValue(undefined)
const mockRestoreSnoozedItem = vi.fn().mockResolvedValue(undefined)
const mockInvokeAction = vi.fn().mockResolvedValue(undefined)

vi.mock('@/shared/api', () => ({
  snoozeActionQueueItem: (...args: unknown[]) => mockSnoozeActionQueueItem(...args),
  restoreSnoozedItem: (...args: unknown[]) => mockRestoreSnoozedItem(...args),
  invokeAction: (...args: unknown[]) => mockInvokeAction(...args),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_PROPS: AlertCardProps = {
  itemId: 'failed-task:t-1',
  entityId: 't-1',
  kind: 'failed-task',
  summary: 'The task ran out of retries and gave up',
  verbs: [
    { op: 'restart', label: 'Restart', style: 'primary' },
    { op: 'dismiss', label: 'Dismiss', style: 'destructive' },
    { op: 'snooze', label: 'Snooze', style: 'snooze' },
  ],
}

function renderCard(props: Partial<AlertCardProps> = {}): { container: HTMLElement; root: ReturnType<typeof createRoot> } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<AlertCard {...BASE_PROPS} {...props} />)
  })
  return { container, root }
}

afterEach(() => {
  // Clean up any containers left in the DOM
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Snooze flow
// ---------------------------------------------------------------------------

describe('AlertCard – snooze interaction flow', () => {
  it('clicking the Snooze trigger opens the preset menu', async () => {
    const { container } = renderCard()
    const trigger = container.querySelector('[data-testid="alert-card-snooze-trigger"]')
    expect(trigger).not.toBeNull()

    // Menu should not be visible initially
    expect(container.querySelector('[data-testid="snooze-menu"]')).toBeNull()

    // Click the trigger
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Menu should now be visible
    expect(container.querySelector('[data-testid="snooze-menu"]')).not.toBeNull()
  })

  it('selecting "1 hour" preset calls snoozeActionQueueItem with "1h"', async () => {
    const { container } = renderCard()
    const trigger = container.querySelector('[data-testid="alert-card-snooze-trigger"]')!

    // Open the menu
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const preset1h = container.querySelector('[data-testid="snooze-preset-1h"]')
    expect(preset1h).not.toBeNull()

    // Select the preset
    await act(async () => {
      preset1h!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mockSnoozeActionQueueItem).toHaveBeenCalledTimes(1)
    expect(mockSnoozeActionQueueItem).toHaveBeenCalledWith('failed-task:t-1', '1h')
  })

  it('after snooze succeeds the card renders in snoozed (dimmed) state', async () => {
    const { container } = renderCard()

    const trigger = container.querySelector('[data-testid="alert-card-snooze-trigger"]')!
    await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const preset4h = container.querySelector('[data-testid="snooze-preset-4h"]')!
    await act(async () => { preset4h.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    // The card should now be snoozed
    expect(container.querySelector('[data-testid="alert-card-snoozed"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="alert-card"]')).toBeNull()
  })

  it('clicking Restore calls restoreSnoozedItem and brings back the normal card', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const { container } = renderCard({ snoozeUntil: future })

    // Should start snoozed
    expect(container.querySelector('[data-testid="alert-card-snoozed"]')).not.toBeNull()

    const restoreBtn = container.querySelector('[data-testid="alert-card-restore"]')!
    await act(async () => {
      restoreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mockRestoreSnoozedItem).toHaveBeenCalledTimes(1)
    expect(mockRestoreSnoozedItem).toHaveBeenCalledWith('failed-task:t-1')

    // Normal card should now be visible
    expect(container.querySelector('[data-testid="alert-card"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="alert-card-snoozed"]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Verb button invocation
// ---------------------------------------------------------------------------

describe('AlertCard – verb button invocation', () => {
  it('clicking a primary verb button calls invokeAction with the op and entityId', async () => {
    const { container } = renderCard()

    const restartBtn = container.querySelector('[data-testid="alert-card-verb-restart"]')!
    expect(restartBtn).not.toBeNull()

    await act(async () => {
      restartBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mockInvokeAction).toHaveBeenCalledTimes(1)
    expect(mockInvokeAction).toHaveBeenCalledWith('restart', 't-1')
  })

  it('clicking a destructive verb button calls invokeAction with the dismiss op', async () => {
    const { container } = renderCard()

    const dismissBtn = container.querySelector('[data-testid="alert-card-verb-dismiss"]')!
    expect(dismissBtn).not.toBeNull()

    await act(async () => {
      dismissBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mockInvokeAction).toHaveBeenCalledWith('dismiss', 't-1')
  })

  it('after a verb action succeeds the resolution state is shown inline', async () => {
    const { container } = renderCard()

    const restartBtn = container.querySelector('[data-testid="alert-card-verb-restart"]')!
    await act(async () => {
      restartBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Resolution state shown inline
    const resolvedState = container.querySelector('[data-testid="alert-card-resolved-state"]')
    expect(resolvedState).not.toBeNull()
    expect(resolvedState!.textContent).toContain('restart')
  })
})
