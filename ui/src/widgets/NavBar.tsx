import { useProgress } from '@/hooks/useProgress'
import { useStaleWorktrees } from '@/entities/stale-worktrees/useStaleWorktrees'
import { detectRoute, actionQueueCount } from '@/shared/routing'
import {
  notificationsSupported,
  notificationPermission,
  requestNotificationPermission,
  setNotificationsEnabled,
  useNotificationsEnabled,
} from '@/shared/notifications/notificationPrefs'
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
    <span aria-hidden="true" className="absolute -top-1 -right-1 rounded-full bg-iron/60 px-1 font-mono text-[9px] leading-none text-fg">
      {count}
    </span>
  )

/**
 * Toggle for desktop notifications on new failed-task / stale-worktree alerts.
 * Turning on prompts for browser permission and only enables on a `granted`
 * result; turning off just clears the opt-in. Reflects unsupported and
 * browser-blocked (denied) states so the control never looks broken.
 */
const NotificationsToggle = () => {
  const enabled = useNotificationsEnabled()

  if (!notificationsSupported()) {
    return (
      <span
        className="font-mono text-[11px] uppercase tracking-wide text-iron/50"
        title="This browser does not support desktop notifications"
      >
        Alerts ✕
      </span>
    )
  }

  const blocked = notificationPermission() === 'denied'

  const onClick = async (): Promise<void> => {
    if (enabled) {
      setNotificationsEnabled(false)
      return
    }
    const result = await requestNotificationPermission()
    setNotificationsEnabled(result === 'granted')
  }

  const label = enabled ? 'Alerts 🔔' : 'Alerts 🔕'
  const title = blocked
    ? 'Notifications are blocked in your browser settings — unblock this site to enable'
    : enabled
      ? 'Desktop notifications on for new alerts — click to turn off'
      : 'Click to get desktop notifications for new alerts'

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      title={title}
      aria-pressed={enabled}
      className={linkClass(enabled)}
    >
      {label}
    </button>
  )
}

export const NavBar = ({ hash }: NavBarProps) => {
  const route = detectRoute(hash)

  const { staleWorktrees } = useStaleWorktrees()
  const { tasks } = useProgress()

  const actionCount = actionQueueCount({ staleWorktrees })
  const progressCount = tasks?.length ?? 0

  return (
    <nav className="flex items-center gap-2 border-b border-iron/30 bg-bg px-4 py-1.5">
      <ProjectSelector />
      <span className="mx-1 h-3 w-px bg-iron/30" aria-hidden="true" />
      <span className="relative">
        <CountBadge count={actionCount} />
        <a
          className={linkClass(route === 'action-queue')}
          href="#/action-queue"
          aria-label={actionCount > 0 ? `Action queue, ${actionCount} items` : undefined}
        >
          Action queue
        </a>
      </span>
      <span className="relative">
        <CountBadge count={progressCount} />
        <a
          className={linkClass(route === 'progress')}
          href="#/progress"
          aria-label={progressCount > 0 ? `Progress, ${progressCount} open tasks` : undefined}
        >
          Progress
        </a>
      </span>
      <span className="relative">
        <a className={linkClass(route === 'events')} href="#/events">
          Events
        </a>
      </span>
      <span className="relative">
        <a className={linkClass(route === 'kpi')} href="#/kpi">
          KPIs
        </a>
      </span>
      <span className="ml-auto">
        <NotificationsToggle />
      </span>
    </nav>
  )
}
