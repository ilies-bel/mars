import { useProgress } from '@/hooks/useProgress'
import { useProposals } from '@/entities/proposals/useProposals'
import { useStaleWorktrees } from '@/entities/stale-worktrees/useStaleWorktrees'
import { detectRoute, actionQueueCount } from '@/shared/routing'
import { ProjectSelector } from './ProjectSelector'

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

  const { proposals } = useProposals()
  const { staleWorktrees } = useStaleWorktrees()
  const { tasks } = useProgress()

  const actionCount = actionQueueCount({ drafts: proposals, staleWorktrees })
  const progressCount = tasks?.length ?? 0

  return (
    <nav className="flex items-center gap-2 border-b border-iron/30 bg-bg px-4 py-1.5">
      <ProjectSelector />
      <span className="mx-1 h-3 w-px bg-iron/30" aria-hidden="true" />
      <span className="relative">
        <CountBadge count={actionCount} />
        <a className={linkClass(route === 'action-queue')} href="#/action-queue">
          Action queue
        </a>
      </span>
      <span className="relative">
        <CountBadge count={progressCount} />
        <a className={linkClass(route === 'progress')} href="#/progress">
          Progress
        </a>
      </span>
      <span className="relative">
        <a className={linkClass(route === 'events')} href="#/events">
          Events
        </a>
      </span>
    </nav>
  )
}
