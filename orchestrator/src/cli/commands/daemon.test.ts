/**
 * Behavioural tests for the `daemon start` race-prevention fix.
 *
 * The TOCTOU gap: `isDaemonAlive()` only reports true once the socket is
 * connectable, but `spawnDetached` used to return immediately — before the
 * child process had booted, bound its socket, or written the pid file.  A
 * second `mars daemon start` racing within that boot window would see
 * "not alive" and spawn a second child.
 *
 * The fix: `daemon start` now blocks until `isDaemonAlive()` returns true
 * (or a 10s deadline is exceeded) before returning to the user.  This test
 * suite verifies the three observable outcomes through the public CLI seam.
 *
 * System boundaries mocked:
 *  - `../../core/daemon/paths`: `isDaemonAlive` is controllable per-test;
 *    `daemonPaths` and `resolveLaunchCommand` return stable test values.
 *  - `node:child_process`: `spawn` is a no-op stub; we test CLI logic, not
 *    that the OS can fork a process.
 *
 * The branch-warning examples instead use temporary Git repositories: branch
 * identity is the system boundary the command must accurately report.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { InProcessOptions } from '../test-adapter'
import type { OrchestratorContext } from '../../core/context'
import type { DaemonLiveness } from '../../core/daemon/paths'

// ── Mock declarations (must precede the imports they intercept) ──────────────

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

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn(() => ({ unref: vi.fn(), pid: 99999 })),
  }
})

// Must import the mocked versions so vi.mocked() can type them.
import { isDaemonAlive } from '../../core/daemon/paths'
import { spawn } from 'node:child_process'
import { runCommandInProcess, makeFakeDaemon } from '../test-adapter'

// ── Helpers ──────────────────────────────────────────────────────────────────

const fakeCtx: OrchestratorContext = {
  repoRoot: '/fake/repo',
  stateDir: '/fake/repo/.mars',
  queueDbPath: '/fake/repo/.mars/queue.db',
  observabilityDbPath: '/fake/repo/.mars/obs.db',
  stateDbPath: '/fake/repo/.mars/state.db',
}

// A minimal DomainTaskStore that satisfies the type without a DB.
// `daemon start` never calls any store methods, so this is sufficient.
const fakeStore = {} as never

const makeOpts = (repoRoot = fakeCtx.repoRoot): InProcessOptions => ({
  store: fakeStore,
  daemon: makeFakeDaemon(),
  ctx: { ...fakeCtx, repoRoot, stateDir: `${repoRoot}/.mars` },
})

const statusPayload = {
  pid: 5678,
  startedAt: '2026-07-30T00:00:00.000Z',
  inFlight: [],
  counts: { draft: 0, queued: 0, running: 0, verifying: 0, merging: 0, 'vega-reconciling': 0 },
  sourceSha: null,
  currentSha: null,
  isStale: false,
  isPaused: false,
}

const createGitRepo = (branch: string): string => {
  const repo = mkdtempSync(join(tmpdir(), 'mars-daemon-status-'))
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Mars Test'], { cwd: repo })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: repo })
  if (branch !== 'main') {
    execFileSync('git', ['checkout', '--quiet', '-b', branch], { cwd: repo })
  }
  return repo
}

const isDaemonAliveM = vi.mocked(isDaemonAlive)
const spawnM = vi.mocked(spawn)

// ── Test suite ────────────────────────────────────────────────────────────────

describe('daemon start — race prevention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.INTEGRATION_BRANCH
  })

  // Tracer bullet: the most basic observable outcome — daemon already alive.
  it('returns code 0 with pid message when daemon is already running (no spawn)', async () => {
    isDaemonAliveM.mockResolvedValue({ alive: true, pid: 5678 } satisfies DaemonLiveness)

    const result = await runCommandInProcess(['daemon', 'start'], makeOpts())

    expect(result.code).toBe(0)
    expect(result.out.join('\n')).toContain('daemon detached')
    expect(result.out.join('\n')).toContain('5678')
    // Must not spawn a new process when daemon is already live.
    expect(spawnM).not.toHaveBeenCalled()
  })

  // Core fix: daemon start waits for the socket to become alive after spawn.
  it('polls until socket is alive and returns code 0 with pid message', async () => {
    // First call (pre-spawn guard): not alive.
    isDaemonAliveM.mockResolvedValueOnce({ alive: false, reason: 'no-pid' } satisfies DaemonLiveness)
    // Second call (first poll after spawn): daemon is now up.
    isDaemonAliveM.mockResolvedValue({ alive: true, pid: 12345 } satisfies DaemonLiveness)

    const result = await runCommandInProcess(['daemon', 'start'], makeOpts())

    expect(result.code).toBe(0)
    expect(result.out.join('\n')).toContain('daemon detached')
    expect(result.out.join('\n')).toContain('12345')
    // A child process was spawned.
    expect(spawnM).toHaveBeenCalledTimes(1)
    // isDaemonAlive was called at least twice (initial check + at least one poll).
    expect(isDaemonAliveM).toHaveBeenCalledTimes(2)
  })

  // Idempotency: a second daemon start finds the pid from the first's poll.
  it('second daemon start reports the same pid as the already-running daemon', async () => {
    // Both invocations immediately find a live daemon.
    isDaemonAliveM.mockResolvedValue({ alive: true, pid: 7777 } satisfies DaemonLiveness)

    const r1 = await runCommandInProcess(['daemon', 'start'], makeOpts())
    const r2 = await runCommandInProcess(['daemon', 'start'], makeOpts())

    expect(r1.code).toBe(0)
    expect(r2.code).toBe(0)
    // Both report the same pid.
    const pidIn = (out: string[]) => out.join('\n').match(/pid (\d+)/)?.[1]
    expect(pidIn(r1.out)).toBe('7777')
    expect(pidIn(r2.out)).toBe('7777')
    // Neither spawns a new process.
    expect(spawnM).not.toHaveBeenCalled()
  })

  // Timeout path: daemon never becomes alive within the deadline.
  it('returns code 1 with error message when daemon does not become ready within 10s', async () => {
    vi.useFakeTimers()

    isDaemonAliveM.mockResolvedValue({ alive: false, reason: 'no-pid' } satisfies DaemonLiveness)

    const resultPromise = runCommandInProcess(['daemon', 'start'], makeOpts())
    // Advance fake clock past the 10s deadline so the poll loop exits.
    await vi.advanceTimersByTimeAsync(11_000)
    const result = await resultPromise

    expect(result.code).toBe(1)
    // The error message must reference the log file so the operator knows
    // where to look.
    expect(result.err.join('\n')).toMatch(/did not become ready|watch\.log/)
  })

  it('warns when the repo root branch differs from the integration branch', async () => {
    const repo = createGitRepo('feature/x')
    try {
      isDaemonAliveM.mockResolvedValue({ alive: true, pid: 5678 } satisfies DaemonLiveness)
      const result = await runCommandInProcess(
        ['daemon', 'status'],
        {
          ...makeOpts(repo),
          daemon: makeFakeDaemon(() => statusPayload),
        },
      )

      expect(result.code).toBe(0)
      expect(result.out).toContain(
        "warning: repo root is on 'feature/x'; tasks merge into 'main'",
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('does not warn when the repo root is on the integration branch, including an override', async () => {
    const mainRepo = createGitRepo('main')
    const alternateRepo = createGitRepo('release')
    try {
      isDaemonAliveM.mockResolvedValue({ alive: true, pid: 5678 } satisfies DaemonLiveness)
      const onDefaultBranch = await runCommandInProcess(
        ['daemon', 'status'],
        {
          ...makeOpts(mainRepo),
          daemon: makeFakeDaemon(() => statusPayload),
        },
      )

      process.env.INTEGRATION_BRANCH = 'release'
      const onOverriddenBranch = await runCommandInProcess(
        ['daemon', 'status'],
        {
          ...makeOpts(alternateRepo),
          daemon: makeFakeDaemon(() => statusPayload),
        },
      )

      expect(onDefaultBranch.out.join('\n')).not.toContain('warning: repo root is on')
      expect(onOverriddenBranch.out.join('\n')).not.toContain('warning: repo root is on')
    } finally {
      rmSync(mainRepo, { recursive: true, force: true })
      rmSync(alternateRepo, { recursive: true, force: true })
    }
  })
})
