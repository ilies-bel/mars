/**
 * NavBar a11y tests.
 *
 * Strategy: mock the hook/context dependencies so NavBar renders under
 * `renderToStaticMarkup` (node environment, no providers needed).
 * We verify observable HTML behaviour — the badge count must be folded
 * into the link aria-label and the visual badge span must carry
 * aria-hidden so counts are not double-announced by screen readers.
 */

import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

// ---------------------------------------------------------------------------
// Module mocks — must be declared before the dynamic import of NavBar.
// Arrange for non-zero counts so the badge and aria-label code paths
// both execute.
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
  // 3 stale worktrees → actionCount=3 → Action queue link gets aria-label
  useStaleWorktrees: () => ({ staleWorktrees: [1, 2, 3] }),
}))

mock.module('@/shared/routing', () => ({
  detectRoute: () => 'progress',
  actionQueueCount: () => 3,
}))

mock.module('@/shared/notifications/notificationPrefs', () => ({
  notificationsSupported: () => false,
  notificationPermission: () => 'default',
  requestNotificationPermission: async () => 'default' as const,
  setNotificationsEnabled: () => {},
  useNotificationsEnabled: () => false,
}))

mock.module('@/widgets/ProjectSelector', () => ({
  ProjectSelector: () => null,
}))

const { NavBar } = await import('./NavBar')

const html = renderToStaticMarkup(<NavBar hash="#/progress" />)

// ---------------------------------------------------------------------------
// Badge reading-order tests
// ---------------------------------------------------------------------------

describe('NavBar – Progress badge reading order', () => {
  it('Progress link carries an aria-label that includes the task count', () => {
    // Ensures "Progress, 7 open tasks" is announced as one unit by AT
    expect(html).toContain('aria-label="Progress, 7 open tasks"')
  })

  it('Action queue link carries an aria-label that includes the action count', () => {
    expect(html).toContain('aria-label="Action queue, 3 items"')
  })
})

describe('NavBar – CountBadge aria-hidden', () => {
  it('visual badge carries aria-hidden="true" so the count is not double-announced', () => {
    // The badge span is absolutely-positioned beside the link; hiding it from AT
    // prevents "3 Action queue" being read as "3" then "Action queue" separately.
    expect(html).toContain('aria-hidden="true"')
  })
})
