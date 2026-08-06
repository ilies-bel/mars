import type { PurgeArchiveEntry, UITask } from '@/shared/types'
import { TaskCard } from '@/components/TaskCard'
import { isLiveStatus, substepLabel } from '@/shared/substep'
import { humanizeFailureCode } from '@/shared/actionQueueDetail'
import { GhostArc } from '@/widgets/GhostArc'
import type { Cluster } from '@/shared/schemas'

export interface BoardArc {
  /** The origin task id. Legacy tasks use their own id as the arc id. */
  id: string
  /** The single roll-up status used to place this arc on the board. */
  cluster: Cluster
  /** All tasks belonging to the arc (active + Done), ordered from origin to latest recovery. */
  tasks: UITask[]
  /**
   * Count of active (non-Done) members. Shown as "X of Y active" when fewer
   * than `tasks.length`, making the Done-task inclusion explicit on the card.
   */
  activeCount: number
  title: string
  updatedAt: string
  /**
   * When set, this arc's origin task is a compensation/cleanup task for the
   * force-purged arc with this origin_id. Used to render the lifecycle badge.
   */
  compensatesArcId?: string | null
  /**
   * True when the arc's origin task is not present in the board tasks (e.g.
   * it was dropped while a recovery task is still in flight). The arc shows
   * the recovery in a muted "abandoned origin" presentation.
   */
  hasOrphanedOrigin?: boolean
  failureSignature?: string | null
}

interface Props {
  label: string
  arcs: BoardArc[]
  accent?: 'highlight' | 'muted'
  /** Search results should be immediately visible inside their matching arcs. */
  expandAll?: boolean
  purgeArchive?: Map<string, PurgeArchiveEntry>
}

const STATUS_CLASS: Record<Cluster, string> = {
  Failed: 'bg-status-failed/10 text-status-failed',
  Blocked: 'bg-status-blocked/15 text-status-blocked',
  'In progress': 'bg-status-running/10 text-status-running',
  Queued: 'bg-status-queued/10 text-status-queued',
  Done: 'bg-status-queued/10 text-status-queued', // never rendered on board; present for type completeness
}

/**
 * A status lane containing Arc summaries rather than a flat list of tasks.
 * Opening an Arc exposes its constituent task cards, preserving the existing
 * task drawer affordance without making the board itself misleadingly verbose.
 */
export const ArcColumn = ({ label, arcs, accent = 'muted', expandAll = false, purgeArchive }: Props) => {
  let taskIndex = 0

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-2 bg-secondary p-3">
      <header className="flex items-center justify-between border-b border-border/50 px-1 pb-2">
        <span
          className={`font-sans text-[11px] font-semibold tracking-[0.1em] ${
            accent === 'highlight' ? 'text-highlight' : 'text-muted-foreground'
          }`}
        >
          {label}
        </span>
        <span className="font-mono text-[11px] font-semibold text-muted-foreground">
          {arcs.length}
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {arcs.length === 0 ? (
          <div className="px-1 py-2 font-mono text-[11px] text-muted-foreground/70">
            empty
          </div>
        ) : (
          arcs.map((arc) => {
            const startIndex = taskIndex
            taskIndex += arc.tasks.length
            const totalCount = arc.tasks.length
            const activeCount = arc.activeCount
            // "2 of 13 active" when Done members are included; "3 tasks" otherwise.
            const countDisplay =
              activeCount < totalCount
                ? `${activeCount} of ${totalCount} active`
                : `${totalCount} ${totalCount === 1 ? 'task' : 'tasks'}`
            const isLive = arc.cluster === 'In progress'
            // The fine-grained substep the live work is on ("merging", "verifying", …),
            // read off the arc's actively-executing task. Only meaningful for
            // In-progress arcs; other clusters are already labelled by their column.
            const liveTask = isLive
              ? arc.tasks.find((task) => isLiveStatus(task.status))
              : undefined
            const substep = liveTask ? substepLabel(liveTask.status) : null
            const isCompensation = Boolean(arc.compensatesArcId)
            const isOrphaned = Boolean(arc.hasOrphanedOrigin)

            // arc-state encodes the lifecycle position for tests and accessibility:
            //   "cleanup-required" — compensation arc for a force-purged arc
            //   "orphaned-origin"  — live recovery whose origin was force-purged
            //   "active"           — normal origin-recovery arc (origin present)
            const arcState = isCompensation
              ? 'cleanup-required'
              : isOrphaned
                ? 'orphaned-origin'
                : 'active'

            const ghostEntry = isCompensation && arc.compensatesArcId
              ? purgeArchive?.get(arc.compensatesArcId)
              : undefined

            return (
              <div key={arc.id} className="flex flex-col gap-1">
                {ghostEntry && arc.compensatesArcId ? (
                  <GhostArc entry={ghostEntry} compensationArcId={arc.id} />
                ) : null}
                <details
                  data-arc-id={arc.id}
                data-arc-status={arc.cluster}
                data-arc-state={arcState}
                data-compensates-arc={arc.compensatesArcId ?? undefined}
                open={expandAll || undefined}
                className={`mars-card group rounded-lg bg-card hover:bg-secondary${isLive ? ' mars-card-live' : ''}`}
              >
                <summary
                  aria-label={`Arc ${arc.id}: ${arc.cluster}, ${countDisplay}${isCompensation ? `, compensating arc ${arc.compensatesArcId}` : ''}`}
                  className="flex cursor-pointer list-none items-start gap-2 p-3 [&::-webkit-details-marker]:hidden"
                >
                  <span
                    aria-hidden="true"
                    className="mt-0.5 text-muted-foreground transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none"
                  >
                    ▾
                  </span>
                  <span className="min-w-0 flex-1">
                    {/* Title: muted for orphaned arcs (origin force-purged, recovery live).
                        No line-through — the recovery is active, not abandoned. */}
                    <span className={`block line-clamp-2 text-body font-medium leading-snug ${isOrphaned ? 'text-muted-foreground/70' : 'text-foreground'}`}>
                      {arc.title}
                    </span>
                    <span className="mt-1 block font-mono text-meta text-muted-foreground">
                      arc {arc.id}
                    </span>
                    {substep ? (
                      <span className="mt-1 block font-mono text-micro font-semibold uppercase tracking-wide text-status-running">
                        {substep}
                      </span>
                    ) : null}
                    {isCompensation ? (
                      <span className="mt-1 block font-mono text-[10px] text-warn">
                        ↩ compensates arc {arc.compensatesArcId}
                      </span>
                    ) : null}
                    {isOrphaned ? (
                      <span className="mt-1 block font-mono text-[10px] text-muted-foreground/70" data-arc-state="orphaned-origin">
                        ↱ recovery in progress · origin force-purged
                      </span>
                    ) : null}
                    {arc.failureSignature != null ? (
                      <span
                        className="mt-1 block font-mono text-[10px] text-error/80"
                        title={arc.failureSignature}
                      >
                        {humanizeFailureCode(arc.failureSignature)}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide ${STATUS_CLASS[arc.cluster]}`}>
                      {isLive ? (
                        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-mars-pulse" />
                      ) : null}
                      {arc.cluster}
                    </span>
                    <span className="font-mono text-meta text-muted-foreground">
                      {countDisplay}
                    </span>
                  </span>
                </summary>
                <div className="border-t border-border/60 p-2">
                  <div className="flex flex-col gap-2">
                    {arc.tasks.map((task, index) => (
                      <TaskCard key={task.id} task={task} index={startIndex + index} />
                    ))}
                  </div>
                </div>
              </details>
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}
