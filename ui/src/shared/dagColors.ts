/**
 * Shared DAG cluster-colour tokens.
 *
 * All hex values live in @theme (index.css) as CSS custom properties.
 * This module returns `var(--color-dag-*)` references so SVG elements
 * can consume them via the `style` prop (presentation attributes do not
 * evaluate CSS custom properties in all browsers, but `style` does).
 *
 * Both TopologyView and TaskDetailDrawer import from here so the two
 * canvases cannot drift apart.
 */

export interface DagNodeStyle {
  fill: string
  stroke: string
  text: string
}

/**
 * Returns the fill/stroke/text CSS variable references for a DAG node.
 *
 * @param kind    Node kind — `"proposal"` or `"idea"` both map to the proposal
 *                palette (TaskDetailDrawer renames proposals to `"idea"` for
 *                subgraph logic).  Any other value falls through to cluster.
 * @param cluster Server-assigned cluster label, or `undefined` for unknown /
 *                unclassified tasks (treated as "Queued").
 */
export const dagClusterStyle = (
  kind: string,
  cluster: string | undefined,
): DagNodeStyle => {
  if (kind === 'proposal' || kind === 'idea') {
    return {
      fill: 'var(--color-dag-proposal-fill)',
      stroke: 'var(--color-dag-proposal-stroke)',
      text: 'var(--color-dag-proposal-text)',
    }
  }
  switch (cluster) {
    case 'In progress':
      return {
        fill: 'var(--color-dag-in-progress-fill)',
        stroke: 'var(--color-dag-in-progress-stroke)',
        text: 'var(--color-dag-in-progress-text)',
      }
    case 'Blocked':
      return {
        fill: 'var(--color-dag-blocked-fill)',
        stroke: 'var(--color-dag-blocked-stroke)',
        text: 'var(--color-dag-blocked-text)',
      }
    case 'Failed':
      return {
        fill: 'var(--color-dag-failed-fill)',
        stroke: 'var(--color-dag-failed-stroke)',
        text: 'var(--color-dag-failed-text)',
      }
    default: // 'Queued' or unknown
      return {
        fill: 'var(--color-dag-queued-fill)',
        stroke: 'var(--color-dag-queued-stroke)',
        text: 'var(--color-dag-queued-text)',
      }
  }
}

/** CSS variable reference for provenance (dashed purple) edges. */
export const DAG_EDGE_PROVENANCE = 'var(--color-dag-edge-provenance)'

/** CSS variable reference for blocker (solid grey) edges and arrow markers. */
export const DAG_EDGE_BLOCKER = 'var(--color-dag-edge-blocker)'
