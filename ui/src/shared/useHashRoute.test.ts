// @vitest-environment happy-dom
/**
 * Regression tests for the initial-load hash redirect (task mars-599b93c3).
 *
 * Bug: App.tsx redirect effect called bare history.replaceState('#/chat'),
 * which does NOT fire a hashchange event.  useHashRoute's state stayed stale
 * at '#/' after the redirect.  A subsequent hashchange fired by any other
 * effect (e.g. useReleaseNotesAutoOpen, alertNotifier) caused useHashRoute to
 * re-read window.location.hash — which might have changed between the
 * replaceState call and the later event — and land on '#/progress' instead of
 * '#/chat'.
 *
 * Fix: the redirect effect now calls navigateReplace (replaceState + synthetic
 * hashchange dispatch) so useHashRoute state updates atomically with the URL.
 *
 * These tests verify:
 *   1. bare replaceState does NOT fire hashchange (documents the root cause)
 *   2. navigateReplace DOES fire hashchange so listeners see the new hash
 *   3. useHashRoute picks up the new hash when hashchange fires
 *   4. the redirect sequence: empty hash → #/chat, garbage hash → #/progress
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { useHashRoute } from './useHashRoute'
import { detectRoute, isKnownRoute } from './routing'

// ---------------------------------------------------------------------------
// Helpers (mirrors App.tsx internals)
// ---------------------------------------------------------------------------

/** Mirrors navigateReplace from App.tsx: replaceState + synthetic hashchange. */
const navigateReplace = (hash: string): void => {
  history.replaceState(null, '', hash)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

// ---------------------------------------------------------------------------
// 1 & 2. replaceState vs navigateReplace — hashchange behaviour
// ---------------------------------------------------------------------------

describe('replaceState vs navigateReplace — hashchange semantics', () => {
  afterEach(() => {
    history.replaceState(null, '', '#/')
  })

  it('bare history.replaceState does NOT fire hashchange', () => {
    const seen: string[] = []
    const listener = () => seen.push(window.location.hash)
    window.addEventListener('hashchange', listener)
    history.replaceState(null, '', '#/chat')
    window.removeEventListener('hashchange', listener)
    // No hashchange event → listener never called.
    expect(seen).toEqual([])
  })

  it('navigateReplace fires hashchange and the listener sees the new hash', () => {
    const seen: string[] = []
    const listener = () => seen.push(window.location.hash)
    window.addEventListener('hashchange', listener)
    navigateReplace('#/chat')
    window.removeEventListener('hashchange', listener)
    expect(seen).toEqual(['#/chat'])
  })
})

// ---------------------------------------------------------------------------
// 3 & 4. useHashRoute integration: hook state follows navigateReplace
// ---------------------------------------------------------------------------

describe('useHashRoute — initial-load redirect regression', () => {
  let container: HTMLElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    document.body.removeChild(container)
    history.replaceState(null, '', '#/')
  })

  it('empty hash → #/chat: hook reflects the redirect and route resolves to chat', async () => {
    // Arrange: simulate fresh browser load with empty hash.
    history.replaceState(null, '', '/')

    let captured = ''
    function Probe() {
      captured = useHashRoute()
      return null
    }

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(Probe, null))
    })

    // The initial rawHash is '#/' (useHashRoute fallback when hash is empty).
    // Simulate the redirect effect (the fix: navigateReplace, not bare replaceState).
    await act(async () => {
      const raw = window.location.hash || '#/'
      if (raw === '' || raw === '#' || raw === '#/') {
        navigateReplace('#/chat')
      }
    })

    expect(window.location.hash).toBe('#/chat')
    // The hook must have picked up the hashchange event.
    expect(captured).toBe('#/chat')
    expect(detectRoute(captured)).toBe('chat')
  })

  it('garbage hash → #/progress: hook reflects the redirect and route resolves to progress', async () => {
    // Arrange: a hash that matches no known route.
    history.replaceState(null, '', '#/not-a-real-route')

    let captured = ''
    function Probe() {
      captured = useHashRoute()
      return null
    }

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(Probe, null))
    })

    // Simulate the unknown-hash redirect branch.
    await act(async () => {
      if (!isKnownRoute(window.location.hash)) {
        navigateReplace('#/progress')
      }
    })

    expect(window.location.hash).toBe('#/progress')
    expect(captured).toBe('#/progress')
    expect(detectRoute(captured)).toBe('progress')
  })
})
