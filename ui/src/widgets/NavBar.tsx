import { useStaleWorktrees } from '@/entities/stale-worktrees/useStaleWorktrees'
import { detectRoute, actionQueueCount } from '@/shared/routing'
import { useNotificationsPreference } from '@/entities/notifications'
import { ProjectSelector } from './ProjectSelector'
import { BellMenu } from './BellMenu'

interface NavBarProps {
  hash: string
}

const linkClass = (active: boolean): string =>
  [
    'rounded px-2 py-1 font-mono text-[11px] uppercase tracking-wide',
    active ? 'bg-primary/30 text-foreground' : 'text-primary hover:text-foreground',
  ].join(' ')

interface CountBadgeProps {
  count: number
}

const CountBadge = ({ count }: CountBadgeProps) =>
  count === 0 ? null : (
    <span aria-hidden="true" className="absolute -top-1 -right-1 rounded-full bg-primary/60 px-1 py-0.5 font-mono text-[9px] leading-none text-foreground">
      {count > 99 ? '99+' : count}
    </span>
  )

/**
 * Toggle for native desktop notifications sent by the daemon on new
 * failed-task / stale-worktree alerts.  The preference is persisted by the
 * daemon so it survives restarts and is shared across every connected client.
 */
const NotificationsToggle = () => {
  const { enabled, setEnabled } = useNotificationsPreference()

  return (
    <button
      type="button"
      onClick={() => setEnabled(!enabled)}
      aria-pressed={enabled}
      title={
        enabled
          ? 'Desktop notifications on for new alerts — click to turn off'
          : 'Click to enable desktop notifications for new alerts'
      }
      className={linkClass(enabled)}
    >
      Desktop notifications
    </button>
  )
}

export const NavBar = ({ hash }: NavBarProps) => {
  const route = detectRoute(hash)

  const { staleWorktrees } = useStaleWorktrees()

  const actionCount = actionQueueCount({ staleWorktrees })

  return (
    <nav className="flex items-center gap-2 border-b border-primary/30 bg-background px-4 py-1.5">
      <ProjectSelector />
      <span className="mx-1 h-3 w-px bg-primary/30" aria-hidden="true" />
      <span className="relative">
        <CountBadge count={actionCount} />
        <a
          className={linkClass(route === 'chat')}
          href="#/chat"
          aria-label={actionCount > 0 ? `Chat, ${actionCount} items` : undefined}
        >
          Chat
        </a>
      </span>
      <span>
        <a className={linkClass(route === 'progress')} href="#/progress">
          Progress
        </a>
      </span>
      <span className="relative">
        <a className={linkClass(route === 'events' || route === 'kpi')} href="#/events">
          Events
        </a>
      </span>
      <span className="ml-auto">
        <NotificationsToggle />
      </span>
      <BellMenu />
    </nav>
  )
}
