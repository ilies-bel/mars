// @vitest-environment happy-dom
/**
 * BellMenu badge tests.
 *
 * Slice 2 (ADR-0054) re-sources the Alerts half of the bell from the arc-rooted
 * `useAlerts()` aggregate. The badge count is `alerts.length + notices.length`,
 * so this locks in that the two sources are summed (not one or the other) and
 * that each Alert renders its goal + reason. Provider-free: both data hooks are
 * mocked, so the component renders under `renderToStaticMarkup`.
 */

import { describe, expect, it, mock, vi } from 'bun:test'

mock.module('@/entities/alerts', () => ({
  useAlerts: () => ({
    alerts: [
      { arcId: 'a1', goal: 'Ship the widget', reason: 'The build never went green' },
      { arcId: 'a2', goal: 'Tidy the worktree', reason: 'A leftover worktree is taking up space' },
    ],
    error: null,
  }),
}))

mock.module('@/entities/notices', () => ({
  useNotices: () => ({
    notices: [{ id: 'n1', body: 'Release notes are ready' }],
    error: null,
    ack: vi.fn(),
    isPending: false,
  }),
}))

const { renderToStaticMarkup } = await import('react-dom/server')
const { BellMenu } = await import('./BellMenu')

describe('BellMenu – badge count', () => {
  it('sums alerts + notices into the badge and aria-label', () => {
    // 2 alerts + 1 notice → badge "3"
    const html = renderToStaticMarkup(<BellMenu />)
    expect(html).toContain('aria-label="Bell, 3 items"')
    expect(html).toContain('>3<')
  })
})
