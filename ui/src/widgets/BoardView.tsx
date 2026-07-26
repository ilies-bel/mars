import { useState } from 'react'
import type { Cluster, ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import type { Role, UITask } from '@/shared/types'
import { titleFromPrompt } from '@/shared/promptTitle'
import { ArcColumn, type BoardArc } from '@/widgets/Column'

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

// Display order in the tab strip (mirrors column order — attention-first)
const ALL_TABS: readonly Cluster[] = ['Failed', 'Blocked', 'In progress', 'Queued']

// Priority for the default tab: leftmost non-empty of Failed, Blocked, In progress, Queued.
// Same story as ALL_TABS and CLUSTERS — the "what needs me right now" column wins.
const DEFAULT_TAB_PRIORITY: readonly Cluster[] = ['Failed', 'Blocked', 'In progress', 'Queued']

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
  title: titleFromPrompt(t.prompt),
  status: t.status,
  role: roleFromStatus(t.status),
  failed: t.status === 'failed',
  dropReason: t.dropReason ?? null,
  retryCount: t.retryCount ?? 0,
  blockerTaskId: t.blockerTaskId ?? null,
  spec: t.spec ?? null,
  compensatesArcId: t.compensatesArcId ?? null,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
})

// Column order — attention-first (Failed / Blocked leftmost) so the "what needs me
// right now" columns land in the first scan positions. Matches DEFAULT_TAB_PRIORITY
// and ALL_TABS so desktop and mobile tell the same story.
const CLUSTERS: readonly Cluster[] = ['Failed', 'Blocked', 'In progress', 'Queued']

const ARC_CLUSTER_PRIORITY: readonly Cluster[] = ['Blocked', 'In progress', 'Queued']

const compareNewestFirst = (a: ProgressTask, b: ProgressTask): number =>
  b.updatedAt.localeCompare(a.updatedAt)

