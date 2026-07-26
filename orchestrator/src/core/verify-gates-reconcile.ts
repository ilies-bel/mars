/**
 * Daemon-startup backfill of verify_gates from the supervisors manifest.
 *
 * Reads the supervisors manifest at the given path and inserts any declared
 * verify gates that are not yet in the verify_gates table (source='manifest').
 * Existing rows — regardless of source — are left untouched.
 *
 * This runs once per daemon start, after ensureVerifyGatesSchema, so existing
 * repos whose verify_gates table is empty get populated automatically without
 * any operator gesture.
 */

import { seedVerifyGatesFromManifest } from '../init/seed-verify-gates.js'

/**
 * Backfill verify gates from the supervisors manifest at
 * `supervisorsManifestPath` into the verify_gates table. Safe to call on
 * every daemon start: inserts only rows whose (scope, name) pair is not
 * already present, so the operation is idempotent.
 *
 * When gates are inserted, `log` is called with a summary line. When 0 are
 * inserted (table already populated or manifest empty/absent), `log` is not
 * called.
 *
 * @param supervisorsManifestPath - Absolute path to `.mars/supervisors/manifest.json`.
 * @param log - Optional sink for the backfill summary line; defaults to a no-op.
 */
export const reconcileVerifyGatesOnStartup = async (
  supervisorsManifestPath: string,
  log: (msg: string) => void = () => {},
): Promise<void> => {
  const { inserted } = await seedVerifyGatesFromManifest(supervisorsManifestPath)
  if (inserted > 0) {
    log(`verify-gates backfilled from manifest: ${inserted}`)
  }
}
