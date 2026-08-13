import { useState } from 'react'
import type { Cluster, ProgressProposalNode, ProgressTask, PurgeArchiveEntry } from '@/shared/schemas'
import type { Role, UITask } from '@/shared/types'
import { taskTitle } from '@/shared/promptTitle'
import { arcPlacementCluster, resolveArcLabel, taskArcKey } from '@/widgets/topologyFlowModel'
import { ArcColumn, type BoardArc } from '@/widgets/Column'
import { humanizeFailureCode } from '@/shared/actionQueueDetail'
import { invokeAction } from '@/shared/api'

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

/** The four lifecycle columns on the reworked board. */
type LifecycleCol = 'Running' | 'Recovering' | 'Needs you' | 'Done'

/**
 * A group of failed arcs sharing the same root-cause failure signature.
 * Arcs with the same signature collapse into one card on the "Needs you" column.
 * Arcs with no signature each get their own group.
 */
interface FailureGroup {
  /** Unique group key: 'sig:<signature>' for shared-sig groups, 'arc:<id>' otherwise. */
  id: string
  signature: string | null
  /** Human-readable title — humanized signature or the arc's own title. */
  title: string
  /** Number of arcs in this group — shown as the badge count when > 1. */
  count: number
  /** Member arcs whose tasks drive the Continue/Restart actions. */
  arcs: BoardArc[]
}

// Display order for lifecycle column tabs and wrappers
const LIFECYCLE_COLS: readonly LifecycleCol[] = ['Running', 'Recovering', 'Needs you', 'Done']

// Default active tab: most-attention-needed column first
const DEFAULT_LIFECYCLE_PRIORITY: readonly LifecycleCol[] = ['Needs you', 'Recovering', 'Running', 'Done']

// Internal cluster order used by buildArcsByCluster (unchanged from v1)
const CLUSTERS: readonly Cluster[] = ['Blocked', 'Queued', 'In progress', 'Failed']

// Queued arcs collapse to a count header in the Running column when above this threshold
const QUEUED_COLLAPSE_THRESHOLD = 3

const compareNewestFirst = (a: ProgressTask, b: ProgressTask): number =>
  b.updatedAt.localeCompare(a.updatedAt)

const roleFromStatus = (status: ProgressTask['status']): Role => {
  switch (status) {
    case 'running':
      return 'builder'
    case 'verifying':
      return 'reviewer'
    case 'merging':
    case 'vega-reconciling':
      return 'orchestrator'
    case 'draft':
    case 'queued':
      return 'planner'
    case 'blocked':
    case 'done':
    case 'failed':
    case 'dropped':
      return 'orchestrator'
    default:
      return 'orchestrator'
  }
}

const toUI = (t: ProgressTask): UITask => ({
  id: t.id,
  title: taskTitle(t),
  status: t.status,
  role: roleFromStatus(t.status),
  failed: t.status === 'failed',
  dropReason: t.dropReason ?? null,
  recoverySpawnedCount: t.recoverySpawnedCount ?? 0,
  priority: t.priority,
  blockerTaskId: t.blockerTaskId ?? null,
  spec: t.spec ?? null,
  failureSignature: t.failureSignature ?? null,
  compensatesArcId: t.compensatesArcId ?? null,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
})

// ---------------------------------------------------------------------------
// buildArcsByCluster — unchanged from v1; exported for tests and TopologyView
// ---------------------------------------------------------------------------

/**
 * Collapse the open task projection into its durable Arc roots. An Arc that
 * has a recovery in flight is deliberately placed by that live recovery rather
 * than its historical failure. A blocked dependent surfaces in the Blocked
 * column even when the origin is Failed, so dependency chains filed with
 * `--blocked-by` remain visible rather than being swallowed by the Failed column.
 *
 * origin_id is a dual-namespace column: it holds either a task id or a proposal
 * id (arcs produced by `mars proposal slice` carry origin_id = proposal_id).
 * Namespace resolution order: task id first, then proposal id, then orphaned.
 */
