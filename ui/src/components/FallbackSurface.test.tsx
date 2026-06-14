/**
 * Unit tests for the FallbackSurface render seam.
 *
 * RUNNER NOTE: this suite runs under `bun test`, NOT vitest. Under bun,
 * `import.meta.env.DEV` is `undefined` (a fixed build-time value) and
 * `vi.stubEnv` is a no-op — DEV cannot be toggled at runtime. So the seam
 * always renders its PROD branch here: the calm headline + remedy show, the
 * raw `detail` is suppressed. We assert that deterministic prod output and
 * `it.skip` the dev-only "raw detail is shown" assertions, mirroring the
 * documented split in EventsPage.test.tsx.
 *
 * Also: `renderToStaticMarkup` does NOT run `useEffect`, so the dev-only
 * `logFallbackError` side effect is out of scope and we never assert on
 * `console.error` here.
 */
import { describe, expect, it, vi } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FallbackSurface } from './FallbackSurface'
import type { Fallback } from '@/shared/uiFallback'
import { ApiError } from '@/shared/api'

describe('FallbackSurface — pane variant', () => {
  it('renders the panel testid and headline but hides raw detail in prod', () => {
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
    expect(html).toContain('npm run dev:server')
  })

  // DEV-mode assertion: in dev the raw detail (error message) is shown. Skipped
  // because `import.meta.env.DEV` is undefined under bun test and
  // `vi.stubEnv('DEV', true)` is a no-op, so the dev branch is unreachable.
  it.skip('shows the raw detail in dev (requires vi.stubEnv — not available in bun)', () => {
    vi.stubEnv('DEV', true)
    const html = renderToStaticMarkup(
      <FallbackSurface
        error={new ApiError('GET /api/tasks → 500', 'unreachable')}
        of="tasks"
        variant="pane"
      />,
    )
    expect(html).toContain('GET /api/tasks → 500')
    vi.unstubAllEnvs()
  })
})

describe('FallbackSurface — inline variant', () => {
  it('renders the headline', () => {
    const html = renderToStaticMarkup(
      <FallbackSurface error={new Error('boom')} of="origin tasks" variant="inline" />,
    )
    // renderToStaticMarkup HTML-encodes the apostrophe.
    expect(html).toContain('Couldn&#x27;t load the origin tasks.')
  })

  // DEV-mode assertion: in dev the detail (error message) is appended. Skipped
  // for the same env-stubbing reason above.
  it.skip('shows the detail in dev (requires vi.stubEnv — not available in bun)', () => {
    vi.stubEnv('DEV', true)
    const html = renderToStaticMarkup(
      <FallbackSurface error={new Error('kaboom-detail')} of="origin tasks" variant="inline" />,
    )
    expect(html).toContain('kaboom-detail')
    vi.unstubAllEnvs()
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
