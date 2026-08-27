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
  const levers = getLeversWithVerifyGate().filter(({ recipe }) => {
    const pred = recipe.predicate
    // no predicate → always applicable; predicate returning false → skip
    return pred ? pred(repoRoot) : true
  })

  // Build a key set for already-registered gates so we can skip them.
  const registeredGates = await listVerifyGates()
  const registeredKeys = new Set(registeredGates.map((g) => `${g.scope}:${g.name}`))

  // Build a key set for already-open verify-uncovered items so we don't raise
  // a duplicate proposal for a gate that is already pending operator action.
  const openItems = await listActionQueueItems('open', { kind: 'verify-uncovered' })
  const alreadyProposedKeys = new Set<string>()
  for (const item of openItems) {
    const payload = item.payload as unknown as VerifyUncoveredPayload
    if (payload.proposedGate) {
      alreadyProposedKeys.add(`${payload.proposedGate.scope}:${payload.proposedGate.name}`)
    }
  }

  let proposed = 0
  let skipped = 0

  for (const { recipe } of levers) {
    const spec = recipe.verifyGate!
    const scope = spec.scope ?? '.'
    const key = `${scope}:${spec.name}`

    if (registeredKeys.has(key) || alreadyProposedKeys.has(key)) {
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
  }

  return { proposed, skipped }
}