/**
 * Collapse the open task projection into its durable Arc roots. An Arc that
 * has a recovery in flight is deliberately placed by that live recovery rather
 * than its historical failure: the board should show the state of the work now.
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
    const arcId = task.originId ?? task.id
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
    // A queued/running/blocked descendant supersedes a prior failed attempt in
    // the same Arc. Among live states, attention still wins over activity.
    // An arc whose tasks are all Done is skipped — the board shows active work.
    const cluster =
      ARC_CLUSTER_PRIORITY.find((candidate) =>
        arcTasks.some((task) => task.cluster === candidate),
      ) ?? (arcTasks.some((task) => task.cluster === 'Failed') ? 'Failed' : null)
    if (cluster === null) continue // all-Done arc: not shown on the board
    const orderedTasks = [...arcTasks].sort((a, b) => {
      if (a.id === id) return -1
      if (b.id === id) return 1
      return a.createdAt.localeCompare(b.createdAt)
    })
    const originTask = orderedTasks.find((task) => task.id === id)
    const latestTask = [...arcTasks].sort(compareNewestFirst)[0]!

    const displayTask = originTask ?? latestTask
    // Namespace resolution: task id first, then proposal id, then orphaned.
    // origin_id intentionally has no FK and may hold proposal ids — tasks
    // produced by `mars proposal slice` carry origin_id = proposal_id.
    // Only declare the origin orphaned when neither namespace owns the id.
    const originProposal = originTask === undefined ? proposalById.get(id) : undefined
    const hasOrphanedOrigin = originTask === undefined && originProposal === undefined
    const title = originTask !== undefined
      ? titleFromPrompt(originTask.prompt)
      : originProposal !== undefined
        ? originProposal.title
        : `Abandoned arc ${id}`
    arcsByCluster[cluster].push({
      id,
      cluster,
      tasks: orderedTasks.map(toUI),
      title,
      updatedAt: latestTask.updatedAt,
      compensatesArcId: displayTask.compensatesArcId ?? null,
      hasOrphanedOrigin,
    })
  }

  for (const cluster of CLUSTERS) {
    arcsByCluster[cluster].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  return arcsByCluster
}

// ---------------------------------------------------------------------------
// BoardView component
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
}

export const BoardView = ({
  byCluster,
  proposals,
  error,
  selectedProposalId,
  searchMatchIds,
  searchQuery,
}: BoardViewProps) => {
  // Filter active (non-Done) tasks by proposal + search before grouping so an
  // Arc spanning a failure and its recovery is represented exactly once, in the
  // status that describes its current work.
  const activeTasks = CLUSTERS.flatMap((cluster) => byCluster[cluster]).filter((task) => {
    if (selectedProposalId !== null && task.parentProposalId !== selectedProposalId) return false
    return searchMatchIds == null || searchMatchIds.has(task.id)
  })
  // Done tasks are arc metadata — they are always passed to arc grouping so a
  // completed origin can provide its prompt as the arc title and prevent a false
  // "Abandoned arc / origin force-purged" display. They bypass search and
  // proposal filtering because they are not visible items on the board.
  const doneTasks = byCluster['Done'] ?? []
  const arcsByCluster = buildArcsByCluster([...activeTasks, ...doneTasks], proposals)

  // Total active tasks visible after proposal + search filtering.
  // Used to detect the search zero-state (active query that matches nothing).
  // Done tasks are excluded since they are not rendered on the board.
  const totalMatchedTasks = activeTasks.length

  // Arc count per tab (for the mobile strip badges)
  const tabCounts: Record<Cluster, number> = {
    Queued: arcsByCluster.Queued.length,
    'In progress': arcsByCluster['In progress'].length,
    Blocked: arcsByCluster.Blocked.length,
    Failed: arcsByCluster.Failed.length,
    Done: 0, // arcs never resolve to Done; tab does not appear in ALL_TABS
  }

  // Default to the leftmost non-empty of Failed → Blocked → In progress → Queued; else Queued
  const defaultTab = DEFAULT_TAB_PRIORITY.find((t) => tabCounts[t] > 0) ?? 'Queued'

  // Active tab controls which single column is visible on mobile
  const [activeTab, setActiveTab] = useState<Cluster>(defaultTab)

  const visibleTabs = ALL_TABS

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
        {visibleTabs.map((tab) => {
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
      {/* Board layout                                                         */}
      {/*   mobile  (<768px):   flex-col, one column at a time (tab-driven)   */}
      {/*   tablet  (768–1024px): CSS grid, 2–3 fluid columns, vertical scroll */}
      {/*   desktop (>1024px):  flex-row, original 5 equal columns            */}
      {/* ------------------------------------------------------------------ */}
      <main className="relative flex flex-col min-h-0 flex-1 gap-3 overflow-hidden bg-background p-4 md:grid md:grid-cols-[repeat(auto-fit,minmax(280px,1fr))] md:auto-rows-[400px] md:overflow-y-auto lg:flex lg:flex-row lg:overflow-hidden">
        {/* Zero-state search pill — shown when a non-empty search matches no tasks.
            pointer-events:none so it never blocks column scroll interaction. */}
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
        {CLUSTERS.map((cluster) => {
          const arcsForCluster = arcsByCluster[cluster]
          const accent: 'highlight' | 'muted' =
            cluster === 'In progress' ? 'highlight' : 'muted'
          // Mobile: show only the active tab's column. Tablet+: show all.
          const isActiveOnMobile = activeTab === cluster
          return (
            <div
              key={cluster}
              data-cluster={cluster}
              className={`${isActiveOnMobile ? 'flex' : 'hidden'} flex-col flex-1 min-h-0 md:flex lg:flex-1 lg:basis-0`}
            >
              <ArcColumn
                label={cluster}
                accent={accent}
                arcs={arcsForCluster}
                expandAll={searchMatchIds != null}
              />
            </div>
          )
        })}
      </main>
      {error ? (
        <div className="border-t border-primary/40 bg-primary/10 px-6 py-1.5 font-mono text-[11px] text-primary">
          {error.message}
        </div>
      ) : null}
    </>
  )
}
