/**
 * Behavioural tests for `daemon set-lever <name> autonomy <level>` and the
 * daemon config reader's lever autonomy_level round-trip.
 *
 * System boundaries mocked:
 *  - `../../core/daemon/config`: readDaemonConfigFile and patchDaemonConfigFile
 *    are controllable per-test; no real filesystem writes.
 *  - `../../core/daemon/paths`: stable stubs so the module loads cleanly.
 *  - daemon client: controlled via makeFakeDaemon.
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
  persistLeverAutonomyLevel: vi.fn(),
  readLeverAutonomyLevel: vi.fn(),
  daemonConfigPath: vi.fn(() => '/fake/.mars/daemon.json'),
}))

import {
  readDaemonConfigFile,
  patchDaemonConfigFile,
  persistLeverAutonomyLevel,
} from '../../core/daemon/config'
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

const makeOpts = (): InProcessOptions => ({
  store: fakeStore,
  daemon: makeFakeDaemon(),
  ctx: fakeCtx,
})

const persistM = vi.mocked(persistLeverAutonomyLevel)
const readM = vi.mocked(readDaemonConfigFile)
const patchM = vi.mocked(patchDaemonConfigFile)

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('daemon set-lever autonomy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readM.mockReturnValue({})
    patchM.mockReturnValue({})
    persistM.mockReturnValue(undefined)
  })

  it('persists autonomy=tell for a named lever', async () => {
    const result = await runCommandInProcess(
      ['daemon', 'set-lever', 'recovery', 'autonomy', 'tell'],
      makeOpts(),
    )

    expect(result.code).toBe(0)
    expect(persistM).toHaveBeenCalledWith('recovery', 'tell')
    expect(result.out.join('\n')).toContain('lever recovery autonomy=tell')
  })

  it('persists autonomy=off for a named lever', async () => {
    const result = await runCommandInProcess(
      ['daemon', 'set-lever', 'chat', 'autonomy', 'off'],
      makeOpts(),
    )

    expect(result.code).toBe(0)
    expect(persistM).toHaveBeenCalledWith('chat', 'off')
    expect(result.out.join('\n')).toContain('lever chat autonomy=off')
  })

  it('persists autonomy=ask for a named lever', async () => {
    const result = await runCommandInProcess(
      ['daemon', 'set-lever', 'scoring', 'autonomy', 'ask'],
      makeOpts(),
    )

    expect(result.code).toBe(0)
    expect(persistM).toHaveBeenCalledWith('scoring', 'ask')
  })

  it('rejects the retired silent autonomy value with the valid set', async () => {
    const result = await runCommandInProcess(
      ['daemon', 'set-lever', 'recovery', 'autonomy', 'silent'],
      makeOpts(),
    )

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain("'off', 'ask', or 'tell'")
    expect(persistM).not.toHaveBeenCalled()
  })

  it('rejects missing arguments with code 2 and usage hint', async () => {
    const result = await runCommandInProcess(
      ['daemon', 'set-lever', 'recovery'],
      makeOpts(),
    )

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain('usage:')
    expect(persistM).not.toHaveBeenCalled()
  })

  it('rejects wrong property name with code 2', async () => {
    const result = await runCommandInProcess(
      ['daemon', 'set-lever', 'recovery', 'enabled', 'on'],
      makeOpts(),
    )

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain('usage:')
    expect(persistM).not.toHaveBeenCalled()
  })
})

describe('leverSchema round-trip', () => {
  it('defaults autonomy_level to ask when field is omitted', async () => {
    // Import the real module (bypassing the vi.mock above) to test the schema
    // default directly — no filesystem side effects.
    const { leverSchema } = await vi.importActual<
      typeof import('../../core/daemon/config')
    >('../../core/daemon/config')

    const entry = leverSchema.parse({})
    expect(entry.autonomy_level).toBe('ask')
  })

  it('preserves an explicitly set autonomy_level=tell', async () => {
    const { leverSchema } = await vi.importActual<
      typeof import('../../core/daemon/config')
    >('../../core/daemon/config')

    const entry = leverSchema.parse({ autonomy_level: 'tell' })
    expect(entry.autonomy_level).toBe('tell')
  })

  it('preserves an explicitly set autonomy_level=off', async () => {
    const { leverSchema } = await vi.importActual<
      typeof import('../../core/daemon/config')
    >('../../core/daemon/config')

    const entry = leverSchema.parse({ autonomy_level: 'off' })
    expect(entry.autonomy_level).toBe('off')
  })
})
