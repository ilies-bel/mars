/**
 * Tests for the daemon startup guard (ADR-0XXX: split-brain prevention).
 *
 * Two observable behaviors are tested:
 *
 * 1. **Lockfile guard** — `startDaemon` exits nonzero when daemon.lock holds a
 *    live PID, naming the holder in the log. This prevents a second concurrent
 *    daemon start from running split-brain against the incumbent.
 *
 * 2. **Kill-and-wait** — `startDaemon` sends SIGTERM to a live prior process
 *    found in the pid file and waits for it to exit before proceeding with
 *    full startup. This closes the race where `daemon restart` spawns a new
 *    daemon while the old one is still holding DB connections mid-shutdown.
 *
 * Both tests use a real tmpdir + git repo so `resolveContext()` / `daemonPaths()`
 * resolve correctly. They isolate module state via `vi.resetModules()` so
 * successive tests don't share cached singletons.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { isProcessAlive } from '../paths'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-start-guard-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('daemon startup guard', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_DISABLE_DUCKDB
    vi.restoreAllMocks()
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Tracer bullet: lockfile guard ─────────────────────────────────────────

  it('exits(1) when daemon.lock holds a live pid, naming the holder in the log', async () => {
    const lockFile = resolve(repo, '.mars', 'daemon.lock')
    // Simulate an incumbent daemon by writing our own (live) PID to the lock.
    writeFileSync(lockFile, String(process.pid), 'utf8')

    // Spy on process.exit to prevent the test process from dying and to capture
    // the exit code. Throw so startDaemon's promise rejects instead of the
    // process actually terminating.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code as number})`)
    })

    const logLines: string[] = []
    const log = (line: string): void => { logLines.push(line) }

    vi.resetModules()
    process.env.MARS_REPO = repo
    const { startDaemon } = (await import('../server')) as typeof import('../server')

    await expect(startDaemon({ log })).rejects.toThrow('process.exit(1)')
    expect(exitSpy).toHaveBeenCalledWith(1)
    // The log must name the incumbent pid so the operator knows which process
    // holds the lock.
    expect(logLines.some((l) => l.includes(String(process.pid)))).toBe(true)
  })

  // ── Kill-and-wait: live prior process is terminated before startup ─────────

  it('sends SIGTERM to a live prior pid in the pid file and waits for it to exit', async () => {
    const pidFile = resolve(repo, '.mars', 'watch.pid')

    // Start a real background process to simulate the old daemon.
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60000)'],
      { detached: true, stdio: 'ignore' },
    )
    child.unref()
    const priorPid = child.pid!

    // Write the live pid to the pid file (no socket file, no lockfile).
    writeFileSync(pidFile, String(priorPid), 'utf8')

    // Spy on process.kill so we can confirm SIGTERM was sent.
    const killSpy = vi.spyOn(process, 'kill')

    // Mock process.exit to a no-op so startDaemon can proceed through startup
    // without exiting the test runner. DuckDB is disabled so the probe doesn't
    // run; the remaining startup (pglite DB, UDS socket, HTTP) will proceed
    // normally in the test environment. If startup itself fails for an
    // unrelated reason, we catch it — the assertion that matters is that the
    // prior pid was killed.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(
      (_code?: string | number | null) => undefined as never,
    )

    vi.resetModules()
    process.env.MARS_REPO = repo
    process.env.MARS_DISABLE_DUCKDB = '1'

    type ServerModule = typeof import('../server')
    type DaemonHandle = Awaited<ReturnType<ServerModule['startDaemon']>>
    let handle: DaemonHandle | null = null
    try {
      const { startDaemon } = (await import('../server')) as ServerModule
      handle = await startDaemon({ log: () => {} })
    } catch {
      // Startup may fail after the kill-and-wait completes (e.g. git check,
      // UDS socket binding) — the kill-and-wait behavior is the observable
      // outcome under test, not a successful full startup.
    } finally {
      // Best-effort cleanup: stop the daemon if it started.
      if (handle !== null) {
        await handle.stop(true)
      }
    }

    // SIGTERM was sent to the prior process (process.kill is the hook).
    expect(killSpy).toHaveBeenCalledWith(priorPid, 'SIGTERM')
    // After waitForProcessExit completes, the prior process must be dead.
    expect(isProcessAlive(priorPid)).toBe(false)

    void exitSpy // referenced to suppress unused-var lint
  })
})
