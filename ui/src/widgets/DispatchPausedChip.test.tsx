/**
 * The chip exists so a pause is visible from every route, not only from
 * Control Room — the one page an operator opens *after* they already suspect
 * something is wrong. It must render nothing when dispatch is running, so the
 * shell pays no permanent vertical cost for it.
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DispatchPauseState } from '@/shared/api'

let dispatchState: DispatchPauseState

mock.module('@/entities/operator/useDispatchState', () => ({
  useDispatchState: () => dispatchState,
  pauseReasonLabel: (s: DispatchPauseState) =>
    s.reason === 'storm' ? 'signature storm' : 'paused',
}))

const { DispatchPausedChip } = await import('./DispatchPausedChip')

beforeEach(() => {
  dispatchState = { paused: false, reason: null, since: null, detail: null }
})

describe('DispatchPausedChip', () => {
  it('renders nothing while dispatch is running', () => {
    expect(renderToStaticMarkup(<DispatchPausedChip />)).toBe('')
  })

  it('names the pause reason and links to Control Room', () => {
    dispatchState = {
      paused: true,
      reason: 'storm',
      since: '2026-08-19T10:00:00.000Z',
      detail: 'signature storm: code:context-exhausted/unclassified x3',
    }
    const html = renderToStaticMarkup(<DispatchPausedChip />)
    expect(html).toContain('paused')
    expect(html).toContain('signature storm')
    expect(html).toContain('#/control')
    expect(html).toContain('no new work is being dispatched')
  })
})
