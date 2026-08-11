import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createBaselineHealthChecker,
  type BaselineHealthDeps,
  type BaselineGate,
  type GateResult,
} from '../baseline-health.js'
import { createPauseController } from '../pause-state.js'

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

type Deps = {
  pause: ReturnType<typeof createPauseController>
  loadGates: ReturnType<typeof vi.fn>
  runGate: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
}

const makeDeps = (overrides?: Partial<BaselineHealthDeps>): { deps: BaselineHealthDeps; mocks: Deps } => {
  const pause = createPauseController()
  const loadGates = vi.fn()
  const runGate = vi.fn()
  const log = vi.fn()

  const deps: BaselineHealthDeps = {
    repoRoot: '/repo',
    loadGates: loadGates as () => Promise<BaselineGate[]>,
    runGate: runGate as (gate: BaselineGate, cwd: string) => Promise<GateResult>,
    pause,
    log,
    ...overrides,
  }
  return { deps, mocks: { pause, loadGates, runGate, log } }
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
