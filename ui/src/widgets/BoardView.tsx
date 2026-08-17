import type { Cluster, ProgressProposalNode, ProgressTask, PurgeArchiveEntry } from '@/shared/schemas'
import type { UITask } from '@/shared/types'
import { taskTitle } from '@/shared/promptTitle'
import { proposalHash } from '@/shared/routing'
import { arcPlacementCluster, resolveArcLabel, sanitizeProposalTitle, taskArcKey } from '@/widgets/topologyFlowModel'
import { BoardCard, DenseColumn, type BoardArc } from '@/widgets/Column'

// ---------------------------------------------------------------------------
// buildArcsByCluster — Arc grouping logic (exported for tests and TopologyView)
// ---------------------------------------------------------------------------

const compareNewestFirst = (a: ProgressTask, b: ProgressTask): number =>
  b.updatedAt.localeCompare(a.updatedAt)

const roleFromStatus = (status: ProgressTask['status']) => {
  switch (status) {
    case 'running':
      return 'builder' as const
    case 'verifying':
      return 'reviewer' as const
    case 'merging':
    case 'vega-reconciling':
      return 'orchestrator' as const
    case 'draft':
    case 'queued':
      return 'planner' as const
    default:
      return 'orchestrator' as const
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

// Internal cluster order used by buildArcsByCluster
const CLUSTERS: readonly Cluster[] = ['Blocked', 'Queued', 'In progress', 'Failed']

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
    Done: [],
  }

  for (const [id, arcTasks] of grouped) {
    const cluster = arcPlacementCluster(arcTasks)
    if (cluster === null) continue
    const orderedTasks = [...arcTasks].sort((a, b) => {
      if (a.id === id) return -1
      if (b.id === id) return 1
      return a.createdAt.localeCompare(b.createdAt)
    })
    const originTask = orderedTasks.find((task) => task.id === id)
    const latestTask = [...arcTasks].sort(compareNewestFirst)[0]!

    const displayTask = originTask ?? latestTask
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
// ProposalCard — dense proposal card (dashed border, ochre-tinted surface)
// ---------------------------------------------------------------------------

const ProposalCard = ({ proposal }: { proposal: ProgressProposalNode }) => {
  const href = proposalHash(proposal.id, 'progress')
  const open = () => {
    window.location.hash = href
  }
  return (
    <article
      data-proposal-card={proposal.id}
      role="button"
      tabIndex={0}
      className="rounded-lg border border-dashed border-warn/50 bg-warn/10 p-2.5 flex flex-col gap-1.5 cursor-pointer hover:bg-warn/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a') !== null) return
        open()
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        if ((e.target as HTMLElement).closest('a') !== null) return
        e.preventDefault()
        open()
      }}
    >
      {/* Row 1: source badge + id (id is an anchor for right-click and testability) */}
      <div className="flex items-center justify-between gap-1 min-w-0">
        <span className="font-mono text-micro font-semibold uppercase tracking-wide text-muted-foreground">
          {proposal.source}
        </span>
        <a
          href={href}
          className="font-mono text-label text-muted-foreground truncate hover:text-foreground hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {proposal.id}
        </a>
      </div>
      {/* Row 2: title */}
      <p className="line-clamp-2 text-body font-medium leading-snug text-foreground">
        {sanitizeProposalTitle(proposal.title)}
      </p>
      {/* Row 3: mockup-ready chip (conditional) */}
      {proposal.mockupReady ? (
        <span className="self-start rounded bg-status-done/15 px-1.5 py-0.5 font-mono text-micro font-semibold text-status-done">
          mockup ready ↗
        </span>
      ) : null}
    </article>
  )
}

// ---------------------------------------------------------------------------
// BoardView props (stable contract — callers unchanged)
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
// BoardView — dense 4-column board: Proposals / In progress / Blocked / Failed
// ---------------------------------------------------------------------------

export const BoardView = ({
  byCluster,
  proposals,
  error,
  selectedProposalId,
  searchMatchIds,
  searchQuery,
  onClearProposalFilter,
}: BoardViewProps) => {
  // ── Task filtering ─────────────────────────────────────────────────────────
  const filterTask = (t: ProgressTask): boolean => {
    if (selectedProposalId !== null && t.parentProposalId !== selectedProposalId) return false
    return searchMatchIds == null || searchMatchIds.has(t.id)
  }

  // "In progress" column shows queued + actively-running tasks
  const inProgressTasks = [
    ...byCluster['Queued'],
    ...byCluster['In progress'],
  ].filter(filterTask)
  const blockedTasks = byCluster['Blocked'].filter(filterTask)
  const failedTasks = byCluster['Failed'].filter(filterTask)

  const totalFilteredTasks = inProgressTasks.length + blockedTasks.length + failedTasks.length

  // ── Zero states ────────────────────────────────────────────────────────────
  const isSearchActive = searchMatchIds != null
  const showSearchZeroState = isSearchActive && totalFilteredTasks === 0
  const showProposalZeroState =
    !isSearchActive && selectedProposalId !== null && totalFilteredTasks === 0

  // ── Proposal column (unfiltered — always shows all active proposals) ───────
  const visibleProposals = proposals

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* ── Zero-state overlays ─────────────────────────────────────────────── */}
      {showProposalZeroState && (
        <div
          data-testid="proposal-zero-state"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
        >
          <div className="pointer-events-auto flex flex-col items-center gap-3">
            <span className="rounded border border-border bg-card px-3 py-1.5 font-mono text-label text-muted-foreground">
              No active tasks for this proposal
            </span>
            <button
              data-testid="clear-proposal-filter"
              onClick={onClearProposalFilter}
              className="rounded border border-border px-3 py-1.5 font-mono text-label text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
            >
              Clear filter
            </button>
          </div>
        </div>
      )}
      {showSearchZeroState && (
        <div
          data-testid="search-zero-state"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
        >
          <span className="rounded border border-border bg-card px-3 py-1.5 font-mono text-label text-muted-foreground">
            {`0 tasks match '${(searchQuery ?? '').trim()}'`}
          </span>
        </div>
      )}

      {/* ── Dense 4-column grid ─────────────────────────────────────────────── */}
      <main className="grid grid-cols-4 gap-3.5 p-6 items-start overflow-y-auto flex-1">
        {/* Proposals */}
        <DenseColumn label="Proposals" count={visibleProposals.length}>
          {visibleProposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} />
          ))}
        </DenseColumn>

        {/* In progress (queued + running/verifying/merging) */}
        <DenseColumn label="In progress" count={inProgressTasks.length}>
          {inProgressTasks.map((t) => (
            <BoardCard key={t.id} task={t} />
          ))}
        </DenseColumn>

        {/* Blocked */}
        <DenseColumn label="Blocked" count={blockedTasks.length}>
          {blockedTasks.map((t) => (
            <BoardCard key={t.id} task={t} />
          ))}
        </DenseColumn>

        {/* Failed */}
        <DenseColumn label="Failed" count={failedTasks.length}>
          {failedTasks.map((t) => (
            <BoardCard key={t.id} task={t} />
          ))}
        </DenseColumn>
      </main>

      {error ? (
        <div className="border-t border-primary/40 bg-primary/10 px-6 py-1.5 font-mono text-label text-primary">
          {error.message}
        </div>
      ) : null}
    </div>
  )
}
