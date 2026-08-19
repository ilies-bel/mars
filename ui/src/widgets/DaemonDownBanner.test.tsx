// @vitest-environment happy-dom
/**
 * DaemonDownBanner renders only when Mars genuinely cannot answer, and names
 * the command that fixes it.
 */

import { vi, describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const mockHealth = vi.fn()
vi.mock('@/entities/daemon/useDaemonHealth', () => ({
  useDaemonHealth: () => mockHealth(),
}))

const { DaemonDownBanner } = await import('./DaemonDownBanner')

describe('DaemonDownBanner', () => {
  it('renders nothing while the daemon is live', () => {
    mockHealth.mockReturnValue({
      health: 'live',
      isDown: false,
      isUiServerUnreachable: false,
    })
    expect(renderToStaticMarkup(<DaemonDownBanner />)).toBe('')
  })

  it('renders nothing while health is still unknown', () => {
    // Loading must not flash a scary banner, and must not be treated as down.
    mockHealth.mockReturnValue({
      health: null,
      isDown: false,
      isUiServerUnreachable: false,
    })
    expect(renderToStaticMarkup(<DaemonDownBanner />)).toBe('')
  })

  it('names the daemon and the start command when the daemon is down', () => {
    mockHealth.mockReturnValue({
      health: 'down',
      isDown: true,
      isUiServerUnreachable: false,
    })
    const html = renderToStaticMarkup(<DaemonDownBanner />)
    expect(html).toContain("Can&#x27;t reach the Mars daemon")
    expect(html).toContain('mars daemon start')
    expect(html).toContain('role="alert"')
  })

  it('distinguishes the mars-ui server being down from the daemon', () => {
    mockHealth.mockReturnValue({
      health: null,
      isDown: false,
      isUiServerUnreachable: true,
    })
    const html = renderToStaticMarkup(<DaemonDownBanner />)
    expect(html).toContain('mars-ui server')
    // Telling someone to start the daemon when the UI server is the thing that
    // died sends them to the wrong process.
    expect(html).not.toContain('mars daemon start')
  })
})
