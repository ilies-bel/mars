import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs'

// Auto-mock node:fs so readFileSync is a vi.fn() the tests can control.
vi.mock('node:fs')

import { probeDaemonHealth } from './projectHealth.ts'

describe('probeDaemonHealth', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  // ── port-file absent / malformed → 'down' ──────────────────────────────────

  it('returns "down" when the port file is absent (ENOENT)', async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT' })
    })
    expect(await probeDaemonHealth('/any/repo')).toBe('down')
  })

  it('returns "down" when the port file is empty', async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => '')
    expect(await probeDaemonHealth('/any/repo')).toBe('down')
  })

  it('returns "down" when the port file contains non-numeric content', async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => 'not-a-port')
    expect(await probeDaemonHealth('/any/repo')).toBe('down')
  })

  // ── probe throws → 'down' ──────────────────────────────────────────────────

  it('returns "down" when fetch throws ECONNREFUSED', async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => '9876')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9876'), {
          code: 'ECONNREFUSED',
        }),
      ),
    )
    expect(await probeDaemonHealth('/any/repo')).toBe('down')
  })

  it('returns "down" when fetch is aborted (timeout)', async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => '9876')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError')),
    )
    expect(await probeDaemonHealth('/any/repo')).toBe('down')
  })

  // ── 2xx within degradedMs → 'live' ────────────────────────────────────────

  it('returns "live" on 2xx within degradedMs', async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => '9876')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
    // degradedMs=99999 ensures any instant mock response is always below the threshold
    expect(await probeDaemonHealth('/any/repo', { degradedMs: 99999 })).toBe('live')
  })

  // ── 2xx past degradedMs → 'degraded' ──────────────────────────────────────

  it('returns "degraded" on 2xx past degradedMs', async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => '9876')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
    // degradedMs=0 forces elapsed >= degradedMs for any response, however fast
    expect(await probeDaemonHealth('/any/repo', { degradedMs: 0 })).toBe('degraded')
  })
})
