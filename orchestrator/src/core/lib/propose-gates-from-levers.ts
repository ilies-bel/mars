/**
 * proposeGatesFromLevers — wire lever recipes to the verify-uncovered raiser.
 *
 * Scans all lever registry entries that carry a `verifyGate` spec, compares
 * them against the set of already-registered verify gates, and raises a
 * `verify-uncovered` action-queue item for each (scope, name) pair that is
 * not yet covered.
 *
 * Skip conditions (both checked before calling the raiser):
 *  1. A gate with the same (scope, name) is already registered in the DB.
 *  2. An open `verify-uncovered` item with the same proposedGate.scope and
 *     proposedGate.name already exists (prevents duplicate proposals across
 *     repeated calls).
 *
 * Caller: the `lever-gate-sweep` periodic daemon sweep (`core/daemon/sweeps.ts`)
 * runs this function hourly and on every daemon boot so the gate catalogue
 * stays in sync with the lever registry without requiring a manual trigger.
 * The function is idempotent and safe to call repeatedly — it converges on
 * the first run that finds all gaps and is a no-op thereafter.
 */

import { resolveContext } from '../context.js'
import { listVerifyGates } from '../verify-gates.js'
import { listActionQueueItems } from './action-queue.js'
import { getLeversWithVerifyGate } from './lever-registry.js'
import type { VerifyUncoveredPayload } from './payload-contracts/verify.js'
import { reportUncoveredVerifyCoverage } from './verify-uncovered.js'

/**
 * Propose verify gates for all lever recipes that have a `verifyGate` spec
 * but whose gate is not yet registered.
 *
 * Recipes whose `predicate` returns false for the current repo root are
 * excluded from proposals — no verify-uncovered item is raised for a gate
 * that cannot apply to the repo's stack (HR-8).
 *
 * Returns the number of proposals raised and the number of levers skipped
 * (either already registered, already open as a proposal, or predicate-filtered).
 */
export async function proposeGatesFromLevers(): Promise<{ proposed: number; skipped: number }> {
  const { repoRoot } = resolveContext()
  const allLevers = getLeversWithVerifyGate()

  // Predicate-filtered levers are counted as skipped: they are not applicable
  // to this repo's stack and no verify-uncovered item is raised for them (HR-8).
  const levers = allLevers.filter(({ recipe }) => {
    const pred = recipe.predicate
    return pred ? pred(repoRoot) : true
  })

  // Build a key set for already-registered gates so we can skip them.
  const registeredGates = await listVerifyGates()
  const registeredKeys = new Set(registeredGates.map((g) => `${g.scope}:${g.name}`))
  // Name-only index: when a lever has no explicit scope, ANY gate with that name
  // in this repo already covers the intent — the check exists, just scoped
  // per-package rather than at the root. Raising a proposal for a root-scoped
  // typecheck gate when orchestrator/typecheck, ui/typecheck, etc. already exist
  // is a false positive (the exact bug that produced open row 805e7f5d).
  const registeredNames = new Set(registeredGates.map((g) => g.name))

  // Build a key set for already-open verify-uncovered items so we don't raise
  // a duplicate proposal for a gate that is already pending operator action.
  const openItems = await listActionQueueItems('open', { kind: 'verify-uncovered' })
  const alreadyProposedKeys = new Set<string>()
  const alreadyProposedNames = new Set<string>()
  for (const item of openItems) {
    const payload = item.payload as unknown as VerifyUncoveredPayload
    if (payload.proposedGate) {
      alreadyProposedKeys.add(`${payload.proposedGate.scope}:${payload.proposedGate.name}`)
      alreadyProposedNames.add(payload.proposedGate.name)
    }
  }

  let proposed = 0
  // Predicate-filtered entries (allLevers not in levers) count toward skipped.
  let skipped = allLevers.length - levers.length

  for (const { recipe } of levers) {
    const spec = recipe.verifyGate!
    const scope = spec.scope ?? '.'
    const key = `${scope}:${spec.name}`

    // When the lever declares no explicit scope, match by gate name only:
    // a per-package `typecheck` gate at any scope satisfies the lever.
    // When the lever declares a specific scope, require an exact scope:name match.
    const isGateRegistered = spec.scope
      ? registeredKeys.has(key)
      : registeredNames.has(spec.name)
    const isAlreadyProposed = spec.scope
      ? alreadyProposedKeys.has(key)
      : alreadyProposedNames.has(spec.name)

    if (isGateRegistered || isAlreadyProposed) {
      skipped++
      continue
    }

    await reportUncoveredVerifyCoverage({
      changedPaths: [scope],
      proposedGate: {
        name: spec.name,
        cmd: spec.cmd,
        args: spec.args,
        scope,
        evidence: recipe.triggerPattern,
      },
    })

    proposed++
    // Guard against two levers sharing the same (scope, name) within this run.
    alreadyProposedKeys.add(key)
    alreadyProposedNames.add(spec.name)
  }

  return { proposed, skipped }
}
