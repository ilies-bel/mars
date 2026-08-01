import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchChatLayoutPreference, putChatLayoutPreference } from './api'

afterEach(() => vi.unstubAllGlobals())

const okResponse = (body: unknown): Response => ({
  ok: true,
  json: async () => body,
  headers: new Headers({ 'content-type': 'application/json' }),
}) as Response

describe('chat layout preference API', () => {
  it('loads the daemon-backed focus default', async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse({ layout: 'focus' }))
    vi.stubGlobal('fetch', fetch)

    await expect(fetchChatLayoutPreference()).resolves.toEqual({ layout: 'focus' })
    expect(fetch).toHaveBeenCalledWith('/api/preferences/chat-layout', undefined)
  })

  it('persists a threads selection through the shared preference endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse({ layout: 'threads' }))
    vi.stubGlobal('fetch', fetch)

    await expect(putChatLayoutPreference('threads')).resolves.toEqual({ layout: 'threads' })
    expect(fetch).toHaveBeenCalledWith('/api/preferences/chat-layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout: 'threads' }),
    })
  })
})
