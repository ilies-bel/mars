/**
 * Unit tests for uiFallback helpers.
 *
 * Both `getFallbackCopy` and `logFallbackError` branch on
 * `import.meta.env.DEV`.  We pin each branch by using `vi.stubEnv` which
 * Vitest wires up as a special boolean env toggle for `DEV`/`PROD`/`SSR`.
 */
import { afterEach, describe, expect, it, vi } from 'bun:test'
import { getFallbackCopy, logFallbackError } from './uiFallback'

describe('getFallbackCopy', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns a non-null detail equal to String(error) in dev mode', () => {
    vi.stubEnv('DEV', true)
    const err = new Error('connection refused')
    const result = getFallbackCopy('ProgressPage', err)
    expect(result.detail).toBe(String(err))
  })

  it('returns null detail in prod mode', () => {
    vi.stubEnv('DEV', false)
    const result = getFallbackCopy('ProgressPage', new Error('connection refused'))
    expect(result.detail).toBeNull()
  })

  it('always returns a non-empty headline string regardless of mode', () => {
    for (const devMode of [true, false] as const) {
      vi.stubEnv('DEV', devMode)
      const { headline } = getFallbackCopy('SomeSurface', 'oops')
      expect(typeof headline).toBe('string')
      expect(headline.length).toBeGreaterThan(0)
      vi.unstubAllEnvs()
    }
  })

  it('detail contains the stringified error in dev mode for plain strings', () => {
    vi.stubEnv('DEV', true)
    const result = getFallbackCopy('TodoPage', 'timeout after 5s')
    expect(result.detail).toBe('timeout after 5s')
  })
})

describe('logFallbackError', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('calls console.error with the error in dev mode', () => {
    vi.stubEnv('DEV', true)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    logFallbackError('something went wrong')
    expect(spy).toHaveBeenCalledWith('something went wrong')
  })

  it('does not call console.error in prod mode', () => {
    vi.stubEnv('DEV', false)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    logFallbackError('something went wrong')
    expect(spy).not.toHaveBeenCalled()
  })

  it('passes the error value unchanged to console.error in dev mode', () => {
    vi.stubEnv('DEV', true)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const err = new Error('network failure')
    logFallbackError(err)
    expect(spy).toHaveBeenCalledWith(err)
  })
})