export const buildArcsByCluster = (
  tasks: ProgressTask[],
  proposals: ProgressProposalNode[],
): Record<Cluster, BoardArc[]> => {
  const proposalById = new Map(proposals.map((p) => [p.id, p]))
  const grouped = new Map<string, ProgressTask[]>()

  for (const task of tasks) {
    const arcId = taskArcKey(task)
    const arcTasks = grouped.get(arcId)
    if (arcTasks) arcTasks.push(task)
    else grouped.set(arcId, [task])
  }

  const arcsByCluster: Record<Cluster, BoardArc[]> = {
    Queued: [],
    'In progress': [],
    Blocked: [],
    Failed: [],
    Done: [], // arcs never resolve to Done; present for type completeness
  }

  for (const [id, arcTasks] of grouped) {
    // Use the shared arcPlacementCluster helper so Board and Topology always
    // agree on the status word. Returns null when every task is Done.
    const cluster = arcPlacementCluster(arcTasks)
    if (cluster === null) continue // all-Done arc: not shown on the board
    const orderedTasks = [...arcTasks].sort((a, b) => {
      if (a.id === id) return -1
      if (b.id === id) return 1
      return a.createdAt.localeCompare(b.createdAt)
    })
    const originTask = orderedTasks.find((task) => task.id === id)
    const latestTask = [...arcTasks].sort(compareNewestFirst)[0]!

    const displayTask = originTask ?? latestTask
    // Arc label: proposal-first, then origin-task title (intent, else prompt),
    // then "Abandoned arc". arc keys may hold a parentProposalId or an originId
    // pointing to a proposal (tasks produced by `mars proposal slice`);
    // resolveArcLabel handles both. undefined means neither namespace owns the
    // id — the origin was force-purged.
    const resolvedLabel = resolveArcLabel(id, orderedTasks, proposalById)
    const hasOrphanedOrigin = resolvedLabel === undefined
    const title = resolvedLabel ?? `Abandoned arc ${id}`
    const latestFailedTask = [...arcTasks]
      .filter((t) => t.status === 'failed' && t.failureSignature != null)
      .sort(compareNewestFirst)[0]
    arcsByCluster[cluster].push({
      id,
      cluster,
      tasks: orderedTasks.map(toUI),
      activeCount: orderedTasks.filter((t) => t.cluster !== 'Done').length,
      title,
      updatedAt: latestTask.updatedAt,
      compensatesArcId: displayTask.compensatesArcId ?? null,
      hasOrphanedOrigin,
      failureSignature: latestFailedTask?.failureSignature ?? null,
    })
  }

  for (const cluster of CLUSTERS) {
    arcsByCluster[cluster].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  return arcsByCluster
}

// ---------------------------------------------------------------------------
// Lifecycle reclassification helpers
// ---------------------------------------------------------------------------

/**
 * True when an In-progress arc has a failed task member — meaning the system
 * spawned a fix task that is actively running. The arc belongs in "Recovering".
 * Arcs without a failed member are plain "Running".
 */
const isRecoveryArc = (arc: BoardArc): boolean =>
  arc.tasks.some((t) => t.failed)

/**
 * Group failed arcs by failure signature.
 * Arcs sharing the same non-null signature → one FailureGroup card.
 * Arcs with no signature → each gets its own group (titled by the arc title).
 */
const groupBySignature = (arcs: BoardArc[]): FailureGroup[] => {
  const bySig = new Map<string, BoardArc[]>()
  const noSig: BoardArc[] = []

  for (const arc of arcs) {
    const sig = arc.failureSignature ?? null
    if (sig !== null) {
      const existing = bySig.get(sig)
      if (existing) existing.push(arc)
      else bySig.set(sig, [arc])
    } else {
      noSig.push(arc)
    }
  }

  const groups: FailureGroup[] = []

  for (const [sig, sigArcs] of bySig) {
    groups.push({
      id: `sig:${sig}`,
      signature: sig,
      title: humanizeFailureCode(sig),
      count: sigArcs.length,
      arcs: sigArcs,
    })
  }

  for (const arc of noSig) {
    groups.push({
      id: `arc:${arc.id}`,
      signature: null,
      title: arc.title,
      count: 1,
      arcs: [arc],
    })
  }

  return groups
}

// ---------------------------------------------------------------------------
// FailureGroupCard — "Needs you" column card
// ---------------------------------------------------------------------------

const FailureGroupCard = ({ group }: { group: FailureGroup }) => {
  const [menuOpen, setMenuOpen] = useState(false)

  // Collect the IDs of failed tasks across all member arcs for Continue/Restart
  const failedTaskIds = group.arcs.flatMap((arc) =>
    arc.tasks.filter((t) => t.failed).map((t) => t.id),
  )

  const handleContinue = () => {
    const ids = failedTaskIds.length > 0 ? failedTaskIds : group.arcs.flatMap((arc) => arc.tasks.map((t) => t.id))
    for (const taskId of ids) {
      invokeAction('continue', taskId).catch(() => {
        // Continue not available for this task — surface the failure via action queue
      })
    }
  }

  const handleRestart = () => {
    setMenuOpen(false)
    const ids = failedTaskIds.length > 0 ? failedTaskIds : group.arcs.flatMap((arc) => arc.tasks.map((t) => t.id))
    for (const taskId of ids) {
      invokeAction('restart', taskId).catch(() => {
        // ignore individual restart failures
      })
    }
  }

  const arcIds = group.arcs.map((arc) => arc.id)

  return (
    <div
      data-failure-group={group.id}
      data-group-count={group.count}
      className="mars-card rounded-lg bg-card p-3 flex flex-col gap-2"
    >
      {/* Title row: failure label + count badge */}
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 line-clamp-2 text-body font-medium leading-snug text-foreground">
          {group.title}
        </span>
        {group.count > 1 ? (
          <span
            data-testid="group-count-badge"
            className="shrink-0 rounded bg-status-failed/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-status-failed"
          >
            {group.count}
          </span>
        ) : null}
      </div>
      {/* Member arc IDs */}
      <div className="font-mono text-meta text-muted-foreground truncate">
        {arcIds.join(' · ')}
      </div>
      {/* Action row: primary Continue + secondary overflow */}
      <div className="flex items-center gap-2">
        <button
          data-testid="group-continue"
          type="button"
          onClick={handleContinue}
          className="flex-1 rounded bg-primary px-3 py-1 font-mono text-[11px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Continue
        </button>
        <div className="relative">
          <button
            data-testid="group-overflow-menu"
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className="rounded border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
            aria-label="More actions"
          >
            ⋯
          </button>
          {menuOpen ? (
            <div className="absolute right-0 top-full z-20 mt-1 flex flex-col gap-0.5 rounded border border-border bg-popover p-1 shadow-md">
              <button
                data-testid="group-restart"
                type="button"
                onClick={handleRestart}
                className="rounded px-3 py-1 text-left font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                Restart
              </button>
              <button
                data-testid="group-open"
                type="button"
                onClick={() => setMenuOpen(false)}
                className="rounded px-3 py-1 text-left font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                Open
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// BoardView component props (stable contract — callers unchanged)
// ---------------------------------------------------------------------------

export interface BoardViewProps {
  byCluster: Record<Cluster, ProgressTask[]>
  proposals: ProgressProposalNode[]
  error: Error | null
  selectedProposalId: string | null
  /**
   * When set, only tasks whose ID is in this set are rendered in each column.
   * null = no active text search (show all tasks).
   */
  searchMatchIds?: Set<string> | null
  /**
   * The raw search query string — displayed in the zero-state message when
   * searchMatchIds is non-null and no tasks match. Optional for back-compat.
   */
  searchQuery?: string
  purgeArchive?: Map<string, PurgeArchiveEntry>
  /** Called when the user clicks the "Clear filter" button in the proposal-filter empty state. */
  onClearProposalFilter?: () => void
}

// ---------------------------------------------------------------------------
// BoardView — four lifecycle columns: Running / Recovering / Needs you / Done
// ---------------------------------------------------------------------------

export const BoardView = ({
  byCluster,
  proposals,
  error,
  selectedProposalId,
  searchMatchIds,
  searchQuery,
  purgeArchive,
  onClearProposalFilter,
}: BoardViewProps) => {
  // Filter active (non-Done) tasks by proposal + search before arc grouping so
  // an arc spanning a failure and its recovery is represented exactly once.
  const activeTasks = CLUSTERS.flatMap((cluster) => byCluster[cluster]).filter((task) => {
    if (selectedProposalId !== null && task.parentProposalId !== selectedProposalId) return false
    return searchMatchIds == null || searchMatchIds.has(task.id)
  })

  // Done tasks are arc metadata — they bypass proposal/search filtering because
  // they are not visible items on the board; they exist so done origins can
  // supply arc titles and prevent false "Abandoned arc" displays.
  const doneTasks = byCluster['Done'] ?? []

  const arcsByCluster = buildArcsByCluster([...activeTasks, ...doneTasks], proposals)

  // ── Lifecycle reclassification ─────────────────────────────────────────────
  //
  // Running   = Blocked + Queued + non-recovery In-progress arcs
  // Recovering = In-progress arcs that have a failed task member (fix in flight)
  // Needs you  = Failed arcs, grouped by failure signature
  // Done       = today's done tasks (collapsed list)

  const queuedArcs = arcsByCluster.Queued
  const collapseQueued = queuedArcs.length > QUEUED_COLLAPSE_THRESHOLD

  // Active arcs that show as individual cards in Running column
  const activeRunningArcs: BoardArc[] = [
    ...arcsByCluster.Blocked,
    ...arcsByCluster['In progress'].filter((arc) => !isRecoveryArc(arc)),
  ]

  // When queued count is small enough, expand them as individual cards too
  const runningArcsToRender: BoardArc[] = collapseQueued
    ? activeRunningArcs
    : [...queuedArcs, ...activeRunningArcs]

  // Total running arcs (for tab count)
  const totalRunningArcs = queuedArcs.length + activeRunningArcs.length

  const recoveringArcs = arcsByCluster['In progress'].filter(isRecoveryArc)
  const needsYouArcs = arcsByCluster.Failed
  const failureGroups = groupBySignature(needsYouArcs)

  // ── Total matched tasks (for zero-state detection) ─────────────────────────
  // Done tasks excluded — they are not visible board items.
  const totalMatchedTasks = activeTasks.length

  // ── Tab counts ─────────────────────────────────────────────────────────────
  const tabCounts: Record<LifecycleCol, number> = {
    Running: totalRunningArcs,
    Recovering: recoveringArcs.length,
    'Needs you': failureGroups.length,
    Done: doneTasks.length,
  }

  // Default: leftmost non-empty from priority list; fallback to 'Running'
  const defaultTab = DEFAULT_LIFECYCLE_PRIORITY.find((t) => tabCounts[t] > 0) ?? 'Running'

  // Active tab — controls which single column is visible on mobile
  const [activeTab, setActiveTab] = useState<LifecycleCol>(defaultTab)

  return (
    <>
      {/* ------------------------------------------------------------------ */}
      {/* Mobile-only horizontal status tab strip (hidden at md / 768px+)     */}
      {/* ------------------------------------------------------------------ */}
      <div
        role="tablist"
        aria-label="Board status"
        data-testid="board-tab-strip"
        className="flex min-h-[44px] shrink-0 items-center overflow-x-auto border-b border-border bg-background px-2 md:hidden"
      >
        {LIFECYCLE_COLS.map((tab) => {
          const count = tabCounts[tab]
          return (
            <button
              key={tab}
              role="tab"
              data-tab={tab}
              aria-selected={activeTab === tab}
              onClick={() => setActiveTab(tab)}
              className={`flex min-h-[44px] shrink-0 items-center gap-1.5 border-b-2 px-3 font-sans text-[11px] font-semibold tracking-[0.08em] transition-colors ${
                activeTab === tab
                  ? 'border-highlight text-highlight'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab}
              {count > 0 ? (
                <span className="font-mono text-[10px] tabular-nums opacity-70">{count}</span>
              ) : null}
            </button>
          )
        })}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Board layout (four lifecycle columns)                               */}
      {/*   mobile  (<768px):   flex-col, one column at a time (tab-driven)   */}
      {/*   tablet  (768–1024px): CSS grid, 2–3 fluid columns, vertical scroll */}
      {/*   desktop (>1024px):  flex-row, four equal columns                  */}
      {/* ------------------------------------------------------------------ */}
      <main className="relative flex flex-col min-h-0 flex-1 gap-3 overflow-hidden bg-background p-4 md:grid md:grid-cols-[repeat(auto-fit,minmax(280px,1fr))] md:auto-rows-[400px] md:overflow-y-auto lg:flex lg:flex-row lg:overflow-hidden">
        {/* Zero-state proposal pill */}
        {selectedProposalId !== null && searchMatchIds == null && totalMatchedTasks === 0 && (
          <div
            data-testid="proposal-zero-state"
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
          >
            <div className="pointer-events-auto flex flex-col items-center gap-3">
              <span className="rounded border border-border bg-card px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                No active tasks for this proposal
              </span>
              <button
                data-testid="clear-proposal-filter"
                onClick={onClearProposalFilter}
                className="rounded border border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
              >
                Clear filter
              </button>
            </div>
          </div>
        )}
        {/* Zero-state search pill */}
        {searchMatchIds != null && totalMatchedTasks === 0 && (
          <div
            data-testid="search-zero-state"
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
          >
            <span className="rounded border border-border bg-card px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
              {`0 tasks match '${(searchQuery ?? '').trim()}'`}
            </span>
          </div>
        )}

        {/* ── Running column ─────────────────────────────────────────────── */}
        <div
          data-cluster="Running"
          className={`${activeTab === 'Running' ? 'flex' : 'hidden'} flex-col flex-1 min-h-0 md:flex lg:flex-1 lg:basis-0`}
        >
          <ArcColumn
            label="Running"
            accent="highlight"
            arcs={runningArcsToRender}
            expandAll={searchMatchIds != null}
            purgeArchive={purgeArchive}
            collapsedQueuedCount={collapseQueued ? queuedArcs.length : undefined}
          />
        </div>

        {/* ── Recovering column ──────────────────────────────────────────── */}
        <div
          data-cluster="Recovering"
          className={`${activeTab === 'Recovering' ? 'flex' : 'hidden'} flex-col flex-1 min-h-0 md:flex lg:flex-1 lg:basis-0`}
        >
          <ArcColumn
            label="Recovering"
            accent="amber"
            arcs={recoveringArcs}
            expandAll={searchMatchIds != null}
            purgeArchive={purgeArchive}
          />
        </div>

        {/* ── Needs you column ───────────────────────────────────────────── */}
        <div
          data-cluster="Needs you"
          className={`${activeTab === 'Needs you' ? 'flex' : 'hidden'} flex-col flex-1 min-h-0 md:flex lg:flex-1 lg:basis-0`}
        >
          <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-2 bg-secondary p-3">
            <header className="flex items-center justify-between border-b border-border/50 px-1 pb-2">
              <span className="font-sans text-[11px] font-semibold tracking-[0.1em] text-muted-foreground">
                Needs you
              </span>
              <span className="font-mono text-[11px] font-semibold text-muted-foreground">
                {failureGroups.length}
              </span>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              {failureGroups.length === 0 ? (
                <div className="px-1 py-2 font-mono text-[11px] text-muted-foreground/70">
                  empty
                </div>
              ) : (
                failureGroups.map((group) => (
                  <FailureGroupCard key={group.id} group={group} />
                ))
              )}
            </div>
          </section>
        </div>

        {/* ── Done column ────────────────────────────────────────────────── */}
        <div
          data-cluster="Done"
          className={`${activeTab === 'Done' ? 'flex' : 'hidden'} flex-col flex-1 min-h-0 md:flex lg:flex-1 lg:basis-0`}
        >
          <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-2 bg-secondary p-3">
            <header className="flex items-center justify-between border-b border-border/50 px-1 pb-2">
              <span className="font-sans text-[11px] font-semibold tracking-[0.1em] text-muted-foreground">
                Done
              </span>
              <span className="font-mono text-[11px] font-semibold text-muted-foreground">
                {doneTasks.length}
              </span>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              {doneTasks.length === 0 ? (
                <div className="px-1 py-2 font-mono text-[11px] text-muted-foreground/70">
                  empty
                </div>
              ) : (
                <details className="mars-card group rounded-lg bg-card hover:bg-secondary">
                  <summary
                    className="flex cursor-pointer list-none items-center gap-2 p-3 [&::-webkit-details-marker]:hidden"
                  >
                    <span
                      aria-hidden="true"
                      className="text-muted-foreground transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none"
                    >
                      ▾
                    </span>
                    <span className="text-body font-medium text-foreground">
                      {doneTasks.length} done today
                    </span>
                  </summary>
                  <div className="border-t border-border/60 p-2">
                    <div className="flex flex-col gap-1">
                      {doneTasks.map((t) => (
                        <div key={t.id} className="py-1">
                          <span className="font-mono text-meta text-muted-foreground">
                            {t.id}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </details>
              )}
            </div>
          </section>
        </div>
      </main>

      {error ? (
        <div className="border-t border-primary/40 bg-primary/10 px-6 py-1.5 font-mono text-[11px] text-primary">
          {error.message}
        </div>
      ) : null}
    </>
  )
}
