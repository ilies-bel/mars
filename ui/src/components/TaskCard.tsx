import { memo } from 'react'
import type { UITask } from '@/shared/types'
import { relativeTime } from '@/shared/time'
import { RoleTag } from './RoleTag'
import { StatusChip } from './StatusChip'

interface Props {
  task: UITask
  index: number
}

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s

export const TaskCard = memo(({ task, index }: Props) => {
  const accent =
    task.status === 'failed'
      ? 'bg-iron/10'
      : task.status === 'dropped'
        ? 'opacity-70'
        : ''
  // Live-activity indicator: visually signals the task is actively running.
  // Pulse is scoped to a small status dot so text stays legible throughout.
  const isLive =
    task.status === 'running' ||
    task.status === 'merging' ||
    task.status === 'verifying' ||
    task.status === 'vega-reconciling'
  const showChip =
    task.status === 'blocked' ||
    task.status === 'dropped' ||
    task.status === 'failed'

  const spec = task.spec

  const openDrawer = () => {
    window.location.hash = `#/task/${encodeURIComponent(task.id)}`
  }

  return (
    <article
      data-task-index={index}
      data-task-status={task.status}
      tabIndex={0}
      role="button"
      className={`flex flex-col gap-2 rounded-md border border-border bg-surface p-3 cursor-pointer transition-[transform,background-color] duration-150 ease-out hover:bg-panel active:scale-[0.99] motion-reduce:transform-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame ${accent}`.trimEnd()}
      onClick={(e) => {
        // Let inner anchors (e.g. the blocker link) handle their own navigation
        if ((e.target as HTMLElement).closest('a') !== null) return
        openDrawer()
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        if ((e.target as HTMLElement).closest('a') !== null) return
        e.preventDefault()
        openDrawer()
      }}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <a
          href={`#/task/${encodeURIComponent(task.id)}`}
          className="block min-w-0 truncate font-mono text-meta text-muted hover:text-fg hover:underline"
        >
          {task.id}
        </a>
        <div className="flex shrink-0 items-center gap-1.5">
          {isLive ? (
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-flame motion-safe:animate-mars-pulse"
            />
          ) : null}
          {task.retryCount > 0 ? (
            <span
              className="rounded bg-basalt/10 px-1.5 py-0.5 font-mono text-micro font-semibold tracking-wide text-basalt"
              title={`recovered ×${task.retryCount}`}
            >
              ↻ recovered
            </span>
          ) : null}
          {showChip ? <StatusChip status={task.status} /> : null}
        </div>
      </div>
      <div
        className={`line-clamp-3 text-body font-medium leading-snug text-fg ${
          task.status === 'dropped' ? 'line-through' : ''
        }`}
      >
        {task.title}
      </div>
      {task.status === 'dropped' && task.dropReason ? (
        <div className="font-mono text-meta text-muted">
          {truncate(task.dropReason, 120)}
        </div>
      ) : null}
      {task.status === 'blocked' ? (
        <div className="font-mono text-meta text-ochre">
          {task.blockerTaskId ? (
            <a
              href={`#/task/${task.blockerTaskId}`}
              className="break-all underline decoration-dotted underline-offset-2"
            >
              Blocked by · {task.blockerTaskId}
            </a>
          ) : (
            'Blocked'
          )}
        </div>
      ) : null}
      {spec !== null ? (
        <details
          className="border-t border-border/50 pt-2"
          onClick={(e) => e.stopPropagation()}
        >
          <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 py-0.5 font-mono text-micro font-semibold text-muted/80 hover:text-fg">
            <span className="text-fg/60">spec</span>
            <span className="opacity-40 text-[9px]">▾</span>
          </summary>
          <div className="flex flex-col gap-1 pt-1 font-mono text-micro text-muted">
            {spec.files.length > 0 ? (
              <div>
                <span className="font-semibold text-fg/60">files</span>
                <ul className="mt-0.5 space-y-0.5">
                  {spec.files.map((f) => (
                    <li key={f} className="truncate pl-2">
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {(spec.readFirst ?? []).length > 0 ? (
              <div>
                <span className="font-semibold text-fg/60">read first</span>
                <ol className="mt-0.5 list-decimal space-y-0.5 pl-4">
                  {(spec.readFirst ?? []).map((f) => (
                    <li key={f} className="truncate">
                      {f}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            {spec.prescriptiveAction ? (
              <div>
                <span className="font-semibold text-fg/60">action</span>
                <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap pl-2">
                  {spec.prescriptiveAction}
                </p>
              </div>
            ) : null}
            {spec.verifyCmd ? (
              <div>
                <span className="font-semibold text-fg/60">verify</span>
                <code className="mt-0.5 block truncate pl-2">{spec.verifyCmd}</code>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <RoleTag role={task.role} />
        <span className="font-mono text-meta text-muted">
          upd {relativeTime(task.updatedAt)}
        </span>
      </div>
    </article>
  )
})
