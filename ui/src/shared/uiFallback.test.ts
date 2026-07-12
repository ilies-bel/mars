/**
 * Unit tests for the UI fallback seam (`resolveFallback`, `logFallbackError`).
 *
 * The dev/prod copy split keys off `import.meta.env.DEV`. We pin each branch
 * with `vi.stubEnv('DEV', …)`, which Vitest wires up as a special boolean env
 * toggle for `DEV`/`PROD`/`SSR`. The suite runs under vitest (`npm run
 * test:src`); the `bun:test` import is redirected to the compat shim.
 */
import { afterEach, describe, expect, it, vi } from 'bun:test'
import { resolveFallback, logFallbackError } from './uiFallback'
import { ApiError } from '@/shared/api'

describe('resolveFallback', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('maps an ApiError of kind "unreachable" to the start-the-server remedy', () => {
    const fb = resolveFallback(new ApiError('boom', 'unreachable'), 'tasks')
    expect(fb.headline).toContain('reach the dashboard server')
    expect(fb.remedy).toContain('mars ui')
    expect(fb.severity).toBe('error')
  })

  it('maps an ApiError of kind "stale-daemon" to the daemon-restart remedy as a warning', () => {
    const fb = resolveFallback(new ApiError('boom', 'stale-daemon'), 'tasks')
    expect(fb.remedy).toContain('mars daemon restart')
    expect(fb.severity).toBe('warning')
  })

  it('maps an ApiError of kind "other" to the generic server-error remedy', () => {
    const fb = resolveFallback(new ApiError('boom', 'other'), 'tasks')
    expect(fb.headline).toContain('returned an error')
    expect(fb.remedy).toContain('daemon logs')
    expect(fb.severity).toBe('error')
  })

  it('weaves the surface label into the headline for a plain Error', () => {
    const fb = resolveFallback(new Error('boom'), 'origin tasks')
    expect(fb.headline).toBe("Couldn't load the origin tasks.")
    expect(fb.severity).toBe('error')
  })

  it('suppresses detail (null) in prod mode', () => {
    vi.stubEnv('DEV', false)
    const fb = resolveFallback(new Error('connection refused'), 'tasks')
    expect(fb.detail).toBeNull()
  })

  it('exposes a non-null detail containing the error message in dev mode', () => {
    vi.stubEnv('DEV', true)
    const fb = resolveFallback(new Error('connection refused'), 'tasks')
    expect(fb.detail).not.toBeNull()
    expect(fb.detail).toContain('connection refused')
  })

  it('omits the remedy for an unclassified error in prod, supplies one in dev', () => {
    vi.stubEnv('DEV', false)
    expect(resolveFallback(new Error('x'), 'tasks').remedy).toBeNull()
    vi.unstubAllEnvs()
    vi.stubEnv('DEV', true)
    expect(resolveFallback(new Error('x'), 'tasks').remedy).not.toBeNull()
  })
})

describe('logFallbackError', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('does not call console.error in prod mode', () => {
    vi.stubEnv('DEV', false)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    logFallbackError('something went wrong')
    expect(spy).not.toHaveBeenCalled()
  })

  it('calls console.error with the error in dev mode', () => {
    vi.stubEnv('DEV', true)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    logFallbackError('something went wrong')
    expect(spy).toHaveBeenCalledWith('something went wrong')
  })

  it('passes the error value unchanged to console.error in dev mode', () => {
    vi.stubEnv('DEV', true)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const err = new Error('network failure')
    logFallbackError(err)
    expect(spy).toHaveBeenCalledWith(err)
  })
})
