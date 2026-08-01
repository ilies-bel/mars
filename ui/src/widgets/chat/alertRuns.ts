/**
 * Grouping rule for alert notifications in the main thread.
 *
 * The operator's requirement: "whenever there is two in a row, they should
 * merge into a rich event timeline to let the user have only one artifact when
 * away." The point is the artifact count, not the layout — someone coming back
 * to the session should find ONE thing to read, not a wall of cards to scroll.
 *
 * "In a row" is deliberately read as "open at the same time" rather than
 * "adjacent in history". An Alert is a pure live projection (ADR-0048/0054):
 * it is derived on every poll, never persisted, and carries no timestamp, so
 * there is no honest way to interleave alerts chronologically with conversation
 * entries. What alerts do have is simultaneity — and simultaneity is exactly
 * the condition the requirement describes, because alerts pile up precisely
 * while nobody is watching.
 *
 * These helpers stay free of React so the rule is unit-testable on its own.
 */

import type { Alert } from '@/entities/alerts'

/** A single alert, rendered as one card. */
export interface SingleAlertNode {
  kind: 'single'
  alert: Alert
}

/** Two or more simultaneous alerts, rendered as one merged event timeline. */
export interface AlertRunNode {
  kind: 'run'
  alerts: Alert[]
}

export type AlertNode = SingleAlertNode | AlertRunNode

/**
 * Collapse the open alert list into what the main thread should render.
 *
 * Returns an empty array when there is nothing pending, a single node for one
 * alert, and exactly one run node once two or more are open. The run is never
 * split by kind: an operator returning to a failed arc AND a stale worktree
 * wants one "here is what happened" surface, and splitting by kind would put
 * them back at two artifacts — the precise thing this exists to prevent.
 */
export function groupAlerts(alerts: readonly Alert[]): AlertNode[] {
  if (alerts.length === 0) return []
  if (alerts.length === 1) return [{ kind: 'single', alert: alerts[0]! }]
  return [{ kind: 'run', alerts: [...alerts] }]
}

/**
 * Headline for a merged run, e.g. "3 things happened while you were away".
 *
 * Kept beside the grouping rule rather than in the component because it states
 * the same fact the grouping encodes, and the two must not drift.
 */
export function runHeadline(alerts: readonly Alert[]): string {
  return `${alerts.length} things need you`
}

/**
 * Count alerts by kind for the run's summary line. Alerts whose `kind` the
 * daemon omitted are counted under 'other' rather than dropped — an alert with
 * a drifted shape still needs the operator, and silently losing it from the
 * count would make the headline lie.
 */
export function countByKind(alerts: readonly Alert[]): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>()
  for (const alert of alerts) {
    const kind = alert.kind ?? 'other'
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => (b.count - a.count) || a.kind.localeCompare(b.kind))
}
