// @vitest-environment happy-dom
/**
 * BellMenu tests.
 *
 * The bell is now a plain pull surface — no badge count. Clicking it opens a
 * popover listing alerts (goal + reason). Provider-free: the alert hook is
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

describe('BellMenu – plain bell icon', () => {
  it('renders the bell trigger without a numeric badge', () => {
    const html = renderToStaticMarkup(<BellMenu />)
    // No numeric badge span — the count is intentionally gone
    expect(html).not.toContain('>2<')
    expect(html).not.toContain('>9+<')
    // aria-label is always plain 'Bell', never "Bell, N items"
    expect(html).toContain('aria-label="Bell"')
  })

  it('does not expose Notices in the badge (still no badge)', () => {
    const html = renderToStaticMarkup(<BellMenu />)
    expect(html).not.toContain('Notices')
  })
})
