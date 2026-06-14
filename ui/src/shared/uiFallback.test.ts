/**
 * Unit tests for the UI fallback seam (`resolveFallback`, `logFallbackError`).
 *
 * RUNNER NOTE: this suite runs under `bun test`, NOT vitest. Under bun,
 * `import.meta.env.DEV` is `undefined` (a fixed build-time value) and
 * `vi.stubEnv` is a no-op — there is no way to toggle DEV at runtime. So the
 * seam always executes its PROD branch here (`detail === null`, no dev remedy
 * for unclassified errors). We assert the prod-mode copy that renders
 * deterministically, and `it.skip` the dev-mode assertions that would require
 * env stubbing — mirroring the documented split in EventsPage.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from 'bun:test'
import { resolveFallback, logFallbackError } from './uiFallback'
import { ApiError } from '@/shared/api'

describe('resolveFallback', () => {
  it('maps an ApiError of kind "unreachable" to the start-the-server remedy', () => {
    const fb = resolveFallback(new ApiError('boom', 'unreachable'), 'tasks')
    expect(fb.headline).toContain('reach the dashboard server')
    expect(fb.remedy).toContain('npm run dev:server')
    expect(fb.severity).toBe('error')
  })

  it('maps an ApiError of kind "stale-daemon" to the daemon-restart remedy as a warning', () => {
    const fb = resolveFallback(new ApiError('boom', 'stale-daemon'), 'tasks')
    expect(fb.remedy).toContain('mars daemon restart')
    expect(fb.severity).toBe('warning')
  })

  it('weaves the surface label into the headline for a plain Error', () => {
    const fb = resolveFallback(new Error('boom'), 'origin tasks')
    expect(fb.headline).toBe("Couldn't load the origin tasks.")
    expect(fb.severity).toBe('error')
  })

  it('suppresses detail (null) in prod mode (the bun-test build mode)', () => {
    const fb = resolveFallback(new Error('connection refused'), 'tasks')
    expect(fb.detail).toBeNull()
  })

  // DEV-mode assertion: in dev, `detail` is non-null and contains the error
  // message. Skipped because `import.meta.env.DEV` is `undefined` under bun
  // test and `vi.stubEnv('DEV', true)` is a no-op, so the dev branch is
  // unreachable here.
  it.skip('exposes a non-null detail containing the error message in dev mode (requires vi.stubEnv — not available in bun)', () => {
    vi.stubEnv('DEV', true)
    const fb = resolveFallback(new Error('connection refused'), 'tasks')
    expect(fb.detail).not.toBeNull()
    expect(fb.detail).toContain('connection refused')
    vi.unstubAllEnvs()
  })
})

describe('logFallbackError', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not call console.error in prod mode (the bun-test build mode)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    logFallbackError('something went wrong')
    expect(spy).not.toHaveBeenCalled()
  })

  // DEV-mode assertions: in dev, `logFallbackError` forwards the value to
  // `console.error` unchanged. Skipped for the same env-stubbing reason above.
  it.skip('calls console.error with the error in dev mode (requires vi.stubEnv — not available in bun)', () => {
    vi.stubEnv('DEV', true)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    logFallbackError('something went wrong')
    expect(spy).toHaveBeenCalledWith('something went wrong')
    vi.unstubAllEnvs()
  })

  it.skip('passes the error value unchanged to console.error in dev mode (requires vi.stubEnv — not available in bun)', () => {
    vi.stubEnv('DEV', true)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const err = new Error('network failure')
    logFallbackError(err)
    expect(spy).toHaveBeenCalledWith(err)
    vi.unstubAllEnvs()
  })
})
