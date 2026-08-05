/**
 * Behavioural CLI tests for the signature-storm circuit breaker surface:
 *   - `daemon status` reports the breaker state (tripped / active streak / idle)
 *   - `daemon reset-breaker` clears the durable flag and resumes dispatch when
 *     the storm was the active pause cause
 *
 * System boundaries mocked:
 *  - `../../core/daemon/paths`: isDaemonAlive is controllable per-test.
 *  - daemon client: driven via makeFakeDaemon with a canned responder.
 *
 * All assertions are on CLI *output* — the observable behaviour for an operator
 * running these commands. Internal state (DB row, in-memory pause) is covered
 * by the RPC-seam tests in __tests__/rpc-seam.test.ts.
 */

import { describe, it, expect, vi } from 'vitest'
import type { OrchestratorContext } from '../../../core/context'
import type { InProcessOptions } from '../../test-adapter'

// ── Mock declarations (must precede the imports they intercept) ───────────────

vi.mock('../../../core/daemon/paths', () => ({
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
}))

vi.mock('../../../core/lib/repo-root-branch-warning', () => ({
  warnWhenRepoRootDiffersFromIntegration: vi.fn(),
}))

import { isDaemonAlive } from '../../../core/daemon/paths'
import { runCommandInProcess, makeFakeDaemon } from '../../test-adapter'

const isDaemonAliveMock = vi.mocked(isDaemonAlive)

const fakeCtx: OrchestratorContext = {
  repoRoot: '/fake/repo',
  stateDir: '/fake/repo/.mars',
  queueDbPath: '/fake/repo/.mars/queue.db',
  observabilityDbPath: '/fake/repo/.mars/obs.db',
  stateDbPath: '/fake/repo/.mars/state.db',
}

const fakeStore = {} as never

/** A minimal canned status payload covering the fields daemon.ts reads. */
const baseStatus = {
  pid: 12345,
  startedAt: '2026-08-05T00:00:00.000Z',
  inFlight: [],
  counts: {
    draft: 0,
    queued: 0,
    running: 0,
    verifying: 0,
    merging: 0,
    'vega-reconciling': 0,
  },
  implementCap: { configured: 12, effective: 12, reason: null },
  sourceSha: null,
  currentSha: null,
  isStale: false,
  pause: { paused: false, reason: null, since: null, detail: null },
}

const makeOpts = (
  responder?: Parameters<typeof makeFakeDaemon>[0],
): InProcessOptions => ({
  store: fakeStore,
  daemon: makeFakeDaemon(responder),
  ctx: fakeCtx,
})

// ── daemon status — signatureStorm display ────────────────────────────────────

describe('daemon status — storm-breaker state', () => {
  it('reports TRIPPED with hint to run reset-breaker when breaker is tripped', async () => {
    isDaemonAliveMock.mockResolvedValue({ alive: true, pid: 12345 })

    const result = await runCommandInProcess(
      ['daemon', 'status'],
      makeOpts(() => ({
        ...baseStatus,
        signatureStorm: {
          tripped: true,
          signature: 'code:coder-exit-nonzero/unclassified',
          streak: 3,
          lastTaskId: 'mars-abc',
        },
      })),
    )

    expect(result.code).toBe(0)
    const combined = result.out.join('\n')
    expect(combined).toContain('TRIPPED')
    expect(combined).toContain('code:coder-exit-nonzero/unclassified')
    expect(combined).toContain('streak=3')
    expect(combined).toContain('reset-breaker')
  })

  it('reports active (non-tripped) streak when streak > 0 but not yet tripped', async () => {
    isDaemonAliveMock.mockResolvedValue({ alive: true, pid: 12345 })

    const result = await runCommandInProcess(
      ['daemon', 'status'],
      makeOpts(() => ({
        ...baseStatus,
        signatureStorm: {
          tripped: false,
          signature: 'verify:typecheck/typecheck-cannot-find-name',
          streak: 2,
          lastTaskId: 'mars-def',
        },
      })),
    )

    expect(result.code).toBe(0)
    const combined = result.out.join('\n')
    expect(combined).not.toContain('TRIPPED')
    expect(combined).toContain('streak=2')
    expect(combined).toContain('not tripped')
  })

  it('reports ok with no active streak when streak is 0', async () => {
    isDaemonAliveMock.mockResolvedValue({ alive: true, pid: 12345 })

    const result = await runCommandInProcess(
      ['daemon', 'status'],
      makeOpts(() => ({
        ...baseStatus,
        signatureStorm: {
          tripped: false,
          signature: null,
          streak: 0,
          lastTaskId: null,
        },
      })),
    )

    expect(result.code).toBe(0)
    const combined = result.out.join('\n')
    expect(combined).toContain('storm-breaker')
    expect(combined).toContain('no active streak')
  })
})

// ── daemon reset-breaker ──────────────────────────────────────────────────────

describe('daemon reset-breaker', () => {
  it('reports storm cleared and dispatch resumed when storm was the active cause', async () => {
    isDaemonAliveMock.mockResolvedValue({ alive: true, pid: 12345 })

    const result = await runCommandInProcess(
      ['daemon', 'reset-breaker'],
      makeOpts(() => ({ cleared: true, resumedDispatch: true })),
    )

    expect(result.code).toBe(0)
    expect(result.err).toHaveLength(0)
    expect(result.out.join('\n')).toContain('dispatch resumed')
  })

  it('reports storm cleared without resuming dispatch when storm was not the active pause', async () => {
    isDaemonAliveMock.mockResolvedValue({ alive: true, pid: 12345 })

    const result = await runCommandInProcess(
      ['daemon', 'reset-breaker'],
      makeOpts(() => ({ cleared: true, resumedDispatch: false })),
    )

    expect(result.code).toBe(0)
    expect(result.err).toHaveLength(0)
    expect(result.out.join('\n')).not.toContain('dispatch resumed')
    expect(result.out.join('\n')).toContain('storm-breaker cleared')
  })

  it('returns code 1 when the daemon is not running', async () => {
    isDaemonAliveMock.mockResolvedValue({ alive: false, reason: 'no-pid' as const })

    const result = await runCommandInProcess(
      ['daemon', 'reset-breaker'],
      makeOpts(),
    )

    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('daemon not running')
  })
})
