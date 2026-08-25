import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createBaselineHealthChecker,
  type BaselineHealthDeps,
  type BaselineGate,
  type GateResult,
} from '../baseline-health.js'
import { createPauseController } from '../pause-state.js'
import { createConditionItemsSource } from '../view/derived-conditions.js'
import type { DbClient } from '../../lib/db.js'

// Minimal DB client for tests that need createConditionItemsSource but don't
// exercise DB-backed derivations (findBaselineCaughtTaskIds short-circuits on
// no-baseline-pause-state and failed queries; emptyDbClient covers the rest).
const emptyDbClient: DbClient = {
  execute: async () => ({ rows: [], rowsAffected: 0 }),
  batch: async () => [],
  close: async () => {},
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const makeGate = (overrides?: Partial<BaselineGate>): BaselineGate => ({
  id: 'gate-1',
  name: 'typecheck',
  cmd: 'npx',
  args: ['tsc', '--noEmit'],
  scope: '.',
  required: true,
  ...overrides,
})

const passingResult = (gate: BaselineGate): GateResult => ({
  gate,
  exitCode: 0,
  stdout: '',
  stderr: '',
})

const failingResult = (gate: BaselineGate, stderr = 'Type error'): GateResult => ({
  gate,
  exitCode: 1,
  stdout: '',
  stderr,
})

const passingInstall = { exitCode: 0, stdout: '', stderr: '' }
const failingInstall = (stderr = 'ETARGET: no matching version') => ({
  exitCode: 1,
  stdout: '',
  stderr,
})

type Deps = {
  pause: ReturnType<typeof createPauseController>
  loadGates: ReturnType<typeof vi.fn>
  runGate: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
  computeDepFingerprint: ReturnType<typeof vi.fn>
  runInstallProbe: ReturnType<typeof vi.fn>
}

const makeDeps = (overrides?: Partial<BaselineHealthDeps>): { deps: BaselineHealthDeps; mocks: Deps } => {
  const pause = createPauseController()
  const loadGates = vi.fn()
  const runGate = vi.fn()
  const log = vi.fn()
  // Default: a fixed, non-null fingerprint. Most tests don't exercise the
  // skip path directly (they poison the baseline first, which always
  // re-checks), but a stable default keeps them from accidentally depending
  // on fingerprint churn.
  const computeDepFingerprint = vi.fn().mockResolvedValue('fp-a')
  const runInstallProbe = vi.fn().mockResolvedValue(passingInstall)

  const deps: BaselineHealthDeps = {
    repoRoot: '/repo',
    loadGates: loadGates as () => Promise<BaselineGate[]>,
    runGate: runGate as (gate: BaselineGate, cwd: string) => Promise<GateResult>,
    pause,
    log,
    computeDepFingerprint: computeDepFingerprint as (repoRoot: string) => Promise<string | null>,
    runInstallProbe: runInstallProbe as BaselineHealthDeps['runInstallProbe'],
    ...overrides,
  }
  return { deps, mocks: { pause, loadGates, runGate, log, computeDepFingerprint, runInstallProbe } }
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('createBaselineHealthChecker', () => {
  describe('check()', () => {
    it('returns poisoned=false and does not pause when all gates pass', async () => {
      const gate = makeGate()
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])
      mocks.runGate.mockResolvedValue(passingResult(gate))

      const checker = createBaselineHealthChecker(deps)
      const result = await checker.check()

      expect(result.poisoned).toBe(false)
      expect(mocks.pause.isPaused()).toBe(false)
    })

    it('returns poisoned=true and pauses with reason=baseline when a required gate fails', async () => {
      const gate = makeGate()
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])
      mocks.runGate.mockResolvedValue(failingResult(gate, 'TSC error'))

      const checker = createBaselineHealthChecker(deps)
      const result = await checker.check()

      expect(result.poisoned).toBe(true)
      expect(mocks.pause.isPaused()).toBe(true)
      expect(mocks.pause.get().reason).toBe('baseline')
      // baseline-broken is now derived on read; no action-queue row is raised here
    })

    it('isBaselinePoisoned() reflects the poisoned state after check()', async () => {
      const gate = makeGate()
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])
      mocks.runGate.mockResolvedValue(failingResult(gate))

      const checker = createBaselineHealthChecker(deps)
      expect(checker.isBaselinePoisoned()).toBe(false)
      await checker.check()
      expect(checker.isBaselinePoisoned()).toBe(true)
    })

    it('stops at the first failing required gate (does not run subsequent gates)', async () => {
      const gate1 = makeGate({ id: 'gate-1', name: 'typecheck' })
      const gate2 = makeGate({ id: 'gate-2', name: 'tests' })
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate1, gate2])
      mocks.runGate
        .mockResolvedValueOnce(failingResult(gate1))
        .mockResolvedValueOnce(passingResult(gate2))

      const checker = createBaselineHealthChecker(deps)
      await checker.check()

      // Only gate1 was run
      expect(mocks.runGate).toHaveBeenCalledTimes(1)
    })

    it('clears the poisoned state and resumes dispatch when baseline recovers', async () => {
      const gate = makeGate()
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])

      const checker = createBaselineHealthChecker(deps)

      // First: poison the baseline
      mocks.runGate.mockResolvedValue(failingResult(gate))
      await checker.check()
      expect(checker.isBaselinePoisoned()).toBe(true)
      expect(mocks.pause.isPaused()).toBe(true)

      // Second: baseline recovers
      mocks.runGate.mockResolvedValue(passingResult(gate))
      const result = await checker.check()

      expect(result.poisoned).toBe(false)
      expect(checker.isBaselinePoisoned()).toBe(false)
      expect(mocks.pause.isPaused()).toBe(false)
      // baseline-broken row is derived on read; no stored row to resolve here
    })

    it('does NOT resume dispatch when paused for a different reason (first-cause-wins)', async () => {
      const gate = makeGate()
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])

      // Operator pauses first
      mocks.pause.pause('operator', 'test')

      const checker = createBaselineHealthChecker(deps)

      // Baseline fails — pause.pause('baseline') returns false (already paused)
      mocks.runGate.mockResolvedValue(failingResult(gate))
      await checker.check()
      expect(checker.isBaselinePoisoned()).toBe(true)
      // Still operator
      expect(mocks.pause.get().reason).toBe('operator')

      // Baseline recovers — should NOT clear the operator pause
      mocks.runGate.mockResolvedValue(passingResult(gate))
      await checker.check()
      expect(checker.isBaselinePoisoned()).toBe(false)
      // Operator pause is still in effect
      expect(mocks.pause.isPaused()).toBe(true)
      expect(mocks.pause.get().reason).toBe('operator')
    })

    it('does not overwrite an existing storm pause, and recovery does not clear it', async () => {
      const gate = makeGate()
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])

      // Signature-storm breaker pauses first
      mocks.pause.pause('storm', 'signature storm: verify:has-diff/no-commits-ahead x3')

      const checker = createBaselineHealthChecker(deps)

      // Baseline fails too — pause.pause('baseline') returns false (already paused)
      mocks.runGate.mockResolvedValue(failingResult(gate))
      await checker.check()
      expect(checker.isBaselinePoisoned()).toBe(true)
      expect(mocks.pause.get().reason).toBe('storm')

      // Baseline recovers — should NOT clear the storm pause
      mocks.runGate.mockResolvedValue(passingResult(gate))
      await checker.check()
      expect(checker.isBaselinePoisoned()).toBe(false)
      expect(mocks.pause.isPaused()).toBe(true)
      expect(mocks.pause.get().reason).toBe('storm')
    })

    it('does not overwrite an existing quota pause, and recovery does not clear it', async () => {
      const gate = makeGate()
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])

      // Provider rate/spend rejection pauses first
      mocks.pause.pause('quota', 'provider rate/spend limit')

      const checker = createBaselineHealthChecker(deps)

      // Baseline fails too — pause.pause('baseline') returns false (already paused)
      mocks.runGate.mockResolvedValue(failingResult(gate))
      await checker.check()
      expect(checker.isBaselinePoisoned()).toBe(true)
      expect(mocks.pause.get().reason).toBe('quota')

      // Baseline recovers — should NOT clear the quota pause
      mocks.runGate.mockResolvedValue(passingResult(gate))
      await checker.check()
      expect(checker.isBaselinePoisoned()).toBe(false)
      expect(mocks.pause.isPaused()).toBe(true)
      expect(mocks.pause.get().reason).toBe('quota')
    })

    it('re-pauses with reason=baseline on a fresh checker + pause controller when the gate is still broken (simulated daemon restart)', async () => {
      const gate = makeGate()

      // "Before restart": the running daemon already knows the baseline is
      // broken and dispatch is paused.
      const { deps: beforeDeps, mocks: beforeMocks } = makeDeps()
      beforeMocks.loadGates.mockResolvedValue([gate])
      beforeMocks.runGate.mockResolvedValue(failingResult(gate, 'TSC error'))
      const before = createBaselineHealthChecker(beforeDeps)
      await before.check()
      expect(beforeMocks.pause.get().reason).toBe('baseline')

      // "After restart": a brand-new process constructs a fresh pause
      // controller (in-memory state does not survive a restart) and a fresh
      // checker, wired to the same still-broken repo. server.ts runs this
      // startup check before the first drain() — it must independently
      // re-detect and re-pause without relying on any restored flag.
      const { deps: afterDeps, mocks: afterMocks } = makeDeps()
      afterMocks.loadGates.mockResolvedValue([gate])
      afterMocks.runGate.mockResolvedValue(failingResult(gate, 'TSC error'))
      const after = createBaselineHealthChecker(afterDeps)
      expect(afterMocks.pause.isPaused()).toBe(false)

      const result = await after.check()

      expect(result.poisoned).toBe(true)
      expect(afterMocks.pause.isPaused()).toBe(true)
      expect(afterMocks.pause.get().reason).toBe('baseline')
    })

    it('returns poisoned=false and does not pause when there are no required gates', async () => {
      const gate = makeGate({ required: false })
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])
      // runGate should never be called for optional-only gates
      mocks.runGate.mockResolvedValue(passingResult(gate))

      const checker = createBaselineHealthChecker(deps)
      const result = await checker.check()

      expect(result.poisoned).toBe(false)
      expect(mocks.runGate).not.toHaveBeenCalled()
      expect(mocks.pause.isPaused()).toBe(false)
    })

    it('does not change poison state when loadGates throws', async () => {
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockRejectedValue(new Error('DB error'))

      const checker = createBaselineHealthChecker(deps)
      const result = await checker.check()

      // Conservative: don't change state when gate list is unreadable
      expect(result.poisoned).toBe(false)
      expect(mocks.pause.isPaused()).toBe(false)
    })

    it('treats a gate that throws as a pass (continues without pausing)', async () => {
      const gate = makeGate()
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])
      mocks.runGate.mockRejectedValue(new Error('spawn ENOENT'))

      const checker = createBaselineHealthChecker(deps)
      const result = await checker.check()

      expect(result.poisoned).toBe(false)
      expect(mocks.pause.isPaused()).toBe(false)
    })

    it('runs the gate in the scope-resolved directory', async () => {
      const gate = makeGate({ scope: 'packages/core' })
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])
      mocks.runGate.mockResolvedValue(passingResult(gate))

      const checker = createBaselineHealthChecker(deps)
      await checker.check()

      expect(mocks.runGate).toHaveBeenCalledWith(gate, '/repo/packages/core')
    })

    it('runs the gate in repoRoot when scope is "."', async () => {
      const gate = makeGate({ scope: '.' })
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])
      mocks.runGate.mockResolvedValue(passingResult(gate))

      const checker = createBaselineHealthChecker(deps)
      await checker.check()

      expect(mocks.runGate).toHaveBeenCalledWith(gate, '/repo')
    })
  })

  describe('dependency-fingerprint-gated install probe', () => {
    it('detects an unsatisfiable version pin via a failing install probe', async () => {
      const gate = makeGate()
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])
      mocks.runGate.mockResolvedValue(passingResult(gate))
      mocks.runInstallProbe.mockResolvedValue(failingInstall('ETARGET No matching version found'))

      const checker = createBaselineHealthChecker(deps)
      const result = await checker.check()

      expect(result.poisoned).toBe(true)
      expect(mocks.pause.isPaused()).toBe(true)
      expect(mocks.pause.get().reason).toBe('baseline')
      // The gate run never runs — the install probe already proved broken.
      expect(mocks.runGate).not.toHaveBeenCalled()
      expect(checker.getLastDetection()?.failingGateName).toBe('dependency install')
    })

    it('skips the install probe on a second check when the fingerprint is unchanged', async () => {
      const gate = makeGate()
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])
      mocks.runGate.mockResolvedValue(passingResult(gate))
      mocks.computeDepFingerprint.mockResolvedValue('fp-a')

      const checker = createBaselineHealthChecker(deps)
      await checker.check()
      expect(mocks.runInstallProbe).toHaveBeenCalledTimes(1)

      // Second check: fingerprint unchanged — install probe should be skipped
      // entirely, even though this mock (if invoked) would now report failure.
      mocks.runInstallProbe.mockResolvedValue(failingInstall())
      const result = await checker.check()

      expect(result.poisoned).toBe(false)
      expect(mocks.runInstallProbe).toHaveBeenCalledTimes(1)
      // The (unchanged) required-gate run still runs every check() call.
      expect(mocks.runGate).toHaveBeenCalledTimes(2)
    })

    it('re-runs the install probe when the fingerprint changes', async () => {
      const gate = makeGate()
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])
      mocks.runGate.mockResolvedValue(passingResult(gate))
      mocks.computeDepFingerprint.mockResolvedValue('fp-a')

      const checker = createBaselineHealthChecker(deps)
      await checker.check()
      expect(mocks.runInstallProbe).toHaveBeenCalledTimes(1)

      mocks.computeDepFingerprint.mockResolvedValue('fp-b')
      mocks.runInstallProbe.mockResolvedValue(failingInstall())
      const result = await checker.check()

      expect(result.poisoned).toBe(true)
      expect(mocks.runInstallProbe).toHaveBeenCalledTimes(2)
    })

    it('never skips the install probe when the fingerprint is null (no manifest found)', async () => {
      const gate = makeGate()
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])
      mocks.runGate.mockResolvedValue(passingResult(gate))
      mocks.computeDepFingerprint.mockResolvedValue(null)

      const checker = createBaselineHealthChecker(deps)
      await checker.check()
      await checker.check()

      expect(mocks.runInstallProbe).toHaveBeenCalledTimes(2)
    })

    it('still catches a non-dependency regression via the always-run gate check, and re-arms the install probe once poisoned', async () => {
      const gate = makeGate()
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])
      mocks.computeDepFingerprint.mockResolvedValue('fp-a')

      const checker = createBaselineHealthChecker(deps)

      // First check: install probe passes, gate passes — healthy, and the
      // fingerprint behind that healthy result is recorded.
      mocks.runGate.mockResolvedValue(passingResult(gate))
      await checker.check()
      expect(mocks.runInstallProbe).toHaveBeenCalledTimes(1)

      // Second check: fingerprint unchanged and not (yet) poisoned, so the
      // install probe is skipped — but a regression that has nothing to do
      // with dependencies is still caught by the required-gate run, which
      // always runs regardless of the fingerprint.
      mocks.runGate.mockResolvedValue(failingResult(gate))
      const broken = await checker.check()
      expect(broken.poisoned).toBe(true)
      expect(mocks.runInstallProbe).toHaveBeenCalledTimes(1)
      expect(mocks.runGate).toHaveBeenCalledTimes(2)

      // Third check: now poisoned, so the install probe is no longer skipped
      // even though the fingerprint still hasn't changed.
      mocks.runGate.mockResolvedValue(passingResult(gate))
      const recovered = await checker.check()
      expect(recovered.poisoned).toBe(false)
      expect(mocks.runInstallProbe).toHaveBeenCalledTimes(2)
    })

    it('does not let an install-probe execution error block the probe (treated as pass)', async () => {
      const gate = makeGate()
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])
      mocks.runGate.mockResolvedValue(passingResult(gate))
      mocks.runInstallProbe.mockRejectedValue(new Error('spawn ENOENT'))

      const checker = createBaselineHealthChecker(deps)
      const result = await checker.check()

      expect(result.poisoned).toBe(false)
      expect(mocks.pause.isPaused()).toBe(false)
    })

    it('does not let a fingerprint computation error block the probe', async () => {
      const gate = makeGate()
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])
      mocks.runGate.mockResolvedValue(passingResult(gate))
      mocks.computeDepFingerprint.mockRejectedValue(new Error('fs error'))

      const checker = createBaselineHealthChecker(deps)
      const result = await checker.check()

      expect(result.poisoned).toBe(false)
      expect(mocks.runInstallProbe).toHaveBeenCalledTimes(1)
    })
  })

  describe('isBaselinePoisoned()', () => {
    it('starts as false before any check', () => {
      const { deps } = makeDeps()
      const checker = createBaselineHealthChecker(deps)
      expect(checker.isBaselinePoisoned()).toBe(false)
    })

    it('becomes true after a failing check and false after a passing one', async () => {
      const gate = makeGate()
      const { deps, mocks } = makeDeps()
      mocks.loadGates.mockResolvedValue([gate])

      const checker = createBaselineHealthChecker(deps)

      mocks.runGate.mockResolvedValue(failingResult(gate))
      await checker.check()
      expect(checker.isBaselinePoisoned()).toBe(true)

      mocks.runGate.mockResolvedValue(passingResult(gate))
      await checker.check()
      expect(checker.isBaselinePoisoned()).toBe(false)
    })
  })
})

