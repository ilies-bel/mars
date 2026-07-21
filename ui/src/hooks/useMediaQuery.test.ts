// @vitest-environment happy-dom
/**
 * Behaviour tests for useMediaQuery.
 *
 * Strategy: mount a minimal component that calls the hook, assert on its
 * return value via a captured ref, then fire synthetic media-query change
 * events and assert the value updates.
 *
 * window.matchMedia is absent in happy-dom, so each test installs a minimal
 * implementation via Object.defineProperty before mounting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createElement, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { useMediaQuery } from './useMediaQuery'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// matchMedia mock helpers
// ---------------------------------------------------------------------------

type ChangeHandler = (e: { matches: boolean }) => void

interface MatchMediaMock {
  /** Fire a synthetic media-query change event to all registered listeners. */
  trigger: (newMatches: boolean) => void
  /** The spy wrapping window.matchMedia — use for assertion on call count etc. */
  spy: ReturnType<typeof vi.fn>
}

/**
 * Install a window.matchMedia mock that returns `initialMatches` and exposes
 * a `trigger` helper to simulate a viewport resize crossing the breakpoint.
 * Returns the mock object so tests can fire events.
 */
function setupMatchMedia(initialMatches: boolean): MatchMediaMock {
  let currentMatches = initialMatches
  const listeners: ChangeHandler[] = []

  const mql = {
    get matches() {
      return currentMatches
    },
    addEventListener: (_type: string, handler: ChangeHandler) => {
      listeners.push(handler)
    },
    removeEventListener: vi.fn(),
  }

  const spy = vi.fn(() => mql as unknown as MediaQueryList)
  Object.defineProperty(window, 'matchMedia', { value: spy, writable: true, configurable: true })

  return {
    trigger: (newMatches: boolean) => {
      currentMatches = newMatches
      for (const l of listeners) l({ matches: newMatches })
    },
    spy,
  }
}

// ---------------------------------------------------------------------------
// Test harness — component that exposes the hook's return value via a ref
// ---------------------------------------------------------------------------

/** Captured result, updated on each render of the test component. */
let captured: boolean | null = null

const TestComponent = ({ query }: { query: string }) => {
  const resultRef = useRef<boolean>(false)
  const result = useMediaQuery(query)
  resultRef.current = result
  captured = result
  return null
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  captured = null
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useMediaQuery', () => {
  it('returns true when the media query matches on mount', async () => {
    setupMatchMedia(true)
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(TestComponent, { query: '(min-width: 1280px)' }))
    })
    expect(captured).toBe(true)
  })

  it('returns false when the media query does not match on mount', async () => {
    setupMatchMedia(false)
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(TestComponent, { query: '(min-width: 1280px)' }))
    })
    expect(captured).toBe(false)
  })

  it('updates to true when a change event fires with matches: true', async () => {
    const { trigger } = setupMatchMedia(false)
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(TestComponent, { query: '(min-width: 1280px)' }))
    })
    expect(captured).toBe(false)

    await act(async () => {
      trigger(true)
    })
    expect(captured).toBe(true)
  })

  it('updates to false when a change event fires with matches: false', async () => {
    const { trigger } = setupMatchMedia(true)
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(TestComponent, { query: '(min-width: 1280px)' }))
    })
    expect(captured).toBe(true)

    await act(async () => {
      trigger(false)
    })
    expect(captured).toBe(false)
  })
})
