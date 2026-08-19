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
