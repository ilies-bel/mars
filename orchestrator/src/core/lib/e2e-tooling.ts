/**
 * E2E tooling probe — inspects a repo root and reports whether a live E2E
 * pass is possible without any per-task configuration.
 *
 * ## Architecture
 *
 * This module is a thin resolver over the `UiDriver` port registry
 * (`core/ports/ui-driver/registry.ts`). Each registered implementation
 * declares a `probe()` method; this resolver iterates them in registration
 * order and returns the first that reports `state: 'available'`.
 *
 * When **no** implementation is available it aggregates every candidate's
 * `setupSteps` (cheapest candidate first, deduped) so the operator card
 * lists actionable install steps in one place.
 *
 * ## Stability
 *
 * The `E2eToolingReport` shape is stable — callers (`arc-verifier.ts`,
 * `reconcilers.ts`) access only `available`, `missing`, and `setupSteps`.
 * The `runner` field now carries the resolved implementation's `kind` (e.g.
 * `'playwright-local'` or `'chrome-exec'`) rather than the hard-coded
 * `'playwright'` it used to carry; callers that do not inspect `runner` are
 * unaffected.
 *
 * ## Test isolation
 *
 * `probeE2eTooling` accepts an optional `drivers` override so tests can pass
 * a controlled list of implementations rather than relying on the global
 * registry (which may resolve to a real browser available on the test
 * machine). Production callers omit the override and get the full registry.
 */

import type { UiDriver } from '../ports/ui-driver/types.js'
import { collectProbeResults, resolveUiDriver } from '../ports/ui-driver/registry.js'

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface E2eToolingReport {
  /** Whether at least one E2E tooling implementation is fully available. */
  available: boolean
  /**
   * The `kind` of the resolved UiDriver implementation when `available` is
   * true (e.g. `'playwright-local'` or `'chrome-exec'`); `'none'` when no
   * implementation was found.
   */
  runner: string
  /** Human-readable descriptions of what is absent (one entry per candidate). */
  missing: string[]
  /** Exact shell commands to install the missing tooling, cheapest first, deduped. */
  setupSteps: string[]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspect `repoRoot` to determine whether any registered E2E tooling
 * implementation is available. Returns an {@link E2eToolingReport} describing
 * what is available, what is missing, and how to fix it.
 *
 * Resolution: iterates registered {@link UiDriver} implementations in
 * registration order and returns the first whose `probe()` reports
 * `state: 'available'`. When none is available, aggregates all candidates'
 * setup steps (cheapest first, deduped) into the report.
 *
 * This is a pure filesystem read — no processes are spawned and no network is
 * touched.
 *
 * @param repoRoot - Absolute path to the repository root to probe.
 * @param options.drivers - Optional override of the driver list for test
 *   isolation. Production callers omit this and get the global registry.
 */
export const probeE2eTooling = (
  repoRoot: string,
  options?: { drivers?: readonly UiDriver[] },
): E2eToolingReport => {
  // Use the injected driver list for tests; otherwise pull from the live registry.
  const drivers = options?.drivers

  if (drivers !== undefined) {
    // Test path: iterate the explicit driver list.
    for (const driver of drivers) {
      const result = driver.probe(repoRoot)
      if (result.state === 'available') {
        return { available: true, runner: driver.kind, missing: [], setupSteps: [] }
      }
    }
    // None available — aggregate candidates (cheapest first).
    const sorted = [...drivers].sort((a, b) => a.installCost - b.installCost)
    const missing: string[] = []
    const setupSteps: string[] = []
    const seen = new Set<string>()
    for (const driver of sorted) {
      const result = driver.probe(repoRoot)
      missing.push(result.evidence)
      for (const step of result.setupSteps) {
        if (!seen.has(step)) {
          seen.add(step)
          setupSteps.push(step)
        }
      }
    }
    return { available: false, runner: 'none', missing, setupSteps }
  }

  // Production path: use the live registry.
  const resolved = resolveUiDriver(repoRoot)
  if (resolved !== null) {
    return {
      available: true,
      runner: resolved.driver.kind,
      missing: [],
      setupSteps: [],
    }
  }

  // No implementation available — collect all candidates' steps (cheapest first, deduped).
  const candidates = collectProbeResults(repoRoot)
  const missing: string[] = []
  const setupSteps: string[] = []
  const seen = new Set<string>()
  for (const { probeResult } of candidates) {
    missing.push(probeResult.evidence)
    for (const step of probeResult.setupSteps) {
      if (!seen.has(step)) {
        seen.add(step)
        setupSteps.push(step)
      }
    }
  }

  return { available: false, runner: 'none', missing, setupSteps }
}
