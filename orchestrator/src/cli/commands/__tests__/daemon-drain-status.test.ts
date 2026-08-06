/**
 * Behavioural CLI tests for the drain-state surface of `mars daemon status`.
 *
 * When the daemon is draining (`acceptingWork === false`) the status output
 * must:
 *  - announce the drain state and the remaining in-flight count prominently
 *  - suppress the "run `mars daemon restart`" staleness advice (restart aborts
 *    in-flight tasks; `kill` is the correct escape hatch)
 *  - instead mention to wait for drain to complete before restarting
 *
 * System boundaries mocked:
 *  - `../../core/daemon/paths`: isDaemonAlive is controllable per-test.
 *  - daemon client: driven via makeFakeDaemon with a canned responder.
 */

import { describe, it, expect, vi } from 'vitest'
import type { OrchestratorContext } from '../../../core/context'
import type { InProcessOptions } from '../../test-adapter'

vi.mock('../../../core/daemon/paths', () => ({
  isDaemonAlive: vi.fn(),
  daemonPaths: vi.fn(() => ({
    socket: '/tmp/mars-drain-test.sock',
    pidFile: '/tmp/mars-drain-test.pid',
    logFile: '/tmp/mars-drain-test/watch.log',
    httpPortFile: '/tmp/mars-drain-test/http.port',
    runningMarker: '/tmp/mars-drain-test/running.json',
    crashMarker: '/tmp/mars-drain-test/crash.json',
    lockFile: '/tmp/mars-drain-test/daemon.lock',
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
  draining: false,
  signatureStorm: { tripped: false, signature: null, streak: 0, lastTaskId: null },
}

const makeOpts = (
  responder?: Parameters<typeof makeFakeDaemon>[0],
): InProcessOptions => ({
  store: fakeStore,
  daemon: makeFakeDaemon(responder),
  ctx: fakeCtx,
})

describe('daemon status — drain state', () => {
  it('shows DRAINING banner with in-flight count when daemon is draining', async () => {
    isDaemonAliveMock.mockResolvedValue({ alive: true, pid: 12345 })

    const result = await runCommandInProcess(
      ['daemon', 'status'],
      makeOpts(() => ({
        ...baseStatus,
        draining: true,
        inFlight: [
          { taskId: 'mars-aaa', kind: 'implement' },
          { taskId: 'mars-bbb', kind: 'implement' },
        ],
      })),
    )

    expect(result.code).toBe(0)
    const combined = result.out.join('\n')
    expect(combined).toContain('DRAINING')
    expect(combined).toContain('2 in-flight task(s) remaining')
    expect(combined).toContain('mars daemon kill')
  })

  it('does NOT show DRAINING banner when not draining', async () => {
    isDaemonAliveMock.mockResolvedValue({ alive: true, pid: 12345 })

    const result = await runCommandInProcess(
      ['daemon', 'status'],
      makeOpts(() => ({ ...baseStatus, draining: false })),
    )

    expect(result.code).toBe(0)
    const combined = result.out.join('\n')
    expect(combined).not.toContain('DRAINING')
  })

  it('suppresses `mars daemon restart` advice while draining (restart aborts in-flight work)', async () => {
    isDaemonAliveMock.mockResolvedValue({ alive: true, pid: 12345 })

    const result = await runCommandInProcess(
      ['daemon', 'status'],
      makeOpts(() => ({
        ...baseStatus,
        draining: true,
        isStale: true,
        sourceSha: 'abc1234567',
        currentSha: 'def9876543',
        inFlight: [{ taskId: 'mars-ccc', kind: 'implement' }],
      })),
    )

    expect(result.code).toBe(0)
    const combined = result.out.join('\n')
    // Must NOT say "run `mars daemon restart`" while draining
    expect(combined).not.toMatch(/run `mars daemon restart`/)
    // Should still mention the staleness but not the destructive verb
    expect(combined).toContain('abc1234')
    expect(combined).toContain('def9876')
  })

  it('shows `mars daemon restart` advice when stale and NOT draining', async () => {
    isDaemonAliveMock.mockResolvedValue({ alive: true, pid: 12345 })

    const result = await runCommandInProcess(
      ['daemon', 'status'],
      makeOpts(() => ({
        ...baseStatus,
        draining: false,
        isStale: true,
        sourceSha: 'abc1234567',
        currentSha: 'def9876543',
      })),
    )

    expect(result.code).toBe(0)
    const combined = result.out.join('\n')
    expect(combined).toContain('run `mars daemon restart`')
  })

  it('works with legacy daemons that do not include draining in the status payload', async () => {
    isDaemonAliveMock.mockResolvedValue({ alive: true, pid: 12345 })

    // A daemon that predates the draining field returns a payload without it.
    const { draining: _omit, ...legacyStatus } = baseStatus
    const result = await runCommandInProcess(
      ['daemon', 'status'],
      makeOpts(() => legacyStatus),
    )

    expect(result.code).toBe(0)
    // Should not crash and should not show a drain banner.
    const combined = result.out.join('\n')
    expect(combined).not.toContain('DRAINING')
  })
})
