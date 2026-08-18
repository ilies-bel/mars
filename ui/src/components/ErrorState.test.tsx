/**
 * Tests for the ErrorState shared component.
 *
 * Key invariants:
 *   - 4xx ApiErrors: show the endpoint's own error message, NOT the generic
 *     "restart the daemon" remedy copy (stale-daemon / stale-daemon-code).
 *   - Retry button renders only when onRetry is provided.
 *   - role="alert" for accessibility in both pane and inline variants.
 *   - Non-4xx errors delegate to resolveFallback (headline + remedy shown).
 *
 * useEffect (logFallbackError) is skipped because renderToStaticMarkup does
 * not run effects — the logging side-effect is covered in uiFallback.test.ts.
 */

import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ErrorState } from './ErrorState'
import { ApiError } from '@/shared/api'
import { SkeletonList } from './Skeleton'

// ---------------------------------------------------------------------------
// 4xx responses — endpoint message shown instead of stale-daemon copy
// ---------------------------------------------------------------------------

describe('ErrorState — 4xx ApiError', () => {
  it('shows the endpoint message as the headline for a 404', () => {
    const err = new ApiError('GET /api/proposals → 404', 'stale-daemon', 404)
    const html = renderToStaticMarkup(<ErrorState error={err} of="proposals" />)
    expect(html).toContain('GET /api/proposals → 404')
  })

  it('does NOT show stale-daemon remedy for a 4xx response', () => {
    const err = new ApiError('GET /api/proposals → 404', 'stale-daemon', 404)
    const html = renderToStaticMarkup(<ErrorState error={err} of="proposals" />)
    // The stale-daemon remedy says "Restart the daemon" — must not appear.
    expect(html).not.toContain('mars daemon restart')
    expect(html).not.toContain('stale port')
  })

  it('shows a 422 endpoint message correctly', () => {
    const err = new ApiError('GET /api/tasks → 422', 'other', 422)
    const html = renderToStaticMarkup(<ErrorState error={err} of="tasks" />)
    expect(html).toContain('GET /api/tasks → 422')
  })

  it('renders the Retry button when onRetry is provided', () => {
    const err = new ApiError('GET /api/proposals → 404', 'stale-daemon', 404)
    const html = renderToStaticMarkup(
      <ErrorState error={err} of="proposals" onRetry={() => {}} />,
    )
    expect(html).toContain('Retry')
  })

  it('does NOT render a Retry button when onRetry is omitted', () => {
    const err = new ApiError('GET /api/proposals → 404', 'stale-daemon', 404)
    const html = renderToStaticMarkup(<ErrorState error={err} of="proposals" />)
    expect(html).not.toContain('Retry')
  })
})

// ---------------------------------------------------------------------------
// Non-4xx responses — resolved fallback copy
// ---------------------------------------------------------------------------

describe('ErrorState — non-4xx ApiError', () => {
  it('shows the resolved fallback headline for a 5xx ApiError', () => {
    const err = new ApiError('GET /api/tasks → 500', 'other', 500)
    const html = renderToStaticMarkup(<ErrorState error={err} of="tasks" />)
    // resolveFallback maps 'other' → "The dashboard server returned an error."
    expect(html).toContain('The dashboard server returned an error.')
  })

  it('shows the Retry button for 5xx when onRetry is provided', () => {
    const err = new ApiError('GET /api/tasks → 500', 'other', 500)
    const html = renderToStaticMarkup(
      <ErrorState error={err} of="tasks" onRetry={() => {}} />,
    )
    expect(html).toContain('Retry')
  })

  it('shows the resolved fallback headline for a plain Error', () => {
    const html = renderToStaticMarkup(
      <ErrorState error={new Error('network failed')} of="events" />,
    )
    // resolveFallback for unknown Error → "Couldn't load the events."
    expect(html).toContain('events')
  })
})

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe('ErrorState — role', () => {
  it('has role="alert" in pane variant', () => {
    const html = renderToStaticMarkup(<ErrorState error={new Error('boom')} of="test" />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('data-testid="error-state"')
  })

  it('has role="alert" in inline variant', () => {
    const html = renderToStaticMarkup(
      <ErrorState error={new Error('boom')} of="test" variant="inline" />,
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('data-testid="error-state-inline"')
  })

  it('icon prefix is aria-hidden', () => {
    const html = renderToStaticMarkup(<ErrorState error={new Error('boom')} of="test" />)
    expect(html).toContain('aria-hidden="true"')
  })
})

// ---------------------------------------------------------------------------
// Skeleton integration — page loading states render shimmer blocks
// ---------------------------------------------------------------------------

describe('SkeletonList — page loading state', () => {
  it('renders an aria-busy loading region with the correct label', () => {
    const html = renderToStaticMarkup(
      <SkeletonList rows={4} label="Loading proposals" rowClassName="h-12 w-full mb-2" />,
    )
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('aria-label="Loading proposals"')
  })

  it('renders the expected number of skeleton bars', () => {
    const html = renderToStaticMarkup(
      <SkeletonList rows={4} label="Loading proposals" rowClassName="h-12 w-full mb-2" />,
    )
    const count = (html.match(/animate-mars-pulse/g) ?? []).length
    expect(count).toBe(4)
  })
})
