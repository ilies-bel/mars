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
import { ApiError, SchemaError } from '@/shared/api'

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
