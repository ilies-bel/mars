/**
 * Regression test: killing a spawned worker reaps the entire process-group
 * subtree, not just the direct child PID.
 *
 * Before the fix, `onAbort` and `killAllChildren` signalled only the direct
 * child PID.  Descendants (npm → vitest → fork children) were reparented to
 * launchd / init and kept running.  This was observed live as 41 orphaned
 * vitest forks that survived a daemon restart, pinning the host at high load.
 *
 * After the fix:
 *   - The child is spawned with `detached: true` so it leads a new process
 *     group.
 *   - `onAbort` calls `process.kill(-child.pid, 'SIGKILL')` — negative pid
 *     targets the process group.
 *   - `killAllChildren` does the same for every tracked pid.
 *
 * Each test here spawns a stub shell script that itself spawns a long-lived
 * `sleep 30` grandchild and prints its PID to stdout.  After the kill path
 * fires we assert that `process.kill(grandchildPid, 0)` throws ESRCH,
 * proving the whole subtree — not just the direct child — was reaped.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { killAllChildren, runSubprocessStreaming } from '../git/claude'

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
