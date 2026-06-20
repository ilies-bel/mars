/**
 * Unit tests for useRead / RemoteState.
 *
 * `useQuery` is mocked so we can drive the full RemoteState state machine
 * without a QueryClient provider or a real network. The probe component
 * below demonstrates the correct consumer pattern for the `stale` arm
 * (render children + ReconnectingStrip) as specified by the "keep data +
 * quiet strip" requirement.
 *
 * Tests run under vitest (`npm run test:src`).
 */

import { vi, describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError } from '@/shared/api'

// Mock useQuery so RemoteState can be driven without a QueryClient provider.
// vi.mock is hoisted by vitest's transform to run before any imports resolve.
vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(),
}))

import { useQuery } from '@tanstack/react-query'
import { useRead, type RemoteState } from './useRead'
import { ReconnectingStrip } from '@/components/ReconnectingStrip'

// Cast to any-returning mock so mockReturnValue works without strict typing.
const mockUseQuery = vi.mocked(useQuery as () => unknown)

afterEach(() => {
  vi.resetAllMocks()
})

// ---------------------------------------------------------------------------
// Minimal probe component — the canonical consumer pattern for all four arms.
// A real consumer would render actual data widgets; here we emit testable attrs.
// ---------------------------------------------------------------------------

function Probe({ of: label }: { of: string }) {
  const state: RemoteState<{ value: number }> = useRead(
    ['probe'],
    async () => ({ value: 42 }),
    { of: label },
  )
  switch (state.kind) {
    case 'loading':
      return <div data-testid="loading" />
    case 'error':
      // Full-pane takeover — correct for initial load failure with no data.
      return <div data-testid="error-pane">{state.fallback.headline}</div>
    case 'stale':
      // Keep stale data visible; add thin strip above it (not replacing it).
      return (
        <>
          <ReconnectingStrip fallback={state.fallback} />
          <div data-testid="stale-data">{JSON.stringify(state.data)}</div>
        </>
      )
    case 'empty':
      return <div data-testid="empty" />
    case 'ready':
      return <div data-testid="ready">{JSON.stringify(state.data)}</div>
  }
}

// ---------------------------------------------------------------------------
// AC: isError + no data → kind: 'error' (initial load failure, full pane)
// ---------------------------------------------------------------------------

describe('useRead – initial load failure (isError=true, data=undefined)', () => {
  it('returns kind: error', () => {
    mockUseQuery.mockReturnValue({
      isError: true,
      error: new ApiError('GET /api/tasks → 500', 'unreachable'),
      data: undefined,
    })
    const html = renderToStaticMarkup(<Probe of="tasks" />)
    expect(html).toContain('data-testid="error-pane"')
  })

  it('carries the resolved Fallback headline', () => {
    mockUseQuery.mockReturnValue({
      isError: true,
      error: new ApiError('boom', 'unreachable'),
      data: undefined,
    })
    const html = renderToStaticMarkup(<Probe of="tasks" />)
    expect(html).toContain("Can&#x27;t reach the dashboard server")
  })

  it('does NOT render stale-data or reconnecting-strip', () => {
    mockUseQuery.mockReturnValue({
      isError: true,
      error: new Error('load failed'),
      data: undefined,
    })
    const html = renderToStaticMarkup(<Probe of="tasks" />)
    expect(html).not.toContain('stale-data')
    expect(html).not.toContain('reconnecting-strip')
  })
})

// ---------------------------------------------------------------------------
// AC: isError + data present → kind: 'stale' (background refetch failure)
// ---------------------------------------------------------------------------

describe('useRead – background refetch failure (isError=true, data present)', () => {
  it('returns kind: stale', () => {
    mockUseQuery.mockReturnValue({
      isError: true,
      error: new ApiError('timeout', 'stale-daemon'),
      data: { value: 7 },
    })
    const html = renderToStaticMarkup(<Probe of="tasks" />)
    expect(html).toContain('data-testid="stale-data"')
  })

  it('carries the prior data alongside the Fallback', () => {
    mockUseQuery.mockReturnValue({
      isError: true,
      error: new ApiError('timeout', 'stale-daemon'),
      data: { value: 99 },
    })
    const html = renderToStaticMarkup(<Probe of="tasks" />)
    // renderToStaticMarkup HTML-encodes quotes; check for the numeric value
    // which is unambiguous without needing to match the key spelling.
    expect(html).toContain(':99}')
  })

  it('renders the ReconnectingStrip (not a full-pane error) alongside the data', () => {
    mockUseQuery.mockReturnValue({
      isError: true,
      error: new ApiError('timeout', 'stale-daemon'),
      data: { value: 1 },
    })
    const html = renderToStaticMarkup(<Probe of="tasks" />)
    // Strip is present
    expect(html).toContain('data-testid="reconnecting-strip"')
    // Data is still rendered
    expect(html).toContain('data-testid="stale-data"')
    // No full-pane takeover
    expect(html).not.toContain('data-testid="error-pane"')
  })

  it('does NOT produce kind: error when prior data exists', () => {
    mockUseQuery.mockReturnValue({
      isError: true,
      error: new Error('refetch failed'),
      data: { value: 5 },
    })
    const html = renderToStaticMarkup(<Probe of="tasks" />)
    expect(html).not.toContain('data-testid="error-pane"')
  })
})

// ---------------------------------------------------------------------------
// AC: happy-path states still work correctly after the stale arm was added
// ---------------------------------------------------------------------------

describe('useRead – happy path', () => {
  it('returns kind: loading when data is undefined and no error', () => {
    mockUseQuery.mockReturnValue({ isError: false, error: null, data: undefined })
    const html = renderToStaticMarkup(<Probe of="tasks" />)
    expect(html).toContain('data-testid="loading"')
  })

  it('returns kind: ready when data is present and no error', () => {
    mockUseQuery.mockReturnValue({ isError: false, error: null, data: { value: 42 } })
    const html = renderToStaticMarkup(<Probe of="tasks" />)
    expect(html).toContain('data-testid="ready"')
    // HTML-encodes quotes; check for the unambiguous numeric value.
    expect(html).toContain(':42}')
  })
})
