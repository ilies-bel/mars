/**
 * Tests for the install concurrency semaphore in worktree-install.
 *
 * Verifies that MARS_MAX_SETUP_INSTALL (default 2) caps how many dependency
 * installs run in parallel — the tsup/esbuild prepare script is the
 * per-install memory peak, and unlimited parallelism OOM-kills the process.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  setInstallSemCap,
  getInstallSemState,
  installWorktreeDeps,
} from '../worktree-install'
import type { RunSubprocessResult } from '../git/claude'

const ok = (): RunSubprocessResult => ({ exitCode: 0, stdout: '', stderr: '' })

describe('install semaphore', () => {
  const dirs: string[] = []

  const makeDir = (): string => {
    const d = mkdtempSync(resolve(tmpdir(), 'mars-install-sem-'))
    dirs.push(d)
    // A pnpm lockfile is the minimum to make detectInstallSites return one site.
    writeFileSync(resolve(d, 'pnpm-lock.yaml'), '')
    return d
  }

  beforeEach(() => {
    // Each test gets a clean slate: reset to cap=2 (the production default)
    // and drain any stale waiters (there should be none after a clean prior test).
    setInstallSemCap(2)
  })

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true })
    }
    // Restore the default so later test files are unaffected.
    setInstallSemCap(2)
  })

  it('getInstallSemState reflects the configured limit', () => {
    setInstallSemCap(3)
    expect(getInstallSemState().limit).toBe(3)
    expect(getInstallSemState().inUse).toBe(0)
    expect(getInstallSemState().waiting).toBe(0)
  })

  it('setInstallSemCap rejects non-positive or non-integer limits', () => {
    expect(() => setInstallSemCap(0)).toThrow('limit must be a positive integer')
    expect(() => setInstallSemCap(-1)).toThrow('limit must be a positive integer')
    expect(() => setInstallSemCap(1.5)).toThrow('limit must be a positive integer')
  })

  it('never runs more concurrent installs than the configured cap', async () => {
    const CAP = 2
    setInstallSemCap(CAP)

    let peak = 0
    let current = 0

    // A runner that holds for one event-loop tick, letting other pending
    // acquirers stack up if the cap permits.
    const runner = async (): Promise<RunSubprocessResult> => {
      current++
      peak = Math.max(peak, current)
      // Yield so any OTHER semaphore-waiters that are now unblocked
      // can advance before we decrement.
      await new Promise<void>((r) => setImmediate(r))
      current--
      return ok()
    }

    // N = CAP + 2 independent worktrees all trying to install concurrently.
    const N = CAP + 2
    const worktrees = Array.from({ length: N }, makeDir)

    await Promise.all(
      worktrees.map((d) => installWorktreeDeps({ worktreeRoot: d, runner })),
    )

    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThanOrEqual(CAP)
  })

  it('setInstallSemCap correctly updates the concurrency limit', () => {
    setInstallSemCap(5)
    expect(getInstallSemState().limit).toBe(5)
    expect(getInstallSemState().inUse).toBe(0)

    setInstallSemCap(1)
    expect(getInstallSemState().limit).toBe(1)
  })

  it('releases the slot even when the install runner throws', async () => {
    setInstallSemCap(1)
    const d = makeDir()
    const throwing = async (): Promise<RunSubprocessResult> => {
      throw new Error('install blew up')
    }
    await expect(
      installWorktreeDeps({ worktreeRoot: d, runner: throwing }),
    ).rejects.toThrow('install blew up')
    // The semaphore must be released so the next install can proceed.
    expect(getInstallSemState().inUse).toBe(0)
  })
})
