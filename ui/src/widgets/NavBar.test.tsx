// @vitest-environment happy-dom
/**
 * NavBar a11y and interaction tests.
 *
 * Strategy: mock the hook/context dependencies so NavBar renders under
 * `renderToStaticMarkup` (no providers needed) for state checks.
 * DOM-based click tests use createRoot + act in the happy-dom environment.
 *
 * The `useNotificationsPreference` mock is a vi.fn() so each test can call
 * `.mockReturnValue()` to control the enabled/disabled state independently.
 */

import { describe, expect, it, mock, vi } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'

// ---------------------------------------------------------------------------
// Module mocks — must be declared before the dynamic imports of NavBar.
// Arrange for non-zero counts so the badge and aria-label code paths execute.
// ---------------------------------------------------------------------------

mock.module('@/hooks/useProgress', () => ({
  useProgress: () => ({
    // 7 tasks → progressCount=7 → Progress link gets aria-label
    tasks: new Array(7).fill({ id: 't' }),
    byCluster: {},
    proposals: [],
    aggregates: { doneToday: 0, failedOpen: 0 },
    error: null,
    connected: true,
  }),
}))

mock.module('@/entities/stale-worktrees/useStaleWorktrees', () => ({
  // 3 stale worktrees → actionCount=3 → Chat link gets aria-label
  useStaleWorktrees: () => ({ staleWorktrees: [1, 2, 3] }),
}))

mock.module('@/shared/routing', () => ({
  detectRoute: () => 'progress',
  // NavBar reads resolvePageRoute (overlay-aware). Real overlay behaviour is
  // asserted in routing.test.ts, where the function is not mocked.
  resolvePageRoute: () => 'progress',
  actionQueueCount: () => 3,
}))

// useNotificationsPreference is a vi.fn() so each test can call mockReturnValue
// to exercise the enabled and disabled rendering paths independently.
mock.module('@/entities/notifications', () => ({
  useNotificationsPreference: vi.fn(() => ({
    enabled: false,
    setEnabled: vi.fn(),
    isPending: false,
  })),
}))

mock.module('@/widgets/ProjectSelector', () => ({
  ProjectSelector: () => null,
}))

// BellMenu's data hooks — mocked so NavBar renders provider-free (no
// QueryClientProvider). Empty lists keep the bell badge absent in these tests.
mock.module('@/entities/alerts', () => ({
  useAlerts: () => ({ alerts: [], error: null }),
  useStartThreadFromAlert: () => ({ mutate: vi.fn(), isPending: false }),
}))


// Dynamic imports run after all mocks are registered.
const { NavBar } = await import('./NavBar')
const { useNotificationsPreference } = await import('@/entities/notifications')

// Type-cast to vi.fn so we can call mockReturnValue per test.
const mockUseNotificationsPreference = useNotificationsPreference as ReturnType<typeof vi.fn>

// Single render for the badge/a11y tests (default mock state: enabled=false).
const html = renderToStaticMarkup(<NavBar hash="#/progress" />)

// ---------------------------------------------------------------------------
// Badge reading-order tests
// ---------------------------------------------------------------------------

describe('NavBar – Progress badge reading order', () => {
  it('Progress link carries an aria-label that includes the task count', () => {
    // Ensures "Progress, 7 open tasks" is announced as one unit by AT
    expect(html).toContain('aria-label="Progress, 7 open tasks"')
  })

  it('Chat link carries an aria-label that includes the action count', () => {
    expect(html).toContain('aria-label="Chat, 3 items"')
  })
})

describe('NavBar – CountBadge aria-hidden', () => {
  it('visual badge carries aria-hidden="true" so the count is not double-announced', () => {
    // The badge span is absolutely-positioned beside the link; hiding it from AT
    // prevents "3 Chat" being read as "3" then "Chat" separately.
    expect(html).toContain('aria-hidden="true"')
  })
})

// ---------------------------------------------------------------------------
// Desktop notifications toggle – render state
// ---------------------------------------------------------------------------

describe('NavBar – Desktop notifications toggle rendering', () => {
  it('always renders the "Desktop notifications" label', () => {
    expect(html).toContain('Desktop notifications')
  })

  it('renders aria-pressed="false" when the hook returns enabled=false', () => {
    mockUseNotificationsPreference.mockReturnValue({
      enabled: false,
      setEnabled: vi.fn(),
      isPending: false,
    })
    const h = renderToStaticMarkup(<NavBar hash="#/" />)
    expect(h).toContain('Desktop notifications')
    expect(h).toContain('aria-pressed="false"')
  })

  it('renders aria-pressed="true" when the hook returns enabled=true', () => {
    mockUseNotificationsPreference.mockReturnValue({
      enabled: true,
      setEnabled: vi.fn(),
      isPending: false,
    })
    const h = renderToStaticMarkup(<NavBar hash="#/" />)
    expect(h).toContain('Desktop notifications')
    expect(h).toContain('aria-pressed="true"')
  })
})

// ---------------------------------------------------------------------------
// Desktop notifications toggle – click interaction
//
// These tests mount the NavBar into a real DOM (provided by happy-dom) and
// simulate a click event to verify the toggle calls the mutator from the hook
// with the expected !enabled argument.
// ---------------------------------------------------------------------------

describe('NavBar – Desktop notifications toggle click', () => {
  it('calls setEnabled(false) when the button is clicked while enabled=true', async () => {
    const mockSetEnabled = vi.fn()
    mockUseNotificationsPreference.mockReturnValue({
      enabled: true,
      setEnabled: mockSetEnabled,
      isPending: false,
    })

    const div = document.createElement('div')
    document.body.appendChild(div)
    const root = createRoot(div)

    await act(async () => {
      root.render(<NavBar hash="#/" />)
    })

    const btn = div.querySelector('button[aria-pressed="true"]')
    expect(btn).toBeTruthy()

    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mockSetEnabled).toHaveBeenCalledWith(false)

    await act(async () => { root.unmount() })
    document.body.removeChild(div)
  })

  it('calls setEnabled(true) when the button is clicked while enabled=false', async () => {
    const mockSetEnabled = vi.fn()
    mockUseNotificationsPreference.mockReturnValue({
      enabled: false,
      setEnabled: mockSetEnabled,
      isPending: false,
    })

    const div = document.createElement('div')
    document.body.appendChild(div)
    const root = createRoot(div)

    await act(async () => {
      root.render(<NavBar hash="#/" />)
    })

    const btn = div.querySelector('button[aria-pressed="false"]')
    expect(btn).toBeTruthy()

    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mockSetEnabled).toHaveBeenCalledWith(true)

    await act(async () => { root.unmount() })
    document.body.removeChild(div)
  })
})
