/**
 * computeMissingGates — detect which lever-registry verify-gate recipes are
 * absent from the repo's currently-detected gate set.
 *
 * Used by the onboarding dispatch step to decide which gates still need to be
 * installed. The result is sorted by maturity level so the most fundamental
 * gates (typecheck) are recommended before more advanced ones (e2e).
 *
 * When `repoRoot` is supplied, recipes whose `predicate` returns false are
 * filtered out. If filtering by predicate would leave the result empty — a
 * repo whose stack none of the recipes apply to — the function falls back to
 * the maturity-ordered list without predicate filtering and sets `isFallback`
 * to `true` so the caller can emit a neutral problem statement (DEC-15
 * guarantee: onboarding always has something to dispatch).
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
 *
 * When `repoRoot` is provided, recipes with a `predicate` are filtered by
 * evaluating that predicate against the repo root. Recipes without a predicate
 * are always included. If all predicate-filtered entries are removed (i.e.
 * no recipe applies to this repo's stack), the function falls back to the
 * full maturity-ordered list and sets `isFallback: true`.
 */
export function computeMissingGates(
  detected: ReadonlyArray<{ name: string }>,
  repoRoot?: string,
): { entries: LeverRegistryEntry[]; isFallback: boolean } {
  const registry = loadLeverRegistry()
  const presentNames = new Set(detected.map((d) => d.name))

  // Step 1: filter by gate name presence (existing filter)
  const nameFiltered = registry
    .filter((entry) => entry.recipe?.verifyGate !== undefined)
    .filter((entry) => !presentNames.has(entry.recipe!.verifyGate!.name))

  if (nameFiltered.length === 0) {
    return { entries: [], isFallback: false }
  }

  // Step 2: apply predicate filter when repoRoot is provided
  if (repoRoot !== undefined) {
    const predFiltered = nameFiltered.filter((entry) => {
      const pred = entry.recipe?.predicate
      // no predicate → always applicable
      return pred ? pred(repoRoot) : true
    })

    if (predFiltered.length > 0) {
      return { entries: predFiltered.sort(byMaturity), isFallback: false }
    }

    // All predicates failed: fall back to maturity-ordered list so onboarding
    // always has a gate to dispatch (DEC-15).
    return { entries: nameFiltered.sort(byMaturity), isFallback: true }
  }

  // No repoRoot: skip predicate filtering (backwards-compat; predicates not evaluated)
  return { entries: nameFiltered.sort(byMaturity), isFallback: false }
}