// ─── regression: baseline-broken row lifecycle (ADR-0094 invariant) ──────────
//
// Incident 2026-08-25: after the integration branch was repaired and all gates
// passed, `mars action-queue list open --kind baseline-broken` still returned
// row bbd73920 with a FRESH at: timestamp but STALE captured gate output from
// the old failing tests.  Root causes:
//
//   1. Concurrent fire-and-forget check() calls (one per task.completed event)
//      could interleave: a slow call started when the baseline was broken could
//      finish AFTER a fast call that proved recovery, overwriting _poisoned=false
//      and _lastDetection=null with stale broken state.
//
//   2. _lastDetection was not cleared on recovery, so captured output from a
//      prior failing probe outlived the verdict that produced it.
//
// The fix: serialise concurrent check() calls (deduplicate on _checkInProgress)
// and clear _lastDetection=null when _poisoned transitions to false.  The
// derived-conditions layer also short-circuits on null detail as a belt-and-
// suspenders guard.
//
// This test drives the full transition and asserts BOTH invariants together
// (row absent AND dispatch resumed) so they cannot drift apart again.
describe('baseline-broken derived row lifecycle (regression guard)', () => {
  it('row appears when gate fails and is gone when gate passes, dispatch tracks it', async () => {
    const gate = makeGate()
    const { deps, mocks } = makeDeps()
    mocks.loadGates.mockResolvedValue([gate])

    const checker = createBaselineHealthChecker(deps)
    const source = createConditionItemsSource({
      getClient: () => emptyDbClient,
      isBaselinePoisoned: () => checker.isBaselinePoisoned(),
      baselineDetail: () => checker.getLastDetection(),
    })

    // ── Phase 1: gate fails — row must exist and dispatch must be paused ──
    mocks.runGate.mockResolvedValue(failingResult(gate, 'TSC error'))
    await checker.check()

    const rowsBroken = await source.derive({ kinds: new Set(['baseline-broken']) })
    expect(rowsBroken).toHaveLength(1)
    expect(rowsBroken[0]!.kind).toBe('baseline-broken')
    expect(rowsBroken[0]!.payload).toMatchObject({ failingGateName: 'typecheck' })
    expect(mocks.pause.isPaused()).toBe(true)
    expect(mocks.pause.get().reason).toBe('baseline')

    // ── Phase 2: gate passes — row must be gone AND dispatch must resume ──
    // Both are asserted in this single block so they cannot drift apart: a
    // row-present/dispatch-resumed or row-gone/dispatch-paused split would
    // each violate the ADR-0094 "condition unrepresentable when not holding"
    // invariant that the 2026-08-25 incident broke.
    mocks.runGate.mockResolvedValue(passingResult(gate))
    await checker.check()

    const rowsRecovered = await source.derive({ kinds: new Set(['baseline-broken']) })
    expect(rowsRecovered).toHaveLength(0)
    expect(checker.isBaselinePoisoned()).toBe(false)
    expect(mocks.pause.isPaused()).toBe(false)
    // _lastDetection must be null after recovery — stale output must not survive
    expect(checker.getLastDetection()).toBeNull()
  })
})

