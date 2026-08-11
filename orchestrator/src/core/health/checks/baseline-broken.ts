/**
 * Health check: integration branch passes all required task-tier gates.
 *
 * Registers `baseline.broken` in the singleton CheckDef registry so
 * `mars doctor` can enumerate it and the Steward can run it on a schedule.
 *
 * The reactive dispatch-halting path in `createBaselineHealthChecker` is
 * unchanged — it continues to pause dispatch and raise a `baseline-broken`
 * action-queue row the moment a gate fails.  This check is the scheduled
 * mirror: it calls the same {@link isBaselineBroken} predicate (factored out
 * of baseline-health.ts) and returns a finding with the same findingKey
 * (`'baseline-broken'`) so any underlying AQ dedup by signature collapses
 * both triggers to a single open row.
 *
 * Runtime wiring:
 *   The daemon calls {@link wireBaselineBrokenCheck} at boot after setting up
 *   its gate-loading and gate-running infrastructure.  Until wired, `run()`
 *   conservatively returns ok=true (nothing to report).
 *
 * Prereqs:
 *   'daemon' — needed for gate configuration (daemon must be reachable).
 *   'git'    — gates may invoke git operations.
 */

import { isBaselineBroken, type BaselineGate, type GateResult } from '../../daemon/baseline-health.js'
import { registerCheck } from '../registry.js'

// ── Dep injection ─────────────────────────────────────────────────────────────

export interface BaselineBrokenDeps {
  /** Absolute path to the repo root (where the integration branch lives). */
  repoRoot: string
  /** Load the required task-tier gates that should be probed. */
  loadGates: () => Promise<BaselineGate[]>
  /** Run a single gate in `cwd`. Returns the raw process result. */
  runGate: (gate: BaselineGate, cwd: string) => Promise<GateResult>
}

let _deps: BaselineBrokenDeps | null = null

/**
 * Wire the check with runtime dependencies.
 *
 * Must be called by the daemon at boot before the first scheduled health pass.
 * Tests call this with mocked deps to exercise the `run()` behaviour.
 */
export function wireBaselineBrokenCheck(deps: BaselineBrokenDeps): void {
  _deps = deps
}

// ── Registration ──────────────────────────────────────────────────────────────

registerCheck({
  id: 'baseline.broken',
  description: 'Integration branch: all required task-tier gates pass',
  requires: ['daemon', 'git'],
  route: 'alert',

  async run(_ctx) {
    if (_deps === null) {
      // Not yet wired — conservative pass so we don't report false positives
      // before the daemon finishes booting.
      return { ok: true }
    }

    const detection = await isBaselineBroken(_deps)

    if (detection.loadError || !detection.broken) {
      return { ok: true }
    }

    const detail = detection.failingGateName
      ? `Gate "${detection.failingGateName}" fails on the integration branch`
      : 'A required gate fails on the integration branch'

    // findingKey mirrors the reactive path's action-queue signature
    // ('baseline-broken') so a shared underlying AQ raise function deduplicates
    // both triggers to a single open row.
    return { ok: false, findingKey: 'baseline-broken', detail }
  },
})
