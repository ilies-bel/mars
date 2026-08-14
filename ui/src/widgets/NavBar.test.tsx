// @vitest-environment happy-dom
/**
 * NavBar a11y and interaction tests.
 *
 * Strategy: mock the hook/context dependencies so NavBar renders under
 * `renderToStaticMarkup` (no providers needed) for state checks.
 * DOM-based click tests use createRoot + act in the happy-dom environment.
 */

import { describe, expect, it, mock } from 'bun:test'
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

// Single render for the badge/a11y tests.
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
// Nav structure
// ---------------------------------------------------------------------------

describe('NavBar – link structure', () => {
  it('does not render Desktop notifications or Release notes', () => {
    expect(html).not.toContain('Desktop notifications')
    expect(html).not.toContain('Release notes')
  })
})
