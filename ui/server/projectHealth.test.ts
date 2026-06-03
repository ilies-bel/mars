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

  // ── hysteresis: slow probes only degrade after sustained slowness ──────────

  it('returns "live" on a single slow-but-reachable probe (hysteresis prevents flicker)', async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => '9876')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
    // degradedMs=0 forces elapsed >= degradedMs for any response, however fast.
    // With hysteresis, a single slow probe must NOT be reported as 'degraded'.
    expect(await probeDaemonHealth('/hysteresis-single', { degradedMs: 0 })).toBe('live')
  })

  it('returns "degraded" after N consecutive slow-but-reachable probes', async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => '9876')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
    // First two calls: streak below threshold → still 'live'
    expect(await probeDaemonHealth('/hysteresis-n', { degradedMs: 0 })).toBe('live')
    expect(await probeDaemonHealth('/hysteresis-n', { degradedMs: 0 })).toBe('live')
    // Third call: streak reaches DEGRADED_STREAK_THRESHOLD (3) → 'degraded'
    expect(await probeDaemonHealth('/hysteresis-n', { degradedMs: 0 })).toBe('degraded')
  })

  it('resets to "live" when a fast probe follows a slow streak', async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => '9876')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
    // Build streak up to 'degraded'
    await probeDaemonHealth('/hysteresis-reset', { degradedMs: 0 })
    await probeDaemonHealth('/hysteresis-reset', { degradedMs: 0 })
    await probeDaemonHealth('/hysteresis-reset', { degradedMs: 0 })
    // A single fast probe must reset the streak and report 'live'
    expect(await probeDaemonHealth('/hysteresis-reset', { degradedMs: 99999 })).toBe('live')
  })

  it('returns "down" immediately on fetch failure regardless of prior slow streak', async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => '9876')
    // Prime a streak with a couple of slow probes
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
    await probeDaemonHealth('/hysteresis-down', { degradedMs: 0 })
    // Now simulate a connection failure — 'down' must be reported immediately
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      ),
    )
    expect(await probeDaemonHealth('/hysteresis-down', { degradedMs: 0 })).toBe('down')
  })
})
