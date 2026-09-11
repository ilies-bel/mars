/**
 * Tests for the `baseline.broken` registered health check.
 *
 * Covers:
 *   - Registry presence (listChecks includes the check after index is imported).
 *   - Reporting behaviour: ok=true when healthy, ok=false+findingKey when broken.
 *   - Dedup contract: findingKey matches the reactive path's raise signature so
 *     a shared AQ raise function deduplicates both triggers to a single row.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── helpers ──────────────────────────────────────────────────────────────────

type Gate = {
  id: string
  name: string
  cmd: string
  args: string[]
  scope: string
  required: boolean
}

const makeGate = (overrides?: Partial<Gate>): Gate => ({
  id: 'gate-1',
  name: 'typecheck',
  cmd: 'npx',
  args: ['tsc', '--noEmit'],
  scope: '.',
  required: true,
  ...overrides,
})

// ─── tests ────────────────────────────────────────────────────────────────────

describe('baseline.broken health check', () => {
  beforeEach(() => {
    // Each test gets a fresh module registry so registerCheck() side-effects
    // don't collide with each other.
    vi.resetModules()
  })

  it('appears in listChecks() after the index module is imported', async () => {
    // Importing index.js triggers the baseline-broken side-effect registration.
    await import('../index.js')
    const { listChecks } = await import('../registry.js')

    const ids = listChecks().map((c) => c.id)
    expect(ids).toContain('baseline.broken')
  })

  it('has the correct static metadata', async () => {
    await import('../checks/baseline-broken.js')
    const { listChecks } = await import('../registry.js')

    const check = listChecks().find((c) => c.id === 'baseline.broken')
    expect(check).toBeDefined()
    expect(check?.description).toBeTruthy()
    expect(check?.requires).toContain('daemon')
    expect(check?.requires).toContain('git')
    expect(check?.route).toBe('alert')
  })

  it('reports ok=true when the baseline is healthy', async () => {
    const { wireBaselineBrokenCheck } = await import('../checks/baseline-broken.js')
    const { listChecks } = await import('../registry.js')

    const gate = makeGate()
    wireBaselineBrokenCheck({
      repoRoot: '/repo',
      loadGates: async () => [gate],
      runGate: async (g) => ({ gate: g, exitCode: 0, stdout: '', stderr: '' }),
    })

    const check = listChecks().find((c) => c.id === 'baseline.broken')!
    const outcome = await check.run({ prereqs: new Set(['daemon', 'git']) })

    expect(outcome.ok).toBe(true)
  })

  it('reports ok=false with findingKey baseline-broken when baseline is broken', async () => {
    const { wireBaselineBrokenCheck } = await import('../checks/baseline-broken.js')
    const { listChecks } = await import('../registry.js')

    const gate = makeGate()
    wireBaselineBrokenCheck({
      repoRoot: '/repo',
      loadGates: async () => [gate],
      runGate: async (g) => ({ gate: g, exitCode: 1, stdout: '', stderr: 'Type error' }),
    })

    const check = listChecks().find((c) => c.id === 'baseline.broken')!
    const outcome = await check.run({ prereqs: new Set(['daemon', 'git']) })

    expect(outcome.ok).toBe(false)
    expect(outcome.findingKey).toBe('baseline-broken')
    expect(outcome.detail).toBeTruthy()
  })

  it('detail includes the failing gate name', async () => {
    const { wireBaselineBrokenCheck } = await import('../checks/baseline-broken.js')
    const { listChecks } = await import('../registry.js')

    const gate = makeGate({ name: 'unit-tests' })
    wireBaselineBrokenCheck({
      repoRoot: '/repo',
      loadGates: async () => [gate],
      runGate: async (g) => ({ gate: g, exitCode: 1, stdout: '', stderr: 'Failures' }),
    })

    const check = listChecks().find((c) => c.id === 'baseline.broken')!
    const outcome = await check.run({ prereqs: new Set(['daemon', 'git']) })

    expect(outcome.detail).toContain('unit-tests')
  })

  it('reports ok=true (conservative) when not yet wired', async () => {
    // Importing the module registers the check but does NOT call wireBaselineBrokenCheck.
    await import('../checks/baseline-broken.js')
    const { listChecks } = await import('../registry.js')

    const check = listChecks().find((c) => c.id === 'baseline.broken')!
    const outcome = await check.run({ prereqs: new Set(['daemon', 'git']) })

    expect(outcome.ok).toBe(true)
  })

  it('reports ok=true when loadGates throws (conservative)', async () => {
    const { wireBaselineBrokenCheck } = await import('../checks/baseline-broken.js')
    const { listChecks } = await import('../registry.js')

    wireBaselineBrokenCheck({
      repoRoot: '/repo',
      loadGates: async () => { throw new Error('DB error') },
      runGate: vi.fn(),
    })

    const check = listChecks().find((c) => c.id === 'baseline.broken')!
    const outcome = await check.run({ prereqs: new Set(['daemon', 'git']) })

    // Cannot determine baseline state → conservative pass
    expect(outcome.ok).toBe(true)
  })

  // ── Dedup contract ───────────────────────────────────────────────────────────

  it('findingKey matches the reactive path raise signature (dedup contract)', async () => {
    /**
     * The reactive BaselineHealthChecker raises an action-queue row with
     * signature='baseline-broken'.  The registry check must return the same
     * findingKey so that any underlying AQ raise function deduplicated by
     * signature collapses both triggers to a single open row.
     *
     * REACTIVE_SIGNATURE is the value hard-coded in baseline-health.ts's design
     * decision notes ("we always use kind='baseline-broken' and
     * signature='baseline-broken'").
     */
    const REACTIVE_SIGNATURE = 'baseline-broken'

    const { wireBaselineBrokenCheck } = await import('../checks/baseline-broken.js')
    const { listChecks } = await import('../registry.js')

    const gate = makeGate()
    wireBaselineBrokenCheck({
      repoRoot: '/repo',
      loadGates: async () => [gate],
      runGate: async (g) => ({ gate: g, exitCode: 1, stdout: '', stderr: 'error' }),
    })

    const check = listChecks().find((c) => c.id === 'baseline.broken')!
    const outcome = await check.run({ prereqs: new Set(['daemon', 'git']) })

    expect(outcome.findingKey).toBe(REACTIVE_SIGNATURE)
  })

  it('no duplicate row when both reactive and registry paths fire for a broken baseline', async () => {
    /**
     * Simulate shared AQ raise infrastructure.  Both the reactive path
     * (raiseActionQueueRow → calls raise('baseline-broken')) and the registry
     * check's alert route (calls raise(outcome.findingKey)) use the same key.
     * A dedup-by-key store records only one row.
     */
    const { wireBaselineBrokenCheck } = await import('../checks/baseline-broken.js')
    const { listChecks } = await import('../registry.js')
    const { createBaselineHealthChecker } = await import('../../daemon/baseline-health.js')
    const { createPauseController } = await import('../../daemon/pause-state.js')

    const raisedKeys = new Set<string>()
    const raise = async (key: string) => {
      raisedKeys.add(key)
    }

    const gate = makeGate()
    const loadGates = vi.fn().mockResolvedValue([gate])
    const runGate = vi.fn().mockResolvedValue({
      gate,
      exitCode: 1,
      stdout: '',
      stderr: 'Type error',
    })

    // Reactive path: checker sets isBaselinePoisoned() — derivation layer produces
    // 'baseline-broken' rows.  The registry check uses the same key.
    const checker = createBaselineHealthChecker({
      repoRoot: '/repo',
      loadGates,
      runGate,
      pause: createPauseController(),
      computeDepFingerprint: vi.fn().mockResolvedValue(null),
      runInstallProbe: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    })
    await checker.check()
    // Simulate the derivation layer surfacing the row with the same key
    await raise('baseline-broken')

    // Registry check run(): returns findingKey='baseline-broken'
    wireBaselineBrokenCheck({ repoRoot: '/repo', loadGates, runGate })
    const check = listChecks().find((c) => c.id === 'baseline.broken')!
    const outcome = await check.run({ prereqs: new Set(['daemon', 'git']) })

    // Alert route would call raise(outcome.findingKey); dedup prevents a second row
    if (outcome.findingKey && !raisedKeys.has(outcome.findingKey)) {
      await raise(outcome.findingKey)
    }

    // Both paths use the same key → exactly one unique row
    expect(raisedKeys.size).toBe(1)
    expect(raisedKeys.has('baseline-broken')).toBe(true)
  })
})

