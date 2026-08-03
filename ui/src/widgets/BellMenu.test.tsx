// @vitest-environment happy-dom
/**
 * BellMenu badge tests.
 *
 * Slice 2 (ADR-0054) re-sources the Alerts half of the bell from the arc-rooted
 * `useAlerts()` aggregate. Conversation Notices stay out of the badge, while
 * each Alert still renders its goal + reason. Provider-free: the alert hook is
 * mocked, so the component renders under `renderToStaticMarkup`.
 */

import { describe, expect, it, mock, vi } from 'bun:test'

mock.module('@/entities/alerts', () => ({
  useAlerts: () => ({
    alerts: [
      {
        arcId: 'coverage:widgets',
        kind: 'verify-uncovered',
        goal: 'src/widgets',
        reason: "CAN'T-VERIFY: no task-tier verify gate covers the changed files",
      },
      { arcId: 'a2', goal: 'Tidy the worktree', reason: 'A leftover worktree is taking up space' },
    ],
    error: null,
  }),
  useStartThreadFromAlert: () => ({ mutate: vi.fn(), isPending: false }),
}))

const { renderToStaticMarkup } = await import('react-dom/server')
const { BellMenu } = await import('./BellMenu')

describe('BellMenu – badge count', () => {
  it('counts alerts without adding conversation Notices to the badge', () => {
    const html = renderToStaticMarkup(<BellMenu />)
    expect(html).toContain('aria-label="Bell, 2 items"')
    expect(html).toContain('>2<')
    expect(html).not.toContain('Notices')
  })
})
