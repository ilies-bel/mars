import { loadVerifyScopes } from '../core/lib/git/verify.js'
import { addVerifyGate, listVerifyGates } from '../core/verify-gates.js'

/**
 * Materialise verify gates declared in the supervisors manifest at
 * `manifestPath` into the verify_gates table. Each (scope, name) pair that is
 * not already present is inserted with `source='manifest'`; existing pairs are
 * left alone. Idempotent: safe to call on every `mars init` or `mars update`
 * run.
 *
 * Returns the count of rows inserted and skipped so callers can log progress.
 */
export const seedVerifyGatesFromManifest = async (
  manifestPath: string,
): Promise<{ inserted: number; skipped: number }> => {
  const scopes = await loadVerifyScopes(manifestPath)

  const existing = await listVerifyGates()
  const existingKeys = new Set(existing.map((g) => `${g.scope}\x00${g.name}`))

  let inserted = 0
  let skipped = 0

  for (const { scope, steps } of scopes) {
    for (const step of steps) {
      const key = `${scope}\x00${step.name}`
      if (existingKeys.has(key)) {
        skipped++
        continue
      }
      await addVerifyGate({
        scope,
        name: step.name,
        cmd: step.cmd,
        args: [...step.args],
        required: step.required,
        ...(step.tier !== undefined ? { tier: step.tier } : {}),
        source: 'manifest',
      })
      inserted++
    }
  }

  return { inserted, skipped }
}