describe('overrideFailingStep callback pattern', () => {
  it('returns verify:poisoned-baseline for a verify: failing step when baseline is poisoned', async () => {
    const gate = makeGate()
    const { deps, mocks } = makeDeps()
    mocks.loadGates.mockResolvedValue([gate])
    mocks.runGate.mockResolvedValue(failingResult(gate))

    const checker = createBaselineHealthChecker(deps)
    await checker.check()

    // Simulate the overrideFailingStep closure the daemon would pass
    const overrideFailingStep = (taskId: string, failingStep: string): string | null => {
      if (!checker.isBaselinePoisoned()) return null
      if (!failingStep.startsWith('verify:')) return null
      return 'verify:poisoned-baseline'
    }

    expect(overrideFailingStep('task-1', 'verify:typecheck')).toBe('verify:poisoned-baseline')
    expect(overrideFailingStep('task-1', 'verify:test')).toBe('verify:poisoned-baseline')
    // Non-verify steps are not overridden
    expect(overrideFailingStep('task-1', 'code:commit-contract')).toBeNull()
    // When baseline is clean the override returns null
    mocks.runGate.mockResolvedValue(passingResult(gate))
    await checker.check()
    expect(overrideFailingStep('task-1', 'verify:typecheck')).toBeNull()
  })
})
