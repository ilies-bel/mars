import { resolveStateClient } from '../core/store/state-client.js'
import type { VerifyGateInput } from '../core/verify-gates.js'
import { reportUncoveredVerifyCoverage } from '../core/lib/verify-uncovered.js'

/**
 * Gate input accepted by the onboarding seed path.
 *
 * Extends the standard {@link VerifyGateInput} with an optional `evidence`
 * field — the observation that justified including this gate during detection.
 * Evidence is forwarded into the raised verify-uncovered payload so the
 * operator sees why the gate was proposed.
 */
export type OnboardingGateInput = VerifyGateInput & { evidence?: string }

/**
 * Propose the gate set discovered while onboarding a new repository.
 *
 * Instead of inserting gates directly, this raises one `verify-uncovered`
 * action-queue item per detected gate so the operator can accept each gate
 * individually. The gate set starts empty and accumulates by operator
 * confirmation.
 *
 * A non-empty registry is a complete no-op: the operator already owns the
 * gates, so onboarding proposals are suppressed.
 *
 * Returns `{ proposed, skipped }` where `proposed` is the number of items
 * raised and `skipped` is true when the registry was already non-empty.
 */
export const proposeOnboardingVerifyGates = async (
  gates: readonly OnboardingGateInput[],
): Promise<{ proposed: number; skipped: boolean }> => {
  const client = resolveStateClient()
  const existing = await client.execute('SELECT COUNT(*) AS count FROM verify_gates')
  const count = Number(existing.rows[0]?.count ?? 0)
  if (count > 0) return { proposed: 0, skipped: true }

  for (const gate of gates) {
    await reportUncoveredVerifyCoverage({
      changedPaths: [gate.scope ?? '.'],
      proposedGate: {
        name: gate.name,
        cmd: gate.cmd,
        args: gate.args ?? [],
        scope: gate.scope ?? '.',
        evidence: gate.evidence ?? 'detected at onboarding',
      },
    })
  }

  return { proposed: gates.length, skipped: false }
}
