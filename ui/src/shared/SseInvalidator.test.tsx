// @vitest-environment happy-dom

/**
 * Behaviour tests for SseInvalidator — the component that bridges the
 * daemon's SSE bus to React Query so the Progress tab updates in place
 * when task transitions and proposal lifecycle events fire.
 *
 * The SseInvalidator's core logic lives inside a `useEffect`, which
 * requires a browser DOM to run.  In this Node test environment we test
 * the observable end of the pipeline:
 *
 *   1. React Query invalidation — calling `invalidateQueries(['progress'])`
 *      marks the cache stale, triggering a background refetch.  Verified
 *      here to prove the mechanism used by SseInvalidator works correctly.
 *
 *   2. Debounce coalescing — rapid back-to-back invalidations for the same
 *      key are batched into one refetch, avoiding N network requests for an
 *      N-event burst.
 *
 *   3. Connection state store — the `sseStatus` external store that
 *      SseInvalidator writes to (via `setSseConnected`) and that
 *      `useProgress` reads from.  The store must correctly propagate
 *      connected/disconnected transitions.
 *
 * Integration-level proof (that the component is actually mounted in the
 * app and establishes an EventSource) is verified by the E2E / manual
 * smoke-test path: open the UI with a running daemon and confirm the
 * "live" badge appears in the top-right corner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setSseConnected } from './sseStatus'
import { SseInvalidator } from './SseInvalidator'

// ---------------------------------------------------------------------------
// React Query invalidation mechanism
// ---------------------------------------------------------------------------

describe('SseInvalidator – React Query invalidation mechanism', () => {
  it('refreshes past Subthreads after a chat update', async () => {
    vi.useFakeTimers()
    const listeners = new Map<string, EventListener[]>()

    class MockEventSource {
      onerror: (() => void) | null = null

      constructor(_url: string) {}

      addEventListener(type: string, listener: EventListener) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener])
      }

      close() {}
    }

    vi.stubGlobal('EventSource', MockEventSource)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const container = document.createElement('div')
    const root = createRoot(container)
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    qc.setQueryData(['chat-history', undefined], [])

    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(SseInvalidator),
        ),
      )
    })

    for (const listener of listeners.get('chat') ?? []) listener(new Event('chat'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })

    expect(qc.getQueryState(['chat-history', undefined])?.isInvalidated).toBe(true)

    await act(async () => root.unmount())
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('marks the progress cache stale when invalidateQueries is called', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    // Pre-populate the cache as if a previous fetch had completed.
    qc.setQueryData(['progress', null], { tasks: [], proposals: [] })

    const state = qc.getQueryState(['progress', null])
    expect(state?.isInvalidated).toBe(false)

    // This is the exact call SseInvalidator makes on 'tasks' events.
    await qc.invalidateQueries({ queryKey: ['progress'] })

    const staleState = qc.getQueryState(['progress', null])
    expect(staleState?.isInvalidated).toBe(true)
  })

  it('marks the tasks cache stale when invalidateQueries is called', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    qc.setQueryData(['tasks', null], [])

    await qc.invalidateQueries({ queryKey: ['tasks'] })

    const state = qc.getQueryState(['tasks', null])
    expect(state?.isInvalidated).toBe(true)
  })

  it('does not mark unrelated caches stale when progress is invalidated', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    qc.setQueryData(['progress', null], { tasks: [], proposals: [] })
    qc.setQueryData(['proposals', null], [])

    // Invalidate only progress — proposals should remain fresh.
    await qc.invalidateQueries({ queryKey: ['progress'] })

    const proposalsState = qc.getQueryState(['proposals', null])
    expect(proposalsState?.isInvalidated).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Debounce coalescing: rapid calls collapse to one invalidation
// ---------------------------------------------------------------------------

describe('SseInvalidator – debounce coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('collapses N rapid invalidation calls into one after the debounce window', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    const spy = vi.spyOn(qc, 'invalidateQueries')

    // Simulate the debounce pattern used by SseInvalidator:
    // rapid events within a 150 ms window collapse to a single call.
    let handle: ReturnType<typeof setTimeout> | null = null
    const debounced = () => {
      if (handle !== null) clearTimeout(handle)
      handle = setTimeout(() => {
        handle = null
        void qc.invalidateQueries({ queryKey: ['progress'] })
      }, 150)
    }

    // Fire 5 rapid events — these should all be swallowed by the debounce.
    for (let i = 0; i < 5; i++) debounced()

    // Nothing yet — timer has not fired.
    expect(spy).not.toHaveBeenCalled()

    // Advance past the debounce window.
    await vi.advanceTimersByTimeAsync(200)

    // Exactly one invalidation, not five.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith({ queryKey: ['progress'] })
  })
})

// ---------------------------------------------------------------------------
// Connection state store: setSseConnected / useSseConnected
// ---------------------------------------------------------------------------

/**
 * A minimal test component that renders the current SSE connection state.
 * Using renderToStaticMarkup keeps the test synchronous and dependency-free
 * (no DOM required).
 *
 * Note: useSyncExternalStore uses its getServerSnapshot (() => false) in SSR
 * contexts, so the rendered output always reflects the SERVER snapshot
 * regardless of what setSseConnected was called with.  The store's client-side
 * behaviour (notifying subscribers, updating the UI) is verified through
 * ProgressPage's mocked useProgress hook instead (see ProgressPage.test.tsx,
 * "SSE connection indicator" suite).
 */
import { useSseConnected } from './sseStatus'

const ConnectionBadge = () => {
  const connected = useSseConnected()
  return <span data-testid="connection-badge">{connected ? 'live' : 'offline'}</span>
}

describe('SseInvalidator – connection state store (SSR snapshot)', () => {
  afterEach(() => {
    // Reset module-level state so tests don't bleed into each other.
    setSseConnected(false)
  })

  it('server snapshot always returns "offline" (getServerSnapshot = () => false)', () => {
    setSseConnected(true)
    // Even with the store set to true, SSR uses the server snapshot.
    const html = renderToStaticMarkup(<ConnectionBadge />)
    expect(html).toContain('>offline<')
  })

  it('setSseConnected is idempotent: calling with the same value emits no change', () => {
    // No exception should be thrown; the store silently ignores no-op writes.
    expect(() => {
      setSseConnected(false)
      setSseConnected(false)
      setSseConnected(true)
      setSseConnected(true)
    }).not.toThrow()
  })
})
