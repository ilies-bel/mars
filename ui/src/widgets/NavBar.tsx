import { useTasks } from '@/hooks/useTasks'
import { useTodo } from '@/hooks/useTodo'
import { detectRoute, actionQueueCount } from '@/shared/routing'

interface NavBarProps {
  hash: string
}

const linkClass = (active: boolean): string =>
  [
    'rounded px-2 py-1 font-mono text-[11px] uppercase tracking-wide',
    active ? 'bg-iron/30 text-fg' : 'text-iron hover:text-fg',
  ].join(' ')

interface CountBadgeProps {
  count: number
}

const CountBadge = ({ count }: CountBadgeProps) =>
  count === 0 ? null : (
    <span className="absolute -top-1 -right-1 rounded-full bg-iron/60 px-1 font-mono text-[9px] leading-none text-fg">
      {count}
    </span>
  )

export const NavBar = ({ hash }: NavBarProps) => {
  const route = detectRoute(hash)

  const todo = useTodo()
  const { snapshot } = useTasks()

  const actionCount = actionQueueCount({ drafts: todo.drafts, staleWorktrees: todo.staleWorktrees })
  const kanbanCount = snapshot ? snapshot.columns.in_progress.length : 0

  return (
    <nav className="flex items-center gap-2 border-b border-iron/30 bg-bg px-4 py-1.5">
      <span className="relative">
        <CountBadge count={actionCount} />
        <a className={linkClass(route === 'action-queue')} href="#/action-queue">
          Action queue
        </a>
      </span>
      <span className="relative">
        <CountBadge count={kanbanCount} />
        <a className={linkClass(route === 'kanban')} href="#/kanban">
          Kanban
        </a>
      </span>
      <span>
        <a className={linkClass(route === 'agents')} href="#/agents">
          Agents
        </a>
      </span>
    </nav>
  )
}