// ── Timeout semantics ────────────────────────────────────────────────────────
//
// Answers the open question: "is a gate that exceeds timeout_min treated as
// failing or as inconclusive?"
//
// Answer: **failing**.  When a child process is killed for exceeding
// `timeoutMin`, the OS delivers SIGTERM (exit 143) then SIGKILL (exit 137).
// `isBaselineBroken` sees exitCode !== 0 and returns broken=true.  A timeout
// is a gate FAILURE, not a conservative pass.
//
// Conservative pass is reserved for *unexpected throw* from `runGate` — e.g.
// a spawn error because the executable is not found — where the gate was not
// runnable at all, not that it failed.

describe('timeout semantics', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('runGate returning SIGTERM exit code (143) is treated as a gate failure', async () => {
    /**
     * When a gate child is killed after exceeding timeout_min, runTool maps
     * SIGTERM → exitCode 143.  isBaselineBroken sees exitCode !== 0 and
     * returns broken=true.  Timeout is FAILURE, not inconclusive.
     */
    const { wireBaselineBrokenCheck } = await import('../checks/baseline-broken.js')
    const { listChecks } = await import('../registry.js')

    wireBaselineBrokenCheck({
      repoRoot: '/repo',
      loadGates: async () => [makeGate({ name: 'typecheck' })],
      // Simulate child killed by SIGTERM after exceeding timeoutMin.
      runGate: async (g) => ({
        gate: g,
        exitCode: 143,
        stdout: '',
        stderr: '[runTool: killed after 900000ms]\n',
      }),
    })

    const check = listChecks().find((c) => c.id === 'baseline.broken')!
    const outcome = await check.run({ prereqs: new Set(['daemon', 'git']) })

    expect(outcome.ok).toBe(false)
    expect(outcome.findingKey).toBe('baseline-broken')
    expect(outcome.detail).toContain('typecheck')
  })

  it('runGate returning SIGKILL exit code (137) is also treated as a gate failure', async () => {
    /**
     * After SIGTERM grace, runTool escalates to SIGKILL → exitCode 137.
     * Regardless of which signal fired, isBaselineBroken treats non-zero
     * exit as broken=true.
     */
    const { wireBaselineBrokenCheck } = await import('../checks/baseline-broken.js')
    const { listChecks } = await import('../registry.js')

    wireBaselineBrokenCheck({
      repoRoot: '/repo',
      loadGates: async () => [makeGate({ name: 'unit-tests' })],
      runGate: async (g) => ({
        gate: g,
        exitCode: 137,
        stdout: '',
        stderr: '[runTool: killed after 900000ms]\n',
      }),
    })

    const check = listChecks().find((c) => c.id === 'baseline.broken')!
    const outcome = await check.run({ prereqs: new Set(['daemon', 'git']) })

    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('unit-tests')
  })

  it('runGate throwing (spawn error / binary not found) is treated as conservative pass', async () => {
    /**
     * An unexpected runGate throw — e.g. spawn ENOENT because the executable
     * is not found — is NOT the same as a gate failure.  isBaselineBroken
     * catches it and continues to the next gate (conservative: treat as pass).
     * A stale $PATH or a missing tool should not report a poisoned baseline.
     */
    const { wireBaselineBrokenCheck } = await import('../checks/baseline-broken.js')
    const { listChecks } = await import('../registry.js')

    wireBaselineBrokenCheck({
      repoRoot: '/repo',
      loadGates: async () => [makeGate()],
      runGate: async () => {
        throw new Error('spawn ENOENT: no such file or directory, spawn npx')
      },
    })

    const check = listChecks().find((c) => c.id === 'baseline.broken')!
    const outcome = await check.run({ prereqs: new Set(['daemon', 'git']) })

    // Conservative: spawn errors mean the gate was not runnable, not that it
    // failed.  ok=true prevents false positives from environment issues.
    expect(outcome.ok).toBe(true)
  })
})

