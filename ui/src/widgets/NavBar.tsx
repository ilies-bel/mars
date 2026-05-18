import { useAgents } from '@/hooks/useAgents'
import { useTasks } from '@/hooks/useTasks'
import { useTodo } from '@/hooks/useTodo'

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
  const onKanban = hash.startsWith('#/kanban')
  const onAgents = hash.startsWith('#/agents')
  const onInbox = !onKanban && !onAgents

  const { drafts, staleWorktrees } = useTodo()
  const { snapshot } = useTasks()
  const { agents } = useAgents()

  const inboxCount = drafts.length + staleWorktrees.length
  const kanbanCount = snapshot
    ? snapshot.columns.backlog.length +
      snapshot.columns.in_progress.length +
      snapshot.columns.done.length
    : 0
  const agentsCount = agents?.length ?? 0

  return (
    <nav className="flex items-center gap-2 border-b border-iron/30 bg-bg px-4 py-1.5">
      <span className="relative">
        <CountBadge count={inboxCount} />
        <a className={linkClass(onInbox)} href="#/todo">
          Inbox
        </a>
      </span>
      <span className="relative">
        <CountBadge count={kanbanCount} />
        <a className={linkClass(onKanban)} href="#/kanban">
          Kanban
        </a>
      </span>
      <span className="relative">
        <CountBadge count={agentsCount} />
        <a className={linkClass(onAgents)} href="#/agents">
          Agents
        </a>
      </span>
    </nav>
  )
}
