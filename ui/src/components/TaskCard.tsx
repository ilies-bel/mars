import type { UITask } from '../lib/types'
import { relativeTime } from '../lib/time'
import { RoleTag } from './RoleTag'

interface Props {
  task: UITask
  index: number
}

export const TaskCard = ({ task, index }: Props) => {
  const failedBorder = task.failed ? 'border-l-2 border-l-iron' : ''
  return (
    <article
      data-task-index={index}
      className={`flex flex-col gap-2 rounded-md border border-border bg-surface p-3 ${failedBorder}`}
    >
      <div className="font-mono text-[11px] text-muted">{task.shortId}</div>
      <div className="text-[14px] font-medium leading-snug text-fg">
        {task.title}
      </div>
      <div className="flex items-center justify-between gap-2">
        <RoleTag role={task.role} />
        <span className="font-mono text-[11px] text-muted">
          {relativeTime(task.createdAt)}
        </span>
      </div>
    </article>
  )
}
