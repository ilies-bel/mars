/**
 * Health-check registry — shared contract for all scheduled and reactive
 * health checks in the Mars orchestrator.
 *
 * Design goals (from the PRD):
 *
 *   1. ONE place where "healthy" is defined. Every check the daemon knows
 *      how to make is registered here so `mars doctor` can enumerate them.
 *
 *   2. Routing is declared statically on the check. The Steward reads the
 *      `findingRoute` field to decide what to do with a failing result without
 *      running any model or additional runtime logic — a scheduled pass costs
 *      nothing to evaluate.
 *
 *   3. Three routes, no more:
 *      - 'fix-task'     — Mars can repair it: enqueue work, report afterwards.
 *      - 'notice'       — standing fact the operator may live with: state it
 *                         once; the operator can acknowledge or silence it.
 *      - 'action-queue' — genuinely needs a human decision: one row in the
 *                         action queue, cleared when the condition goes away.
 *
 *   4. Doctor only ever reports. It never pauses, never files, never fixes.
 *      Checks with an immediate reactive response (e.g. baseline-broken) keep
 *      that reactive path outside this module; this registry is the read path.
 *
 * All dependencies are injected at registration time — the registry itself has
 * no side effects and needs no DB or daemon reference.
 */

import type { ActionQueueKind } from '../lib/action-queue-kinds.js'

// ── Routing ───────────────────────────────────────────────────────────────────

/**
 * Which route a health finding takes.
 *
 * Routing is declared statically on the check descriptor so the Steward can
 * choose the right handler without inspecting the payload at scheduling time.
 *
 *   'fix-task'     — Mars can repair the condition automatically.  The Steward
 *                    enqueues a fix task and reports what it did afterwards.
 *   'notice'       — A standing fact the operator may reasonably choose to live
 *                    with.  Mars states it once; the operator can acknowledge or
 *                    silence it permanently.
 *   'action-queue' — The automated chain has run out of moves and a human
 *                    decision is required.  One action-queue row is raised;
 *                    it clears automatically when a later pass sees the
 *                    condition gone.
 */
export type HealthFindingRoute = 'fix-task' | 'notice' | 'action-queue'

// ── Descriptor ────────────────────────────────────────────────────────────────

/**
 * Static metadata every health check declares about itself.
 *
 * The descriptor is read at registration time — the registry, doctor CLI, and
 * Steward all key off it without calling `run()`.
 */
export interface HealthCheckDescriptor {
  /**
   * Stable machine identifier.  Unique across the registry.
   * Used as the key for get() and for deduplication on re-registration.
   */
  readonly id: string

  /**
   * Short human label shown in `mars doctor` output.
   * Example: "Integration branch: required gate passes"
   */
  readonly label: string

  /**
   * Which route a failing result takes.
   * The Steward reads this at scheduling time, before calling run().
   */
  readonly findingRoute: HealthFindingRoute

  /**
   * Action-queue kind tied to this check.
   *
   * Required when `findingRoute` is `'action-queue'` (the Steward uses it to
   * raise/resolve the AQ item).  Also present on checks with a reactive path
   * that raises an AQ item independently of the scheduled pass (e.g.
   * baseline-broken) so the registry entry stays coherent with the live row.
   *
   * Omit for `'fix-task'` and `'notice'` routes unless the check also needs
   * to raise a complementary AQ item.
   */
  readonly actionQueueKind?: ActionQueueKind
}

// ── Result ────────────────────────────────────────────────────────────────────

/**
 * The result a health check returns after running.
 *
 * `run()` must never throw — errors are caught internally and returned as
 * either a conservative pass (when the error is transient and the check should
 * not change state) or a fail with an error detail (when the error is itself
 * the finding).
 *
 * `payload` on a fail result is opaque to the registry; the Steward passes it
 * to the route handler (action-queue raise, task-prompt builder, or notice
 * body renderer).
 */
export type HealthCheckResult =
  | { status: 'pass' }
  | { status: 'fail'; detail: string; payload: Record<string, unknown> }

// ── Check ─────────────────────────────────────────────────────────────────────

/**
 * One registered health check.
 *
 * Implementations live in their own modules and are registered at daemon boot.
 * The descriptor is the static contract; run() is the runtime probe.
 */
export interface HealthCheck {
  readonly descriptor: HealthCheckDescriptor
  /**
   * Probe the condition.  Must not throw — every unhandled error inside run()
   * should be caught and returned as { status: 'pass' } (conservative) or
   * { status: 'fail', detail: errorMessage, payload: {} } depending on
   * whether the error is itself the finding.
   */
  run(): Promise<HealthCheckResult>
}

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * The global health-check registry.
 *
 * Checks register themselves here at daemon boot.  The Steward iterates the
 * registry on its schedule; `mars doctor` also iterates it to print every
 * check the daemon knows how to make — including checks it could not run in
 * the current conditions and why.
 */
export interface HealthRegistry {
  /**
   * Register a check.  If a check with the same `descriptor.id` is already
   * registered, it is replaced in-place (position preserved for all() order).
   */
  register(check: HealthCheck): void
  /**
   * All currently registered checks, in registration order.
   * Replacing a registration via a duplicate id preserves its position.
   */
  all(): HealthCheck[]
  /** Look up one check by descriptor id, or undefined if not registered. */
  get(id: string): HealthCheck | undefined
}

/**
 * Create an empty health registry.
 *
 * The registry itself is a pure in-memory data structure with no side effects.
 * It is typically created once at daemon boot and shared with the Steward, the
 * doctor CLI, and every check registration site.
 */
export const createHealthRegistry = (): HealthRegistry => {
  // Preserve insertion order; allow id-keyed replacement.
  const order: string[] = []
  const map = new Map<string, HealthCheck>()

  return {
    register(check: HealthCheck): void {
      const { id } = check.descriptor
      if (!map.has(id)) {
        order.push(id)
      }
      map.set(id, check)
    },

    all(): HealthCheck[] {
      return order.map((id) => map.get(id)!)
    },

    get(id: string): HealthCheck | undefined {
      return map.get(id)
    },
  }
}
