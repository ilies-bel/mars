/**
 * Singleton health-check registry with prereq/skip vocabulary.
 *
 * Checks declare which runtime prerequisites they need (daemon, git, fs, db).
 * A caller (mars doctor or the Steward) passes the Set of prereqs it can
 * satisfy; runChecks() runs the subset whose requirements are met and returns
 * 'skipped' entries with a machine-readable reason for the rest.
 *
 * `CheckResult.status` is this module's spelling of the shared tri-state
 * {@link VerificationOutcome} (ADR-0070): 'ok' is 'pass', 'finding' is 'fail'
 * (positive evidence — the check ran and the condition was found broken),
 * 'skipped' is 'cant-verify' (a missing prerequisite meant the check never
 * ran at all, so absence is never reported as a finding). See
 * `core/lib/verification-outcome.ts` for the shared contract.
 *
 * Design constraints:
 *   - Each check id must be unique — registerCheck() throws on duplicates.
 *   - run() must never throw; catch all errors internally.
 *   - The registry has no side effects: no DB, no daemon reference.
 */

import { verificationOutcomeLabels, type VerificationOutcome } from '../lib/verification-outcome.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export type CheckId = string

/** Runtime prerequisite a check requires before it can attempt to run. */
export type Prereq = 'daemon' | 'git' | 'fs' | 'db'

/** The set of prerequisites the calling context can satisfy. */
export interface CheckContext {
  prereqs: Set<Prereq>
}

/** What a check's run() returns. */
export interface CheckOutcome {
  ok: boolean
  /** Stable key for the finding, usable as a dedup key by the Steward. */
  findingKey?: string
  /** Human-readable detail shown by mars doctor. */
  detail?: string
}

/** Static declaration of one health check. */
export interface CheckDef {
  readonly id: CheckId
  /** Short human label shown in `mars doctor` output. */
  readonly description: string
  /** Prerequisites the context must satisfy for this check to run. */
  readonly requires: Prereq[]
  /** How a failing result is routed by the Steward. */
  readonly route: 'fix' | 'notice' | 'alert'
  /** Probe the condition.  Must not throw. */
  run(ctx: CheckContext): Promise<CheckOutcome>
}

/**
 * This module's status vocabulary, expressed as a relabelling of the shared
 * {@link VerificationOutcome} tri-state (ADR-0070) — see the module doc for
 * what each canonical state means here.
 */
const STATUS = verificationOutcomeLabels({
  pass: 'ok',
  fail: 'finding',
  'cant-verify': 'skipped',
})

/** This module's on-the-wire status type: 'ok' | 'finding' | 'skipped'. */
export type CheckStatus = (typeof STATUS)[VerificationOutcome]

/** Per-check result returned by runChecks(). */
export interface CheckResult {
  readonly id: CheckId
  readonly status: CheckStatus
  /**
   * Set on 'skipped' results: 'prereq:<name>' identifies which missing
   * prerequisite caused the skip.
   */
  readonly reason?: string
  readonly outcome?: CheckOutcome
}

// ── Registry ──────────────────────────────────────────────────────────────────

/** Module-level singleton. Cleared on vi.resetModules() in tests. */
const _checks = new Map<CheckId, CheckDef>()

/**
 * Register a health check.
 *
 * @throws if a check with the same id is already registered.
 */
export function registerCheck(def: CheckDef): void {
  if (_checks.has(def.id)) {
    throw new Error(`Health check '${def.id}' is already registered`)
  }
  _checks.set(def.id, def)
}

/**
 * Return every registered check in registration order.
 * Each entry includes id, description, requires, and route —
 * all fields mars doctor needs to enumerate checks.
 */
export function listChecks(): CheckDef[] {
  return Array.from(_checks.values())
}

/**
 * Run the checks whose prerequisites are satisfied by ctx.
 *
 * For each check:
 *   - If any required prereq is absent from ctx.prereqs: status='skipped',
 *     reason='prereq:<name>' (the first missing prereq).
 *   - Otherwise: call run(); status='ok' or 'finding'.
 */
export async function runChecks(ctx: CheckContext): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const def of _checks.values()) {
    const missingPrereq = def.requires.find((p) => !ctx.prereqs.has(p))
    if (missingPrereq !== undefined) {
      results.push({ id: def.id, status: STATUS['cant-verify'], reason: `prereq:${missingPrereq}` })
      continue
    }
    const outcome = await def.run(ctx)
    results.push({
      id: def.id,
      status: outcome.ok ? STATUS.pass : STATUS.fail,
      outcome,
    })
  }
  return results
}