// ── startBaselinePauseWatcher ────────────────────────────────────────────────

describe('startBaselinePauseWatcher', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('clears a baseline pause when the integration branch advances, without any task completing', async () => {
    /**
     * Regression guard for the self-deadlock observed 2026-09-01:
     *
     *   baseline poisoned → dispatch paused
     *   dispatch paused  → no task dispatched
     *   no task          → task.completed never fires
     *   no event         → health check never re-runs
     *   → loop forever, only a daemon restart escapes
     *
     * The watcher must break this by detecting a branch-SHA advance and
     * re-running the check autonomously.
     */
    const { createBaselineHealthChecker, startBaselinePauseWatcher } = await import(
      '../../daemon/baseline-health.js'
    )
    const { createPauseController } = await import('../../daemon/pause-state.js')

    // Gate is initially broken.
    let gateExitCode = 1
    let currentSha = 'sha-broken'

    const pause = createPauseController()
    const checker = createBaselineHealthChecker({
      repoRoot: '/repo',
      loadGates: async () => [makeGate()],
      runGate: async (g) => ({
        gate: g,
        exitCode: gateExitCode,
        stdout: '',
        stderr: 'Type error',
      }),
      pause,
      computeDepFingerprint: vi.fn().mockResolvedValue(null),
      runInstallProbe: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    })

    // Poison the baseline (simulates startup check finding it broken).
    await checker.check()
    expect(pause.get().paused).toBe(true)
    expect(pause.get().reason).toBe('baseline')
    expect(checker.isBaselinePoisoned()).toBe(true)

    // Simulate an operator repairing main: both the gate and the SHA change.
    // No task.completed event fires — dispatch is paused, so no task runs.
    gateExitCode = 0
    currentSha = 'sha-fixed'

    // Start the watcher with a very short interval for testing.
    const watcher = startBaselinePauseWatcher({
      pause,
      getIntegrationBranchSha: async () => currentSha,
      checkBaseline: () => checker.check(),
      intervalMs: 15,
    })

    try {
      // Wait for the watcher to detect the SHA change and re-run the check.
      // No task.completed event is fired — dispatch remains mechanically "paused"
      // the entire time, yet the watcher clears it.
      await vi.waitFor(
        () => {
          expect(pause.get().paused).toBe(false)
        },
        { timeout: 500 },
      )

      expect(checker.isBaselinePoisoned()).toBe(false)
      expect(checker.getLastDetection()).toBeNull()
    } finally {
      watcher.stop()
    }
  })

  it('does not run the check when dispatch is not paused for baseline', async () => {
    const { startBaselinePauseWatcher } = await import(
      '../../daemon/baseline-health.js'
    )
    const { createPauseController } = await import('../../daemon/pause-state.js')

    const checkFn = vi.fn().mockResolvedValue({ poisoned: false })
    const pause = createPauseController()
    // Dispatch is running (no pause) — the watcher must be silent.

    const watcher = startBaselinePauseWatcher({
      pause,
      getIntegrationBranchSha: async () => 'sha-healthy',
      checkBaseline: checkFn,
      intervalMs: 15,
    })

    await new Promise((r) => setTimeout(r, 60))
    watcher.stop()

    expect(checkFn).not.toHaveBeenCalled()
  })

  it('re-runs the check when the SHA it evaluated against is no longer current', async () => {
    /**
     * Explicit regression guard for the "stale verdict" case documented in the
     * 2026-09-07 incident report:
     *
     *   The daemon ran a baseline check at SHA A and recorded a "poisoned"
     *   verdict. HEAD advanced to SHA B and SHA C while the daemon kept serving
     *   the stale verdict — dispatch stayed paused as if SHA A were current,
     *   even though SHA C was green.
     *
     * The watcher tracks the SHA it last checked against (`_lastObservedSha`).
     * That SHA is the one the cached verdict was evaluated against. When the
     * integration branch advances, `_lastObservedSha` diverges from the current
     * SHA, the watcher detects this on the next tick, and re-runs the check —
     * independent of any task completing.
     */
    const { createBaselineHealthChecker, startBaselinePauseWatcher } = await import(
      '../../daemon/baseline-health.js'
    )
    const { createPauseController } = await import('../../daemon/pause-state.js')

    let gateExitCode = 1
    let currentSha = 'sha-at-verdict-time'

    const pause = createPauseController()
    const checker = createBaselineHealthChecker({
      repoRoot: '/repo',
      loadGates: async () => [makeGate()],
      runGate: async (g) => ({ gate: g, exitCode: gateExitCode, stdout: '', stderr: 'broken' }),
      pause,
      computeDepFingerprint: vi.fn().mockResolvedValue(null),
      runInstallProbe: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    })

    // Run the initial check: verdict = poisoned at 'sha-at-verdict-time'.
    await checker.check()
    expect(pause.get().paused).toBe(true)

    // Start the watcher. On the first tick it observes 'sha-at-verdict-time'
    // and records it as the SHA the current verdict was evaluated against.
    const watcher = startBaselinePauseWatcher({
      pause,
      getIntegrationBranchSha: async () => currentSha,
      checkBaseline: () => checker.check(),
      intervalMs: 15,
    })

    // Let one tick fire so the watcher records 'sha-at-verdict-time' as known.
    await new Promise((r) => setTimeout(r, 40))
    // Dispatch should still be paused (SHA unchanged so far).
    expect(pause.get().paused).toBe(true)

    // Now the integration branch advances AND the gate is repaired.
    gateExitCode = 0
    currentSha = 'sha-after-fix'

    // The watcher must detect the SHA advance and clear the pause.
    try {
      await vi.waitFor(
        () => {
          expect(pause.get().paused).toBe(false)
        },
        { timeout: 500 },
      )
      expect(checker.isBaselinePoisoned()).toBe(false)
    } finally {
      watcher.stop()
    }
  })

  it('does not re-run the check when the SHA has not changed', async () => {
    const { startBaselinePauseWatcher } = await import(
      '../../daemon/baseline-health.js'
    )
    const { createPauseController } = await import('../../daemon/pause-state.js')

    const pause = createPauseController()
    pause.pause('baseline', 'gate "typecheck" fails')

    let checkCount = 0
    const checkFn = vi.fn(async () => {
      checkCount++
      return { poisoned: true } // still broken
    })

    const watcher = startBaselinePauseWatcher({
      pause,
      // Always returns the same SHA — no advance, so no re-check after the first.
      getIntegrationBranchSha: async () => 'sha-stuck',
      checkBaseline: checkFn,
      intervalMs: 15,
    })

    // Wait long enough for multiple timer ticks.
    await new Promise((r) => setTimeout(r, 80))
    watcher.stop()

    // The check fires once (on the first tick, when SHA transitions from null
    // to 'sha-stuck'), then never again because the SHA is stable.
    expect(checkCount).toBe(1)
  })
})
