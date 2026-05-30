/**
 * Tests for ApiErrorPanel — verifies the mode-split fallback behaviour.
 *
 * In prod (`import.meta.env.DEV = false`):
 *   - Only the warm headline is rendered; raw error text and the shell hint
 *     are hidden so operators never see diagnostics they can't act on.
 *
 * In dev (`import.meta.env.DEV = true`):
 *   - Both the raw error text and the 'How to fix' shell hint are rendered so
 *     the local operator can diagnose the problem immediately.
 *
 * `console.error` side-effect:
 *   - `logFallbackError` (called by the component's useEffect) invokes
 *     `console.error` in dev and is a no-op in prod.  Since useEffect does
 *     not run in `renderToStaticMarkup`, we verify this behaviour by calling
 *     the helper directly — it is the single unit that owns the side effect.
 */
import { afterEach, describe, expect, it, vi } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { logFallbackError } from '@/shared/uiFallback'
import { ApiErrorPanel } from './ApiErrorPanel'

describe('ApiErrorPanel – prod mode (DEV=false)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('renders the warm headline', () => {
    vi.stubEnv('DEV', false)
    const html = renderToStaticMarkup(<ApiErrorPanel error="GET /api/tasks → unreachable" />)
    expect(html).toContain("Can")
    expect(html).toContain("reach the dashboard server right now")
  })

  it('hides the raw error text', () => {
    vi.stubEnv('DEV', false)
    const html = renderToStaticMarkup(<ApiErrorPanel error="GET /api/tasks → unreachable" />)
    expect(html).not.toContain('GET /api/tasks → unreachable')
  })

  it('hides the How-to-fix shell hint', () => {
    vi.stubEnv('DEV', false)
    const html = renderToStaticMarkup(<ApiErrorPanel error="GET /api/tasks → unreachable" />)
    expect(html).not.toContain('How to fix')
    expect(html).not.toContain('npm run dev:server')
  })

  it('always renders the api-error-panel testid', () => {
    vi.stubEnv('DEV', false)
    const html = renderToStaticMarkup(<ApiErrorPanel error="any error" />)
    expect(html).toContain('data-testid="api-error-panel"')
  })
})

describe('ApiErrorPanel – dev mode (DEV=true)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('renders the warm headline', () => {
    vi.stubEnv('DEV', true)
    const html = renderToStaticMarkup(<ApiErrorPanel error="GET /api/tasks → unreachable" />)
    expect(html).toContain("reach the dashboard server right now")
  })

  it('shows the raw error text', () => {
    vi.stubEnv('DEV', true)
    const html = renderToStaticMarkup(<ApiErrorPanel error="GET /api/tasks → unreachable" />)
    expect(html).toContain('GET /api/tasks → unreachable')
  })

  it('shows the How-to-fix shell hint', () => {
    vi.stubEnv('DEV', true)
    const html = renderToStaticMarkup(<ApiErrorPanel error="GET /api/tasks → unreachable" />)
    expect(html).toContain('How to fix')
    expect(html).toContain('npm run dev:server')
  })
})

describe('ApiErrorPanel – console.error side effect via logFallbackError', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('console.error is invoked in dev mode', () => {
    vi.stubEnv('DEV', true)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    logFallbackError('GET /api/tasks → unreachable')
    expect(spy).toHaveBeenCalledWith('GET /api/tasks → unreachable')
  })

  it('console.error is not invoked in prod mode', () => {
    vi.stubEnv('DEV', false)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    logFallbackError('GET /api/tasks → unreachable')
    expect(spy).not.toHaveBeenCalled()
  })
})
