/**
 * Tests for isNewerVersion and pollGithubRelease.
 *
 * isNewerVersion is a pure helper — no mocking needed.
 * pollGithubRelease is tested by injecting a mock fetch function so we never
 * make real network calls and the test is fully deterministic.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isNewerVersion, pollGithubRelease } from '../github-update-poller'

// ── isNewerVersion ────────────────────────────────────────────────────────────

describe('isNewerVersion', () => {
  it('returns false when the installed release matches the latest release', () => {
    expect(isNewerVersion('0.15.0', '0.15.0')).toBe(false)
  })

  it('returns true when latest has a higher patch', () => {
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true)
  })

  it('returns false when latest has a lower patch', () => {
    expect(isNewerVersion('1.0.0', '1.0.1')).toBe(false)
  })

  it('returns true when latest has a higher minor', () => {
    expect(isNewerVersion('1.1.0', '1.0.9')).toBe(true)
  })

  it('returns false when latest has a lower minor', () => {
    expect(isNewerVersion('1.0.0', '1.1.0')).toBe(false)
  })

  it('returns true when latest has a higher major', () => {
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true)
  })

  it('returns false when latest has a lower major', () => {
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false)
  })

  it('returns true when the release is newer than a prerelease of the same version', () => {
    expect(isNewerVersion('1.0.0', '1.0.0-alpha')).toBe(true)
  })

  it('returns false when latest is a prerelease of the installed release', () => {
    expect(isNewerVersion('1.0.0-beta', '1.0.0')).toBe(false)
  })

  it('returns false when both have the same prerelease label', () => {
    expect(isNewerVersion('1.0.0-alpha', '1.0.0-alpha')).toBe(false)
  })

  it('returns false when latest string is unparseable', () => {
    expect(isNewerVersion('not-a-version', '1.0.0')).toBe(false)
  })

  it('returns false when installed string is unparseable', () => {
    expect(isNewerVersion('1.0.0', 'not-a-version')).toBe(false)
  })
})

// ── pollGithubRelease ─────────────────────────────────────────────────────────

describe('pollGithubRelease', () => {
  it('does not advertise a release to a dev checkout ahead of its tag', async () => {
    const marsDir = await mkdtemp(join(tmpdir(), 'mars-poller-test-'))

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        tag_name: 'v0.15.0',
        html_url: 'https://github.com/ilies-bel/mars/releases/tag/v0.15.0',
      }),
    })

    await pollGithubRelease(marsDir, {
      fetchFn: mockFetch as unknown as typeof fetch,
      installedVersion: '0.15.0-48-gabc1234',
      installRoute: 'dev',
    })

    const cache = JSON.parse(
      await readFile(join(marsDir, 'update.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(cache).toMatchObject({
      installed: '0.15.0-48-gabc1234',
      latest: '0.15.0',
      available: false,
      selfUpdatable: false,
    })
  })

  it('writes update.json with the correct shape on a successful fetch', async () => {
    const marsDir = await mkdtemp(join(tmpdir(), 'mars-poller-test-'))

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        tag_name: 'v1.0.0',
        html_url: 'https://github.com/ilies-bel/mars/releases/tag/v1.0.0',
      }),
    })

    await pollGithubRelease(marsDir, {
      fetchFn: mockFetch as unknown as typeof fetch,
      installedVersion: '0.14.0',
      installRoute: 'prod',
    })

    const raw = await readFile(join(marsDir, 'update.json'), 'utf8')
    const cache = JSON.parse(raw) as Record<string, unknown>

    expect(typeof cache.installed).toBe('string')
    expect(cache.latest).toBe('1.0.0')
    expect(typeof cache.available).toBe('boolean')
    expect(typeof cache.checkedAt).toBe('string')
    expect(cache.releaseUrl).toBe(
      'https://github.com/ilies-bel/mars/releases/tag/v1.0.0',
    )
  })

  it('strips the leading v from tag_name', async () => {
    const marsDir = await mkdtemp(join(tmpdir(), 'mars-poller-test-'))

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        tag_name: 'v2.3.4',
        html_url: 'https://github.com/ilies-bel/mars/releases/tag/v2.3.4',
      }),
    })

    await pollGithubRelease(marsDir, { fetchFn: mockFetch as unknown as typeof fetch })

    const raw = await readFile(join(marsDir, 'update.json'), 'utf8')
    const cache = JSON.parse(raw) as Record<string, unknown>
    expect(cache.latest).toBe('2.3.4')
  })

  it('leaves an existing cache untouched on a network failure', async () => {
    const marsDir = await mkdtemp(join(tmpdir(), 'mars-poller-test-'))
    const existing = JSON.stringify({
      installed: '0.1.0',
      latest: '0.1.0',
      available: false,
      checkedAt: '2026-01-01T00:00:00.000Z',
      releaseUrl: 'https://github.com/ilies-bel/mars/releases/tag/v0.1.0',
    })
    await writeFile(join(marsDir, 'update.json'), existing, 'utf8')

    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'))

    await pollGithubRelease(marsDir, { fetchFn: mockFetch as unknown as typeof fetch })

    const raw = await readFile(join(marsDir, 'update.json'), 'utf8')
    expect(raw).toBe(existing)
  })

  it('leaves an existing cache untouched on a non-200 response', async () => {
    const marsDir = await mkdtemp(join(tmpdir(), 'mars-poller-test-'))
    const existing = JSON.stringify({
      installed: '0.1.0',
      latest: '0.1.0',
      available: false,
      checkedAt: '2026-01-01T00:00:00.000Z',
      releaseUrl: 'https://github.com/ilies-bel/mars/releases/tag/v0.1.0',
    })
    await writeFile(join(marsDir, 'update.json'), existing, 'utf8')

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    })

    await pollGithubRelease(marsDir, { fetchFn: mockFetch as unknown as typeof fetch })

    const raw = await readFile(join(marsDir, 'update.json'), 'utf8')
    expect(raw).toBe(existing)
  })

  it('does not create a cache file when the first poll fails', async () => {
    const marsDir = await mkdtemp(join(tmpdir(), 'mars-poller-test-'))

    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'))

    await pollGithubRelease(marsDir, { fetchFn: mockFetch as unknown as typeof fetch })

    await expect(
      readFile(join(marsDir, 'update.json'), 'utf8'),
    ).rejects.toThrow()
  })

  it('leaves cache untouched when response has unexpected shape', async () => {
    const marsDir = await mkdtemp(join(tmpdir(), 'mars-poller-test-'))
    const existing = JSON.stringify({
      installed: '0.1.0',
      latest: '0.1.0',
      available: false,
      checkedAt: '2026-01-01T00:00:00.000Z',
      releaseUrl: null,
    })
    await writeFile(join(marsDir, 'update.json'), existing, 'utf8')

    // Missing html_url
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ tag_name: 'v1.0.0' }),
    })

    await pollGithubRelease(marsDir, { fetchFn: mockFetch as unknown as typeof fetch })

    const raw = await readFile(join(marsDir, 'update.json'), 'utf8')
    expect(raw).toBe(existing)
  })

  it('reports available=true when the fetched version is newer', async () => {
    const marsDir = await mkdtemp(join(tmpdir(), 'mars-poller-test-'))

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        tag_name: 'v0.15.0',
        html_url: 'https://github.com/ilies-bel/mars/releases/tag/v0.15.0',
      }),
    })

    await pollGithubRelease(marsDir, {
      fetchFn: mockFetch as unknown as typeof fetch,
      installedVersion: '0.14.0',
      installRoute: 'prod',
    })

    const raw = await readFile(join(marsDir, 'update.json'), 'utf8')
    const cache = JSON.parse(raw) as Record<string, unknown>
    expect(cache.available).toBe(true)
  })
})
