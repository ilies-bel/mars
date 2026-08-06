/**
 * Behavioural tests for `daemon set-cap`.
 *
 * System boundaries mocked:
 *  - `../../core/daemon/config`: readDaemonConfigFile and patchDaemonConfigFile
 *    are controllable per-test; no real filesystem writes.
 *  - `../../core/daemon/paths`: stable stubs so the module loads cleanly.
 *  - daemon client: controlled via makeFakeDaemon (throws or returns canned response).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { InProcessOptions } from '../test-adapter'
import type { OrchestratorContext } from '../../core/context'

// ── Mock declarations (must precede the imports they intercept) ───────────────

vi.mock('../../core/daemon/paths', () => ({
  isDaemonAlive: vi.fn(),
  daemonPaths: vi.fn(() => ({
    socket: '/tmp/mars-test-daemon.sock',
    pidFile: '/tmp/mars-test-daemon.pid',
    logFile: '/tmp/mars-test-daemon/watch.log',
    httpPortFile: '/tmp/mars-test-daemon/http.port',
    runningMarker: '/tmp/mars-test-daemon/running.json',
    crashMarker: '/tmp/mars-test-daemon/crash.json',
    lockFile: '/tmp/mars-test-daemon/daemon.lock',
  })),
  resolveLaunchCommand: vi.fn(() => ({
    command: process.execPath,
    baseArgs: ['-e', 'process.exit(0)'],
  })),
}))

vi.mock('../../core/daemon/config', () => ({
  readDaemonConfigFile: vi.fn(),
  patchDaemonConfigFile: vi.fn(),
  daemonConfigPath: vi.fn(() => '/fake/.mars/daemon.json'),
}))

import { readDaemonConfigFile, patchDaemonConfigFile } from '../../core/daemon/config'
import { runCommandInProcess, makeFakeDaemon } from '../test-adapter'

// ── Helpers ───────────────────────────────────────────────────────────────────

const fakeCtx: OrchestratorContext = {
  repoRoot: '/fake/repo',
  stateDir: '/fake/repo/.mars',
  queueDbPath: '/fake/repo/.mars/queue.db',
  observabilityDbPath: '/fake/repo/.mars/obs.db',
  stateDbPath: '/fake/repo/.mars/state.db',
}

const fakeStore = {} as never

const makeOpts = (
  responder?: Parameters<typeof makeFakeDaemon>[0],
): InProcessOptions => ({
  store: fakeStore,
  daemon: makeFakeDaemon(responder),
  ctx: fakeCtx,
})

/** A canned reload-config response matching what the daemon sends back. */
const reloadResponse = {
  caps: { implement: 8, triage: 8, refine: 6, 'setup-install': 2, verify: 2 },
}

const readM = vi.mocked(readDaemonConfigFile)
const patchM = vi.mocked(patchDaemonConfigFile)

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('daemon set-cap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readM.mockReturnValue({})
    patchM.mockReturnValue({})
  })

  it('writes the named cap and hot-reloads the running daemon', async () => {
    readM.mockReturnValue({ caps: { implement: 12, triage: 8 } })

    const result = await runCommandInProcess(
      ['daemon', 'set-cap', 'implement', '8'],
      makeOpts(() => reloadResponse),
    )

    expect(result.code).toBe(0)
    expect(patchM).toHaveBeenCalledTimes(1)
    const patchArg = patchM.mock.calls[0]?.[0] as Record<string, unknown>
    const caps = patchArg.caps as Record<string, unknown>
    expect(caps.implement).toBe(8)
    expect(result.out.join('\n')).toContain('concurrency reloaded')
    expect(result.out.join('\n')).toContain('implement=8')
  })

  it('merge-patch preserves other cap values when only one cap changes', async () => {
    readM.mockReturnValue({
      caps: { implement: 12, triage: 8, refine: 6 },
      selfEvolve: { autoTrigger: true },
      defaultProvider: 'claude',
    })

    await runCommandInProcess(
      ['daemon', 'set-cap', 'triage', '4'],
      makeOpts(() => reloadResponse),
    )

    // patchDaemonConfigFile receives only { caps: ... }, not selfEvolve or defaultProvider —
    // the function itself is responsible for preserving other top-level keys.
    const patchArg = patchM.mock.calls[0]?.[0] as Record<string, unknown>
    expect(Object.keys(patchArg)).toEqual(['caps'])
    const caps = patchArg.caps as Record<string, unknown>
    // Changed cap
    expect(caps.triage).toBe(4)
    // Unchanged caps are preserved from the read
    expect(caps.implement).toBe(12)
    expect(caps.refine).toBe(6)
  })

  it('rejects an unknown cap name with code 2', async () => {
    const result = await runCommandInProcess(
      ['daemon', 'set-cap', 'unknown-cap', '5'],
      makeOpts(),
    )

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain('unknown cap')
    expect(result.err.join('\n')).toContain('unknown-cap')
    expect(patchM).not.toHaveBeenCalled()
  })

  it('rejects a zero value with code 2', async () => {
    const result = await runCommandInProcess(
      ['daemon', 'set-cap', 'implement', '0'],
      makeOpts(),
    )

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain('positive integer')
    expect(patchM).not.toHaveBeenCalled()
  })

  it('rejects a negative value with code 2', async () => {
    const result = await runCommandInProcess(
      ['daemon', 'set-cap', 'implement', '-3'],
      makeOpts(),
    )

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain('positive integer')
    expect(patchM).not.toHaveBeenCalled()
  })

  it('rejects a non-integer value with code 2', async () => {
    const result = await runCommandInProcess(
      ['daemon', 'set-cap', 'implement', 'abc'],
      makeOpts(),
    )

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain('positive integer')
    expect(patchM).not.toHaveBeenCalled()
  })

  it('writes file and returns code 0 when daemon is not running', async () => {
    const result = await runCommandInProcess(
      ['daemon', 'set-cap', 'implement', '3'],
      makeOpts(() => {
        throw new Error('daemon not running')
      }),
    )

    expect(result.code).toBe(0)
    expect(patchM).toHaveBeenCalledTimes(1)
    expect(result.out.join('\n')).toMatch(/will apply on next daemon start/i)
    // No error output — daemon-down is expected and handled gracefully
    expect(result.err).toHaveLength(0)
  })

  it('rejects structured-write as an unknown cap name (removed)', async () => {
    const result = await runCommandInProcess(
      ['daemon', 'set-cap', 'structured-write', '2'],
      makeOpts(),
    )

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain('unknown cap')
    expect(result.err.join('\n')).toContain('structured-write')
    expect(patchM).not.toHaveBeenCalled()
  })

  it('maps kebab-case setup-install to camelCase setupInstall in the JSON', async () => {
    readM.mockReturnValue({ caps: {} })

    await runCommandInProcess(
      ['daemon', 'set-cap', 'setup-install', '4'],
      makeOpts(() => reloadResponse),
    )

    const patchArg = patchM.mock.calls[0]?.[0] as Record<string, unknown>
    const caps = patchArg.caps as Record<string, unknown>
    expect(caps.setupInstall).toBe(4)
    expect(caps['setup-install']).toBeUndefined()
  })

  it('writes the verify cap and reports its reloaded value', async () => {
    await runCommandInProcess(
      ['daemon', 'set-cap', 'verify', '1'],
      makeOpts(() => reloadResponse),
    )

    const patchArg = patchM.mock.calls[0]?.[0] as Record<string, unknown>
    const caps = patchArg.caps as Record<string, unknown>
    expect(caps.verify).toBe(1)
  })
})
