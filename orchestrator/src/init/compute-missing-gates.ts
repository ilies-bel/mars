/**
 * computeMissingGates — detect which lever-registry verify-gate recipes are
 * absent from the repo's currently-detected gate set.
 *
 * Used by the onboarding dispatch step to decide which gates still need to be
 * installed. The result is sorted by maturity level so the most fundamental
 * gates (typecheck) are recommended before more advanced ones (e2e).
 */

import { loadLeverRegistry, type LeverRegistryEntry } from '../core/lib/lever-registry.js'

/**
 * Maturity-level sort order. Lower number → higher priority (listed first).
 * Levels not present in this map fall to a shared last position.
 */
const MATURITY_ORDER: Record<string, number> = {
  typecheck: 0,
  tests: 1,
  e2e: 2,
}

/**
 * Compare two registry entries by their recipe maturity level.
 * Entries without a recognised maturity level sort last.
 */
function byMaturity(a: LeverRegistryEntry, b: LeverRegistryEntry): number {
  const orderA = a.recipe ? (MATURITY_ORDER[a.recipe.maturityLevel] ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
  const orderB = b.recipe ? (MATURITY_ORDER[b.recipe.maturityLevel] ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
  return orderA - orderB
}

/**
 * Returns lever-registry entries whose `recipe.verifyGate` is not yet present
 * in `detected`, sorted by maturity priority (typecheck → tests → e2e).
 *
 * Matching is by gate `name` only — differences in `cmd` or `args` between a
 * detected gate and the registry recipe do not affect presence detection.
 *
 * The parameter accepts both `DetectedVerifyGate[]` and `VerifyGateInput[]`
 * since both carry a `name` field.
 */
export function computeMissingGates(
  detected: ReadonlyArray<{ name: string }>,
): LeverRegistryEntry[] {
  const registry = loadLeverRegistry()
  const presentNames = new Set(detected.map((d) => d.name))

  return registry
    .filter((entry) => entry.recipe?.verifyGate !== undefined)
    .filter((entry) => !presentNames.has(entry.recipe!.verifyGate!.name))
    .sort(byMaturity)
}
