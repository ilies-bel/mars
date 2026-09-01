/**
 * Unit tests for the UI fallback seam (`resolveFallback`, `logFallbackError`).
 *
 * The dev/prod copy split keys off `import.meta.env.DEV`. We pin each branch
 * with `vi.stubEnv('DEV', …)`, which Vitest wires up as a special boolean env
 * toggle for `DEV`/`PROD`/`SSR`. The suite runs under vitest (`npm run
 * test:src`); the `bun:test` import is redirected to the compat shim.
 */
import { afterEach, describe, expect, it, vi } from 'bun:test'
import { z } from 'zod'
import { resolveFallback, logFallbackError } from './uiFallback'
import { ApiError, SchemaError, fetchJson } from '@/shared/api'

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

  it('maps an ApiError of kind "stale-daemon" to the daemon-not-running remedy as a warning', () => {
    const fb = resolveFallback(
      new ApiError('boom', 'stale-daemon'),
      'tasks',
      { repoRoot: '/repos/my-project' },
    )
    expect(fb.remedy).toContain('mars daemon restart')
    expect(fb.remedy).toContain('--repo /repos/my-project')
    expect(fb.severity).toBe('warning')
  })

  it('maps an ApiError of kind "stale-daemon-code" without SHAs to the generic restart copy', () => {
    const fb = resolveFallback(
      new ApiError('boom', 'stale-daemon-code'),
      'tasks',
      { repoRoot: '/repos/my-project' },
    )
    expect(fb.headline).toContain('older code')
    expect(fb.remedy).toContain('mars daemon restart')
    expect(fb.remedy).toContain('--repo /repos/my-project')
    expect(fb.severity).toBe('warning')
  })

  it('maps stale-daemon-code with SHAs to a SHA-specific headline and warning severity', () => {
    const err = new ApiError('boom', 'stale-daemon-code', 405, {
      sourceSha: 'abc1234',
      currentSha: 'def9876',
    })
    const fb = resolveFallback(err, 'tasks', { repoRoot: '/repos/my-project' })
    expect(fb.headline).toContain('abc1234')
    expect(fb.headline).toContain('def9876')
    expect(fb.remedy).toContain('mars daemon restart')
    expect(fb.remedy).toContain('--repo /repos/my-project')
    expect(fb.severity).toBe('warning')
  })

  it('stale-daemon and stale-daemon-code produce distinct messages', () => {
    const fbDown = resolveFallback(new ApiError('boom', 'stale-daemon'), 'tasks')
    const fbCode = resolveFallback(new ApiError('boom', 'stale-daemon-code', 405, { sourceSha: 'abc1234', currentSha: 'def9876' }), 'tasks')
    expect(fbDown.headline).not.toBe(fbCode.headline)
  })

  it('two different focused projects produce different stale-daemon remedy strings', () => {
    const fbA = resolveFallback(
      new ApiError('boom', 'stale-daemon'),
      'tasks',
      { repoRoot: '/repos/project-alpha' },
    )
    const fbB = resolveFallback(
      new ApiError('boom', 'stale-daemon'),
      'tasks',
      { repoRoot: '/repos/project-beta' },
    )
    expect(fbA.remedy).toContain('--repo /repos/project-alpha')
    expect(fbB.remedy).toContain('--repo /repos/project-beta')
    expect(fbA.remedy).not.toBe(fbB.remedy)
  })

  it('stale-daemon remedy omits --repo flag when no project context is supplied', () => {
    const fb = resolveFallback(new ApiError('boom', 'stale-daemon'), 'tasks')
    expect(fb.remedy).toContain('mars daemon restart')
    expect(fb.remedy).not.toContain('--repo')
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

describe('resolveFallback – SchemaError (payload/schema mismatch)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('names the first offending field path in the headline, not the generic sentence', () => {
    const err = new SchemaError('/api/deep-reflections/abc', [
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'undefined',
        path: ['autoRunReflect'],
        message: 'Required',
      },
    ])
    const fb = resolveFallback(err, 'reflections')
    expect(fb.headline).toContain('autoRunReflect')
    // Must NOT fall back to the generic "Couldn't load the reflections."
    expect(fb.headline).not.toBe("Couldn't load the reflections.")
  })

  it('uses the surface label and nested path for a deep field mismatch', () => {
    const err = new SchemaError('/api/deep-reflections/abc', [
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'undefined',
        path: ['report', 'suggestions', 2, 'applyState'],
        message: 'Required',
      },
    ])
    const fb = resolveFallback(err, 'reflection detail')
    expect(fb.headline).toContain('report.suggestions.2.applyState')
  })

  it('uses "(root)" when the Zod issue path is empty', () => {
    const err = new SchemaError('/api/tasks', [
      {
        code: 'invalid_type',
        expected: 'object',
        received: 'array',
        path: [],
        message: 'Expected object, received array',
      },
    ])
    const fb = resolveFallback(err, 'tasks')
    expect(fb.headline).toContain('(root)')
  })

  it('suggests mars daemon restart and npm --prefix ui run build in the remedy', () => {
    const err = new SchemaError('/api/deep-reflections', [
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'undefined',
        path: ['autoEnqueue'],
        message: 'Required',
      },
    ])
    const fb = resolveFallback(err, 'reflections')
    expect(fb.remedy).toContain('mars daemon restart')
    expect(fb.remedy).toContain('npm --prefix ui run build')
  })

  it('includes the full issues JSON in detail in dev mode', () => {
    vi.stubEnv('DEV', true)
    const issues = [
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'undefined',
        path: ['autoRunReflect'],
        message: 'Required',
      },
    ]
    const err = new SchemaError('/api/deep-reflections', issues)
    const fb = resolveFallback(err, 'reflections')
    expect(fb.detail).not.toBeNull()
    expect(fb.detail).toContain('autoRunReflect')
    expect(fb.detail).toContain('Required')
  })

  it('suppresses detail (null) in prod mode', () => {
    vi.stubEnv('DEV', false)
    const err = new SchemaError('/api/deep-reflections', [
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'undefined',
        path: ['autoRunReflect'],
        message: 'Required',
      },
    ])
    const fb = resolveFallback(err, 'reflections')
    expect(fb.detail).toBeNull()
  })

  it('severity is error', () => {
    const err = new SchemaError('/api/tasks', [
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'undefined',
        path: ['status'],
        message: 'Required',
      },
    ])
    const fb = resolveFallback(err, 'tasks')
    expect(fb.severity).toBe('error')
  })
})

