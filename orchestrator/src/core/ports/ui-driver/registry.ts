/**
 * UiDriver registry — the open, runtime-registrable set of `UiDriver` Port
 * implementations.
 *
 * ## Resolution model
 *
 * Unlike the env-var-selected ports (verifier, executor, vcs, codeIndex),
 * the UiDriver port uses **probe-based auto-detection**. `resolveUiDriver`
 * iterates registered implementations in registration order, calls `probe()`
 * on each, and returns the first that reports `state: 'available'`. When
 * none is available, it returns `null` — the caller is responsible for
 * raising the operator card (see `arc-verifier.ts`).
 *
 * ## Registration order
 *
 * Built-ins register in preference order at module body time (a side effect
 * of importing this module). Currently:
 *
 *  1. `playwright-local` (full Playwright, most capable) — registered first
 *  2. `chrome-exec` (system Chrome, cheapest to install) — registered second
 *
 * The resolver picks the first whose probe passes; the ordering ensures the
 * most capable implementation is preferred when multiple are available.
 *
 * ## Open registry
 *
 * Third-party implementations can call `registerUiDriver(impl)` at any
 * time. The resolver immediately picks them up on the next call — no
 * restart, no change to this module. The test suite verifies this property.
 *
 * ## Do not self-register in implementation modules
 *
 * Implementation modules (playwright-local.ts, chrome-exec.ts) must NOT
 * import this registry module. The registry imports them (same pattern as
 * `vcs/registry.ts → local-git.ts`) to avoid temporal dead zone cycles.
 */

import { createServiceRegistry, type Disposer } from '@mars/workflow'
import { chromeExecDriver } from './chrome-exec.js'
import { playwrightLocalDriver } from './playwright-local.js'
import type { UiDriver, UiDriverProbeResult } from './types.js'

// ---------------------------------------------------------------------------
// Internal registry and registration-order tracking
// ---------------------------------------------------------------------------

type UiDriverMap = Record<string, UiDriver>
const registry = createServiceRegistry<UiDriverMap>()

/** Registration order — preserved so the resolver iterates in insertion order. */
const registrationOrder: string[] = []

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a `UiDriver` implementation. Returns a `Disposer` that unregisters
 * it (for tests and runtime teardown).
 *
 * Implementations registered AFTER the built-ins are appended to the end of
 * the resolution order. To insert at a specific position, call `clear` and
 * re-register in the desired order — or simply rely on the probe-based
 * selection which already ignores unavailable implementations.
 */
export const registerUiDriver = (impl: UiDriver): Disposer => {
  if (!registrationOrder.includes(impl.kind)) {
    registrationOrder.push(impl.kind)
  }
  return registry.provide(impl.kind, impl)
}

/**
 * Return all registered implementations in registration order.
 * The returned array is a snapshot; later registrations do not mutate it.
 */
export const listUiDrivers = (): readonly UiDriver[] =>
  registrationOrder
    .filter((kind) => registry.has(kind))
    .map((kind) => registry.require(kind))

/**
 * Probe every registered implementation in order and return the first one
 * whose `probe(repoRoot)` reports `state: 'available'`, together with its
 * probe result. Returns `null` when no implementation is available.
 *
 * @param repoRoot - Absolute path to the repository root to probe against.
 */
export const resolveUiDriver = (
  repoRoot: string,
): { driver: UiDriver; probeResult: UiDriverProbeResult } | null => {
  for (const driver of listUiDrivers()) {
    const probeResult = driver.probe(repoRoot)
    if (probeResult.state === 'available') {
      return { driver, probeResult }
    }
  }
  return null
}

/**
 * Collect probe results from every registered implementation, sorted by
 * `installCost` ascending (cheapest first). Used when building the "nothing
 * is available" operator card so the cheapest-to-install option is listed
 * first.
 */
export const collectProbeResults = (
  repoRoot: string,
): ReadonlyArray<{ driver: UiDriver; probeResult: UiDriverProbeResult }> =>
  [...listUiDrivers()]
    .sort((a, b) => a.installCost - b.installCost)
    .map((driver) => ({ driver, probeResult: driver.probe(repoRoot) }))

// ---------------------------------------------------------------------------
// Built-in registrations (side effect on import)
// ---------------------------------------------------------------------------

// playwright-local is preferred (most capable); chrome-exec is cheaper to
// install. Registration order = resolution priority order.
registerUiDriver(playwrightLocalDriver)
registerUiDriver(chromeExecDriver)
