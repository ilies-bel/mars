// @vitest-environment happy-dom
/**
 * Tests for useTabTitleBadge.
 *
 * Verifies that the hook:
 *  - sets document.title to `<PageName> — mars` when count is 0
 *  - sets document.title to `(N) <PageName> — mars` when connected && count > 0
 *  - drops the `(N)` prefix when SSE is disconnected (connected = false)
 *  - reflects the current route in the page name
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { useTabTitleBadge } from './useTabTitleBadge'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Minimal component that invokes the hook under test. */
function Probe({ count, connected }: { count: number; connected: boolean }) {
  useTabTitleBadge(count, connected)
  return null
}

let container: HTMLElement
let root: ReturnType<typeof createRoot>

async function render(count: number, connected: boolean): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Probe, { count, connected }))
  })
}

async function rerender(count: number, connected: boolean): Promise<void> {
  await act(async () => {
    root.render(createElement(Probe, { count, connected }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  // Start at the triage page (the default landing)
  history.replaceState(null, '', '#/triage')
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  document.body.removeChild(container)
  history.replaceState(null, '', '#/')
  document.title = ''
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useTabTitleBadge', () => {
  it('sets plain page title when count is 0', async () => {
    await render(0, true)
    expect(document.title).toBe('Needs You — mars')
  })

  it('sets plain page title when disconnected even if count > 0', async () => {
    await render(3, false)
    expect(document.title).toBe('Needs You — mars')
  })

  it('prepends (N) when connected and count > 0', async () => {
    await render(5, true)
    expect(document.title).toBe('(5) Needs You — mars')
  })

  it('drops prefix when connected changes to false', async () => {
    await render(2, true)
    expect(document.title).toBe('(2) Needs You — mars')

    await rerender(2, false)
    expect(document.title).toBe('Needs You — mars')
  })

  it('updates count dynamically', async () => {
    await render(1, true)
    expect(document.title).toBe('(1) Needs You — mars')

    await rerender(7, true)
    expect(document.title).toBe('(7) Needs You — mars')
  })

  it('drops prefix when count returns to 0', async () => {
    await render(3, true)
    expect(document.title).toBe('(3) Needs You — mars')

    await rerender(0, true)
    expect(document.title).toBe('Needs You — mars')
  })

  it('reflects the progress route', async () => {
    history.replaceState(null, '', '#/progress')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await render(2, true)
    expect(document.title).toBe('(2) Progress — mars')
  })

  it('reflects the chat route', async () => {
    history.replaceState(null, '', '#/chat')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await render(1, true)
    expect(document.title).toBe('(1) Chat — mars')
  })
})