describe('logFallbackError', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('does not call console.error in prod mode for plain errors', () => {
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

  it('logs SchemaError in production builds (contract break must not be invisible)', () => {
    vi.stubEnv('DEV', false)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const err = new SchemaError('/api/tasks', [
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'undefined',
        path: ['status'],
        message: 'Required',
      },
    ])
    logFallbackError(err)
    expect(spy).toHaveBeenCalledWith(err)
  })

  it('does not log a plain ApiError in production builds', () => {
    vi.stubEnv('DEV', false)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    logFallbackError(new ApiError('boom', 'unreachable'))
    expect(spy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// fetchJson – SchemaError propagation
//
// These tests verify the full mechanism that surfaces a schema mismatch as a
// React Query error state rather than an empty list or permanent skeleton.
//
// The chain is:
//   fetchJson → throws SchemaError → React Query catches it → sets query.error
//
// The custom retry function in main.tsx returns false for SchemaError, which
// means query.error is set on the FIRST failure with no retry-delay window
// during which it would be null. The tests here prove that fetchJson does
// NOT swallow the error (it rejects the returned promise) and that the
// failure is logged even in production builds.
// ---------------------------------------------------------------------------

describe('fetchJson – SchemaError propagation to React Query', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  const schema = z.object({ expected: z.string() })

  const makeOkFetch = (body: unknown) => (): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

  it('rejects with SchemaError when the response body fails schema validation', async () => {
    // Proves that fetchJson does NOT swallow the error — the returned Promise
    // rejects, so React Query's queryFn machinery will catch it and set
    // query.error instead of leaving the query in an indefinite empty state.
    await expect(
      fetchJson('/test', schema, undefined, makeOkFetch({ unexpected: 'shape' })),
    ).rejects.toBeInstanceOf(SchemaError)
  })

  it('resolves normally when the response body matches the schema', async () => {
    const result = await fetchJson('/test', schema, undefined, makeOkFetch({ expected: 'hello' }))
    expect(result).toEqual({ expected: 'hello' })
  })

  it('logs schema validation failures in production builds', async () => {
    // A broken client/server contract must not be invisible in the shipped
    // bundle. Before this fix the console.error was gated on import.meta.env.DEV,
    // meaning production operators saw nothing: no error UI, no network error,
    // no console message — only a silent empty/loading state.
    vi.stubEnv('DEV', false)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await fetchJson('/test', schema, undefined, makeOkFetch({ unexpected: 'shape' })).catch(() => {})

    expect(spy).toHaveBeenCalledWith(
      '[mars-ui] Schema validation failed for',
      '/test',
      expect.any(Array),
    )
  })

  it('logs schema validation failures in dev builds', async () => {
    vi.stubEnv('DEV', true)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await fetchJson('/test', schema, undefined, makeOkFetch({ unexpected: 'shape' })).catch(() => {})

    expect(spy).toHaveBeenCalledWith(
      '[mars-ui] Schema validation failed for',
      '/test',
      expect.any(Array),
    )
  })
})
