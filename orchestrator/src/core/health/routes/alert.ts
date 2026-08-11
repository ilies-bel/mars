/**
 * Alert route handler for the Steward's scheduled health pass.
 *
 * When a check with route='alert' returns a finding, this module decides
 * whether to raise a fresh 'health-check-alert' action-queue item or skip
 * because one is already open. When the condition clears, it resolves the
 * open item so the operator sees it disappear without any manual gesture.
 *
 * Dedup is application-level, keyed by checkId in the AlertStore. The
 * AlertStore records the AQ item id for each open alert so the clear path can
 * address the item directly by id rather than re-computing the signature.
 */

import type { AlertStore } from '../pass.js'

// ── Deps ──────────────────────────────────────────────────────────────────────

/**
 * Injectable dependencies for the alert route. Both functions are bounded by
 * the caller (Steward, test) so the route handler itself is stateless and
 * testable without a live database.
 */
export interface AlertRouteDeps {
  /**
   * Persistence layer for open alerts, keyed by checkId.
   * Tracks at most one open AQ item per check.
   */
  alertStore: AlertStore

  /**
   * Raise a 'health-check-alert' action-queue item and return its id.
   * Called only when no open alert exists for this checkId.
   */
  raiseAlertItem(params: {
    checkId: string
    findingKey: string
    detail: string | undefined
    label: string
  }): Promise<string>

  /**
   * Resolve an open 'health-check-alert' action-queue item by id.
   * Called when the condition clears and the open alert should disappear.
   */
  resolveAlertItem(aqItemId: string): Promise<void>
}

// ── Result ────────────────────────────────────────────────────────────────────

type AlertRouteAction = 'raised' | 'already-open' | 'no-finding-key'

export interface AlertRouteResult {
  /** What the route decided to do. */
  readonly action: AlertRouteAction
  /** AQ item id set when action is 'raised' or 'already-open'. */
  readonly aqItemId?: string
  /** The findingKey that was acted on (absent when action is 'no-finding-key'). */
  readonly findingKey?: string
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * Route one alert-route finding.
 *
 * - When the check outcome has no findingKey, action='no-finding-key'.
 * - When a 'health-check-alert' item is already open for this checkId,
 *   action='already-open' (dedup: the row persists without a new raise).
 * - Otherwise, raises the item and records it in alertStore:
 *   action='raised' with the new AQ item id.
 */
export async function routeAlert(
  params: {
    findingKey: string | undefined
    detail: string | undefined
    checkId: string
    label: string
  },
  deps: AlertRouteDeps,
): Promise<AlertRouteResult> {
  const { findingKey, detail, checkId, label } = params

  if (!findingKey) {
    return { action: 'no-finding-key' }
  }

  const existingId = await deps.alertStore.getOpenAlertId(checkId)
  if (existingId !== null) {
    return { action: 'already-open', aqItemId: existingId, findingKey }
  }

  const aqItemId = await deps.raiseAlertItem({ checkId, findingKey, detail, label })
  await deps.alertStore.setOpenAlertId(checkId, aqItemId)
  return { action: 'raised', aqItemId, findingKey }
}

/**
 * Auto-clear an open alert when the condition is no longer present.
 *
 * No-op (returns null) when no alert is open for this checkId. When one is
 * open, resolves the AQ item, clears the AlertStore record, and returns the
 * resolved AQ item id so the caller can track what was cleared.
 */
export async function clearHealthAlert(
  checkId: string,
  deps: AlertRouteDeps,
): Promise<string | null> {
  const existingId = await deps.alertStore.getOpenAlertId(checkId)
  if (existingId === null) return null

  await deps.resolveAlertItem(existingId)
  await deps.alertStore.clearAlert(checkId)
  return existingId
}
