/**
 * Singleton health-check registry with prereq/skip vocabulary.
 *
 * Checks declare which runtime prerequisites they need (daemon, git, fs, db).
 * A caller (mars doctor or the Steward) passes the Set of prereqs it can
 * satisfy; runChecks() runs the subset whose requirements are met and returns
 * 'skipped' entries with a machine-readable reason for the rest.
 *
 * Design constraints:
 *   - Each check id must be unique — registerCheck() throws on duplicates.
 *   - run() must never throw; catch all errors internally.
 *   - The registry has no side effects: no DB, no daemon reference.
 */

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

/** Per-check result returned by runChecks(). */
export interface CheckResult {
  readonly id: CheckId
  readonly status: 'ok' | 'finding' | 'skipped'
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
      results.push({ id: def.id, status: 'skipped', reason: `prereq:${missingPrereq}` })
      continue
    }
    const outcome = await def.run(ctx)
    results.push({
      id: def.id,
      status: outcome.ok ? 'ok' : 'finding',
      outcome,
    })
  }
  return results
}
