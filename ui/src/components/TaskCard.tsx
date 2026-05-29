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

export const TaskCard = ({ task, index }: Props) => {
  const accent =
    task.status === 'failed'
      ? 'bg-iron/10'
      : task.status === 'dropped'
        ? 'opacity-70'
        : ''
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
      className={`flex flex-col gap-2 rounded-md border border-border bg-surface p-3 cursor-pointer transition-[transform,background-color] duration-150 ease-out hover:bg-panel active:scale-[0.99] motion-reduce:transform-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame ${accent}`}
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
      <div className="flex items-start justify-between gap-2">
        <a
          href={`#/task/${encodeURIComponent(task.id)}`}
          className="break-all font-mono text-[11px] text-muted hover:text-fg hover:underline"
        >
          {task.id}
        </a>
        <div className="flex shrink-0 items-center gap-1.5">
          {task.retryCount > 0 ? (
            <span
              className="rounded bg-basalt/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide text-basalt"
              title={`retried ${task.retryCount}x`}
            >
              ↻ {task.retryCount}x
            </span>
          ) : null}
          {showChip ? <StatusChip status={task.status} /> : null}
        </div>
      </div>
      <div
        className={`text-[14px] font-medium leading-snug text-fg ${
          task.status === 'dropped' ? 'line-through' : ''
        }`}
      >
        {task.title}
      </div>
      {task.status === 'dropped' && task.dropReason ? (
        <div className="font-mono text-[11px] text-muted">
          {truncate(task.dropReason, 120)}
        </div>
      ) : null}
      {task.status === 'blocked' ? (
        <div className="font-mono text-[11px] text-ochre">
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
        <div className="flex flex-col gap-1 border-t border-border/50 pt-2 font-mono text-[10px] text-muted">
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
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <RoleTag role={task.role} />
        <span className="font-mono text-[11px] text-muted">
          {relativeTime(task.createdAt)}
        </span>
      </div>
    </article>
  )
}
