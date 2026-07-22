/**
 * Regression tests for subprocess spawning in runSubprocessStreaming:
 *
 * 1. process-group kill: killing a spawned worker reaps the entire process-group
 *    subtree, not just the direct child PID.
 *
 *    Before the fix, `onAbort` and `killAllChildren` signalled only the direct
 *    child PID.  Descendants (npm → vitest → fork children) were reparented to
 *    launchd / init and kept running.  This was observed live as 41 orphaned
 *    vitest forks that survived a daemon restart, pinning the host at high load.
 *
 * 2. onSpawn PID notification: `runSubprocessStreaming` invokes the optional
 *    `onSpawn` callback with the child's OS PID immediately after spawn.
 *    The dispatch path (`dispatchImplement` in server.ts) wires this callback to
 *    `tracker.recordPid(taskId, pid)` so the phantom-task watchdog can use PID
 *    liveness (dead-pid detection and heartbeat-guarded ceiling) instead of
 *    falling back to the bare wall-clock ceiling on `task.updatedAt`, which was
 *    the root cause of the 2026-07-20 failure storm.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { killAllChildren, runSubprocessStreaming } from '../git/claude'
import { createTaskFlightTracker } from '../../daemon/task-flight-tracker'

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Returns true when the process is dead (ESRCH), false if it is still alive. */
const isGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

// ─── stub install ─────────────────────────────────────────────────────────────

// Stub script: spawns a long-lived grandchild (sleep 30), prints its PID to
// stdout, then waits.  The `wait` keeps the parent shell alive so the
// grandchild stays in the same process group as the direct child.
const STUB_CONTENT = `#!/bin/sh
sleep 30 &
GRANDCHILD_PID=$!
printf 'GRANDCHILD=%s\\n' "$GRANDCHILD_PID"
wait
`

let stubDir: string
let stubPath: string

beforeAll(() => {
  stubDir = mkdtempSync(resolve(tmpdir(), 'mars-pgkill-test-'))
  stubPath = resolve(stubDir, 'pgkill-stub')
  writeFileSync(stubPath, STUB_CONTENT, 'utf8')
  chmodSync(stubPath, 0o755)
})

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true })
})

// ─── tests ────────────────────────────────────────────────────────────────────

describe('process-group kill reaps grandchildren', () => {
  /**
   * onAbort path: abort signal fires while the worker is running; the handler
   * must kill the whole process group, not just the direct child PID.
   */
  it('onAbort via AbortSignal kills the grandchild', async () => {
    const abort = new AbortController()

    // Resolve as soon as we read the grandchild PID from stdout.
    let resolveGrandchildPid!: (pid: number) => void
    const grandchildPidPromise = new Promise<number>(
      (res) => { resolveGrandchildPid = res },
    )

    const runPromise = runSubprocessStreaming(
      stubPath,
      [],
      process.cwd(),
      ({ stream, line }) => {
        if (stream !== 'stdout') return
        const m = line.match(/^GRANDCHILD=(\d+)$/)
        if (m) {
          resolveGrandchildPid(parseInt(m[1], 10))
          // Fire the abort AFTER we captured the PID so the onAbort handler
          // runs with a valid group to kill.
          abort.abort()
        }
      },
      abort.signal,
    )

    const grandchildPid = await grandchildPidPromise

    // runSubprocessStreaming must resolve once the group is dead.
    await runPromise

    // Small grace period for the OS to reap the process-group entries.
    await new Promise((r) => setTimeout(r, 100))

    expect(isGone(grandchildPid)).toBe(true)
  }, 15_000)

  /**
   * killAllChildren path: used by `mars daemon kill`; must also signal the
   * entire process group for every tracked worker PID.
   */
  it('killAllChildren kills the grandchild', async () => {
    // Resolve as soon as we read the grandchild PID from stdout.
    let resolveGrandchildPid!: (pid: number) => void
    const grandchildPidPromise = new Promise<number>(
      (res) => { resolveGrandchildPid = res },
    )

    const runPromise = runSubprocessStreaming(
      stubPath,
      [],
      process.cwd(),
      ({ stream, line }) => {
        if (stream !== 'stdout') return
        const m = line.match(/^GRANDCHILD=(\d+)$/)
        if (m) {
          resolveGrandchildPid(parseInt(m[1], 10))
        }
      },
      // No abort signal — kill via killAllChildren instead.
    )

    const grandchildPid = await grandchildPidPromise

    // Kill all tracked workers (direct child + their process groups).
    const killed = killAllChildren()
    expect(killed.length).toBeGreaterThan(0)

    // runSubprocessStreaming resolves once the direct child's 'close' fires.
    await runPromise

    // Small grace period for the OS to reap the process-group entries.
    await new Promise((r) => setTimeout(r, 100))

    expect(isGone(grandchildPid)).toBe(true)
  }, 15_000)
})

// ── onSpawn PID notification (phantom-watchdog fix) ──────────────────────────
//
// Regression tests for the fix that wires tracker.recordPid() into the
// dispatch path so the phantom-task watchdog can use PID liveness instead of
// the bare wall-clock ceiling. Root cause of the 2026-07-20 failure storm.

describe('runSubprocessStreaming — onSpawn PID callback', () => {
  it('calls onSpawn with the spawned child PID immediately after process start', async () => {
    const spawnedPids: number[] = []

    await runSubprocessStreaming(
      process.execPath,
      ['-e', 'process.exit(0)'],
      process.cwd(),
      undefined,
      undefined,
      undefined,
      (pid) => spawnedPids.push(pid),
    )

    // onSpawn must have been called exactly once with a positive integer PID.
    expect(spawnedPids).toHaveLength(1)
    expect(typeof spawnedPids[0]).toBe('number')
    expect(spawnedPids[0]).toBeGreaterThan(0)
  })

  it('wires into tracker.recordPid so inFlightSnapshot carries the spawned PID', async () => {
    // This test proves the dispatch-path contract: the onSpawn callback
    // (called by runSubprocessStreaming) can be wired to tracker.recordPid()
    // so the resulting inFlightSnapshot entry carries a real OS PID.
    const tracker = createTaskFlightTracker()
    tracker.commitInFlight('task-xyz', 'implement')

    await runSubprocessStreaming(
      process.execPath,
      ['-e', 'process.exit(0)'],
      process.cwd(),
      undefined,
      undefined,
      undefined,
      (pid) => tracker.recordPid('task-xyz', pid),
    )

    const entry = tracker.inFlightSnapshot().find((e) => e.taskId === 'task-xyz')
    expect(entry).toBeDefined()
    expect(typeof entry?.pid).toBe('number')
    expect((entry?.pid ?? 0)).toBeGreaterThan(0)
  })

  it('does NOT call onSpawn when spawn fails (ENOENT binary)', async () => {
    const spawnedPids: number[] = []

    // Spawn a non-existent binary — the 'error' event fires instead of
    // the process starting, so onSpawn must not be called.
    await runSubprocessStreaming(
      '/absolutely/nonexistent/binary',
      [],
      process.cwd(),
      undefined,
      undefined,
      undefined,
      (pid) => spawnedPids.push(pid),
    )

    expect(spawnedPids).toHaveLength(0)
  })
})
