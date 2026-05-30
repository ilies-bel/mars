/**
 * Tests for ApiErrorPanel — verifies that the panel shows the correct remedy
 * copy based on the error kind, distinguishing a stale daemon from an
 * unreachable server.
 */
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError } from '@/shared/api'
import { ApiErrorPanel } from './ApiErrorPanel'

describe('ApiErrorPanel – remedy copy', () => {
  it('shows the mars-daemon-restart remedy for a 405 stale-daemon error', () => {
    const error = new ApiError(
      'GET /api/action-queue/action-queue → 405',
      'stale-daemon',
      405,
    )
    const html = renderToStaticMarkup(<ApiErrorPanel error={error} />)
    expect(html).toContain('mars daemon restart')
    expect(html).not.toContain('npm run dev:server')
  })

  it('shows the mars-daemon-restart remedy for a 404 stale-daemon error', () => {
    const error = new ApiError('GET /api/view → 404', 'stale-daemon', 404)
    const html = renderToStaticMarkup(<ApiErrorPanel error={error} />)
    expect(html).toContain('mars daemon restart')
    expect(html).not.toContain('npm run dev:server')
  })

  it('shows the npm-run-dev-server remedy for an unreachable error', () => {
    const error = new ApiError(
      'GET /api/tasks → cannot reach the mars-ui API server.',
      'unreachable',
    )
    const html = renderToStaticMarkup(<ApiErrorPanel error={error} />)
    expect(html).toContain('npm run dev:server')
    expect(html).not.toContain('mars daemon restart')
  })

  it('shows the npm-run-dev-server remedy for an other-kind error', () => {
    const error = new ApiError('GET /api/tasks → 500', 'other', 500)
    const html = renderToStaticMarkup(<ApiErrorPanel error={error} />)
    expect(html).toContain('npm run dev:server')
    expect(html).not.toContain('mars daemon restart')
  })

  it('shows the npm-run-dev-server remedy for a plain string error', () => {
    const html = renderToStaticMarkup(
      <ApiErrorPanel error="something went wrong" />,
    )
    expect(html).toContain('npm run dev:server')
    expect(html).not.toContain('mars daemon restart')
  })

  it('shows the npm-run-dev-server remedy for a plain Error object', () => {
    const html = renderToStaticMarkup(
      <ApiErrorPanel error={new Error('network failure')} />,
    )
    expect(html).toContain('npm run dev:server')
    expect(html).not.toContain('mars daemon restart')
  })

  it('displays the error message in the panel body', () => {
    const error = new ApiError(
      'GET /api/action-queue/action-queue → 405',
      'stale-daemon',
      405,
    )
    const html = renderToStaticMarkup(<ApiErrorPanel error={error} />)
    expect(html).toContain('GET /api/action-queue/action-queue')
  })

  it('always renders the api-error-panel testid', () => {
    const html = renderToStaticMarkup(
      <ApiErrorPanel error="any error" />,
    )
    expect(html).toContain('data-testid="api-error-panel"')
  })
})
