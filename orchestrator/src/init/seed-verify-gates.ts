import { randomUUID } from 'node:crypto'
import { withTransaction } from '../core/lib/db.js'
import { resolveStateClient } from '../core/store/state-client.js'
import type { VerifyGateInput } from '../core/verify-gates.js'

/**
 * Install the gate set discovered while onboarding a new repository.
 *
 * The registry becomes operator-owned after this first write. A non-empty
 * registry is consequently a complete no-op, including when the supplied
 * gate set differs from the one originally detected.
 */
export const installOnboardingVerifyGates = async (
  gates: readonly VerifyGateInput[],
): Promise<{ inserted: number; skipped: boolean }> => {
  const client = resolveStateClient()
  return withTransaction(client, async (tx) => {
    const existing = await tx.execute('SELECT COUNT(*) AS count FROM verify_gates')
    const count = Number(existing.rows[0]?.count ?? 0)
    if (count > 0) return { inserted: 0, skipped: true }

    for (const gate of gates) {
      await tx.execute(
        `INSERT INTO verify_gates
          (id, scope, name, cmd, args_json, required, tier, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'onboarding', ?)`,
        [
          randomUUID(),
          gate.scope ?? '.',
          gate.name,
          gate.cmd,
          JSON.stringify(gate.args ?? []),
          gate.required === false ? 0 : 1,
          gate.tier ?? 'task',
          Date.now(),
        ],
      )
    }

    return { inserted: gates.length, skipped: false }
  })
}
