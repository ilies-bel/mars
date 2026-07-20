import type { UITask } from '@/shared/types'
import { TaskCard } from '@/components/TaskCard'
import type { Cluster } from '@/shared/schemas'

export interface BoardArc {
  /** The origin task id. Legacy tasks use their own id as the arc id. */
  id: string
  /** The single roll-up status used to place this arc on the board. */
  cluster: Cluster
  /** Open tasks belonging to the arc, ordered from origin to latest recovery. */
  tasks: UITask[]
  title: string
  updatedAt: string
}

interface Props {
  label: string
  arcs: BoardArc[]
  accent?: 'flame' | 'muted'
  /** Search results should be immediately visible inside their matching arcs. */
  expandAll?: boolean
}

const STATUS_CLASS: Record<Cluster, string> = {
  Failed: 'bg-iron/10 text-iron',
  Blocked: 'bg-amber/15 text-ochre',
  'In progress': 'bg-flame/10 text-flame',
  Queued: 'bg-basalt/10 text-basalt',
}

/**
 * A status lane containing Arc summaries rather than a flat list of tasks.
 * Opening an Arc exposes its constituent task cards, preserving the existing
 * task drawer affordance without making the board itself misleadingly verbose.
 */
export const ArcColumn = ({ label, arcs, accent = 'muted', expandAll = false }: Props) => {
  let taskIndex = 0

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-2 bg-panel p-3">
      <header className="flex items-center justify-between border-b border-border/50 px-1 pb-2">
        <span
          className={`font-sans text-[11px] font-semibold tracking-[0.1em] ${
            accent === 'flame' ? 'text-flame' : 'text-muted'
          }`}
        >
          {label}
        </span>
        <span className="font-mono text-[11px] font-semibold text-muted">
          {arcs.length}
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {arcs.length === 0 ? (
          <div className="px-1 py-2 font-mono text-[11px] text-muted/70">
            empty
          </div>
        ) : (
          arcs.map((arc) => {
            const startIndex = taskIndex
            taskIndex += arc.tasks.length
            const taskLabel = arc.tasks.length === 1 ? 'task' : 'tasks'
            const isLive = arc.cluster === 'In progress'

            return (
              <details
                key={arc.id}
                data-arc-id={arc.id}
                data-arc-status={arc.cluster}
                open={expandAll || undefined}
                className="group rounded-md border border-border bg-surface transition-colors duration-150 hover:bg-panel"
              >
                <summary
                  aria-label={`Arc ${arc.id}: ${arc.cluster}, ${arc.tasks.length} ${taskLabel}`}
                  className="flex cursor-pointer list-none items-start gap-2 p-3 [&::-webkit-details-marker]:hidden"
                >
                  <span
                    aria-hidden="true"
                    className="mt-0.5 text-muted transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none"
                  >
                    ▾
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block line-clamp-2 text-body font-medium leading-snug text-fg">
                      {arc.title}
                    </span>
                    <span className="mt-1 block font-mono text-meta text-muted">
                      arc {arc.id}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide ${STATUS_CLASS[arc.cluster]}`}>
                      {isLive ? (
                        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-mars-pulse" />
                      ) : null}
                      {arc.cluster}
                    </span>
                    <span className="font-mono text-meta text-muted">
                      {arc.tasks.length} {taskLabel}
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
            )
          })
        )}
      </div>
    </section>
  )
}
