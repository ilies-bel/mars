/**
 * Unit tests for the FallbackSurface render seam.
 *
 * The dev/prod copy split keys off `import.meta.env.DEV`; we pin each branch
 * with `vi.stubEnv('DEV', …)` (runs under vitest — `npm run test:src`).
 *
 * `renderToStaticMarkup` does NOT run `useEffect`, so the dev-only
 * `logFallbackError` side effect is out of scope here; it is covered directly
 * in uiFallback.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FallbackSurface } from './FallbackSurface'
import type { Fallback } from '@/shared/uiFallback'
import { ApiError } from '@/shared/api'

describe('FallbackSurface — pane variant', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('renders the panel testid and headline but hides raw detail in prod', () => {
    vi.stubEnv('DEV', false)
    const html = renderToStaticMarkup(
      <FallbackSurface
        error={new ApiError('GET /api/tasks → 500', 'other')}
        of="tasks"
        variant="pane"
      />,
    )
    expect(html).toContain('data-testid="api-error-panel"')
    expect(html).toContain('The dashboard server returned an error.')
    // Raw diagnostic text must never reach the prod DOM.
    expect(html).not.toContain('GET /api/tasks → 500')
  })

  it('renders the remedy line (always shown for a classified ApiError)', () => {
    const html = renderToStaticMarkup(
      <FallbackSurface
        error={new ApiError('GET /api/tasks → 500', 'unreachable')}
        of="tasks"
        variant="pane"
      />,
    )
    expect(html).toContain('mars ui')
  })

  it('shows the raw detail in dev', () => {
    vi.stubEnv('DEV', true)
    const html = renderToStaticMarkup(
      <FallbackSurface
        error={new ApiError('GET /api/tasks → 500', 'unreachable')}
        of="tasks"
        variant="pane"
      />,
    )
    expect(html).toContain('GET /api/tasks → 500')
  })
})

describe('FallbackSurface — inline variant', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('renders the headline', () => {
    const html = renderToStaticMarkup(
      <FallbackSurface error={new Error('boom')} of="origin tasks" variant="inline" />,
    )
    // renderToStaticMarkup HTML-encodes the apostrophe.
    expect(html).toContain('Couldn&#x27;t load the origin tasks.')
  })

  it('shows the detail in dev', () => {
    vi.stubEnv('DEV', true)
    const html = renderToStaticMarkup(
      <FallbackSurface error={new Error('kaboom-detail')} of="origin tasks" variant="inline" />,
    )
    expect(html).toContain('kaboom-detail')
  })
})

describe('FallbackSurface — pre-resolved Fallback', () => {
  it('renders the headline from an already-resolved Fallback object', () => {
    const resolved: Fallback = {
      headline: 'Pre-resolved headline',
      remedy: null,
      detail: null,
      severity: 'error',
    }
    const html = renderToStaticMarkup(
      <FallbackSurface error={resolved} of="ignored" variant="inline" />,
    )
    expect(html).toContain('Pre-resolved headline')
  })
})
