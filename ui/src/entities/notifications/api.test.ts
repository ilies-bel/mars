/**
 * Unit tests for the notifications preference API layer.
 *
 * Verifies that:
 *   - fetchNotificationsPreference() GETs the right URL and parses the response
 *   - putNotificationsPreference() PUTs the correct payload to the daemon
 *
 * fetch is stubbed at the global level so no real daemon is needed.
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetchNotificationsPreference, putNotificationsPreference } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Build a minimal ok Response stub for a given JSON body. */
const okResponse = (body: unknown): Response =>
  ({
    ok: true,
    json: async () => body,
  }) as Response

// ---------------------------------------------------------------------------
// fetchNotificationsPreference
// ---------------------------------------------------------------------------

describe('fetchNotificationsPreference', () => {
  it('GETs /api/preferences/notifications', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse({ enabled: true }))
    vi.stubGlobal('fetch', mockFetch)

    await fetchNotificationsPreference()

    expect(mockFetch).toHaveBeenCalledWith('/api/preferences/notifications')
  })

  it('returns enabled=true when the daemon responds with true (daemon default)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ enabled: true })))

    const result = await fetchNotificationsPreference()

    expect(result).toEqual({ enabled: true })
  })

  it('returns enabled=false when the daemon has the preference disabled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ enabled: false })))

    const result = await fetchNotificationsPreference()

    expect(result).toEqual({ enabled: false })
  })

  it('throws when the daemon responds with a non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response))

    await expect(fetchNotificationsPreference()).rejects.toThrow(
      'GET /api/preferences/notifications → 500',
    )
  })
})

// ---------------------------------------------------------------------------
// putNotificationsPreference — this is the mutator the NavBar calls on click
// ---------------------------------------------------------------------------

describe('putNotificationsPreference', () => {
  it('PUTs to /api/preferences/notifications with { enabled: false } when turning off', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse({ enabled: false }))
    vi.stubGlobal('fetch', mockFetch)

    await putNotificationsPreference(false)

    expect(mockFetch).toHaveBeenCalledWith('/api/preferences/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
  })

  it('PUTs to /api/preferences/notifications with { enabled: true } when turning on', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse({ enabled: true }))
    vi.stubGlobal('fetch', mockFetch)

    await putNotificationsPreference(true)

    expect(mockFetch).toHaveBeenCalledWith('/api/preferences/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
  })

  it('returns the updated preference from the daemon response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ enabled: false })))

    const result = await putNotificationsPreference(false)

    expect(result).toEqual({ enabled: false })
  })

  it('throws when the daemon responds with a non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 } as Response))

    await expect(putNotificationsPreference(true)).rejects.toThrow(
      'PUT /api/preferences/notifications → 400',
    )
  })
})
