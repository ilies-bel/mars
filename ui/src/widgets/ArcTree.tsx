/**
 * ArcTree — DOM-based indented tree rail for the action-queue card's
 * blocker/blocking/recovery arc.
 *
 * Replaces the G6 canvas widget with a pure DOM/CSS indented list so that:
 *   - Task IDs and summaries are selectable text (⌘-F, copy/paste).
 *   - No aria-hidden canvas workaround — real semantic markup.
 *   - No animation, drag, or zoom overhead for a read-only 4–8 node arc.
 *
 * Rendering order: upstream blockers → central entity → downstream blocking
 * → recovery descendants (shown at depth 1).
 *
 * Pure model function `buildArcTree` is exported for unit testing without a DOM.
 */

import type { DagContext, Cluster } from '@/shared/schemas'
import { dagClusterStyle } from '@/shared/dagColors'

// ---------------------------------------------------------------------------
// Status → Cluster mapping (dag nodes carry a raw status string)
// ---------------------------------------------------------------------------

const STATUS_TO_CLUSTER: Record<string, Cluster> = {
  running: 'In progress',
  blocked: 'Blocked',
  failed: 'Failed',
}

const clusterOf = (status: string): Cluster =>
  STATUS_TO_CLUSTER[status] ?? 'Queued'

// ---------------------------------------------------------------------------
// Pure model transform — testable without a DOM
// ---------------------------------------------------------------------------

type ArcTreeRowKind = 'PROPOSAL' | 'FIX' | 'TASK'

export interface ArcTreeRow {
  id: string
  summary: string
  status: string
  depth: number
  kind: ArcTreeRowKind
  isCenter: boolean
}

/**
 * Build the ordered, depth-annotated rows for the ArcTree rail.
 *
 * Rules:
 *  - One row per id in `{entityId} ∪ blockers ∪ blocking ∪ descendants`.
 *  - Dedup priority: central entity first, then blockers, blocking, descendants
 *    (central-node-first dedup priority).
 *  - Recovery descendants (reached via `recovers` edges) are placed at depth 1.
 *  - Kind: PROPOSAL when id === dag.proposalId; FIX when reached via a
 *    `recovers` edge; TASK otherwise.
 */
export const buildArcTree = (
  dag: DagContext,
  entityId: string,
  entityStatus: string,
): ArcTreeRow[] => {
  // IDs reached via `recovers` edges → kind 'FIX'
  const recoveryTargets = new Set(
    dag.edges.filter((e) => e.kind === 'recovers').map((e) => e.to),
  )

  const kindOf = (id: string): ArcTreeRowKind => {
    if (id === dag.proposalId) return 'PROPOSAL'
    if (recoveryTargets.has(id)) return 'FIX'
    return 'TASK'
  }

  // Reserve entityId first so peripheral entries with the same id are skipped,
  // preserving the centre-wins dedup priority.
  const seenIds = new Set<string>([entityId])
  const rows: ArcTreeRow[] = []

  const push = (
    id: string,
    summary: string,
    status: string,
    depth: number,
    isCenter: boolean,
  ) => {
    if (seenIds.has(id)) return
    seenIds.add(id)
    rows.push({ id, summary, status, depth, kind: kindOf(id), isCenter })
  }

  // 1. Upstream blockers (depth 0)
  for (const n of dag.blockers) {
    push(n.id, n.summary, n.status, 0, false)
  }

  // 2. Central entity (depth 0) — always present regardless of dedup
  rows.push({
    id: entityId,
    summary: '',
    status: entityStatus,
    depth: 0,
    kind: kindOf(entityId),
    isCenter: true,
  })

  // 3. Downstream blocking (depth 0)
  for (const n of dag.blocking) {
    push(n.id, n.summary, n.status, 0, false)
  }

  // 4. Recovery descendants (depth 1)
  for (const n of dag.descendants) {
    push(n.id, n.summary, n.status, 1, false)
  }

  return rows
}

// ---------------------------------------------------------------------------
// Component props — identical interface to the former G6 canvas widget
// ---------------------------------------------------------------------------

export interface ArcTreeProps {
  dag: DagContext
  entityId: string
  /** Task status string (e.g. 'failed', 'running') used to colour the central row. */
  entityStatus: string
}

// ---------------------------------------------------------------------------
// Public component — guards the empty case; returns null when no arc nodes
// ---------------------------------------------------------------------------

/**
 * Renders the arc as a DOM-based indented tree rail when there are peripheral
 * nodes (blockers, blocking tasks, or recovery descendants).
 * Returns null when the dag contains only the central entity so no empty box
 * is ever shown (same empty-guard: returns null for no peripheral nodes).
 *
 * Each row is a focusable button that navigates to the task drawer via
 * `window.location.hash`. Text is fully selectable and ⌘-F-able.
 */
export const ArcTree = ({ dag, entityId, entityStatus }: ArcTreeProps) => {
  const hasNodes =
    dag.blockers.length > 0 ||
    dag.blocking.length > 0 ||
    dag.descendants.length > 0

  if (!hasNodes) return null

  const rows = buildArcTree(dag, entityId, entityStatus)

  return (
    <ul className="flex flex-col gap-0.5">
      {rows.map((row) => {
        const { stroke: statusColor } = dagClusterStyle('task', clusterOf(row.status))
        const truncatedSummary =
          row.summary.length > 69 ? `${row.summary.slice(0, 69)}…` : row.summary

        return (
          <li
            key={row.id}
            style={{ marginLeft: `${row.depth * 12}px` }}
          >
            <button
              type="button"
              onClick={() => {
                window.location.hash = `#/task/${encodeURIComponent(row.id)}`
              }}
              className={[
                'flex w-full items-baseline gap-2 rounded px-1 text-left hover:bg-iron/10',
                row.isCenter ? 'font-bold' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {/* Status glyph — decorative only, aria-hidden */}
              <span
                aria-hidden="true"
                className="mt-0.5 inline-block h-1.5 w-1.5 flex-shrink-0 self-center rounded-full"
                style={{ backgroundColor: statusColor }}
              />
              {/* Kind label */}
              <span className="font-mono text-[9px] uppercase text-iron">
                {row.kind}
              </span>
              {/* Task ID — selectable, copyable, break-all per OriginTree */}
              <span className="break-all font-mono text-[10px] text-muted">
                {row.id}
              </span>
              {/* Summary — body text colour for ≥4.5:1 contrast, truncated */}
              {truncatedSummary && (
                <span className="break-words text-[11px] text-fg">
                  {truncatedSummary}
                </span>
              )}
              {/* Status — right-aligned, muted secondary metadata */}
              <span className="ml-auto font-mono text-[10px] uppercase text-muted">
                {row.status}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
