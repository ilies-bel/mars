import type { ReactNode } from 'react'
import { useStaleWorktrees } from '@/entities/stale-worktrees/useStaleWorktrees'
import { useDaemonConnected } from '@/hooks/useDaemonConnected'
import { actionQueueCount, resolvePageRoute } from '@/shared/routing'
import type { RouteName } from '@/shared/routing'
import { deriveBreadcrumbs } from './Breadcrumbs'
import { ProjectSelector } from './ProjectSelector'

// ── Nav groups ────────────────────────────────────────────────────────────────

type NavRoute = RouteName | 'proposals'

interface NavEntry {
  route: NavRoute
  label: string
  href: string
  icon: string
}

interface NavGroup {
  label: string
  entries: NavEntry[]
}

/**
 * Three-group sidebar navigation matching the mockup layout.
 * Workspace → Developer → Intel, ten entries total.
 * 'proposals' is a special route that links to '#/progress' but never
 * highlights as active (it is a filter shortcut, not a distinct page).
 */
export const SHELL_NAV_GROUPS: NavGroup[] = [
  {
    label: 'Workspace',
    entries: [
      { route: 'triage', label: 'Needs you', href: '#/triage', icon: '◉' },
      { route: 'chat', label: 'Chat', href: '#/chat', icon: '◆' },
      { route: 'progress', label: 'Progress', href: '#/progress', icon: '◈' },
      { route: 'control', label: 'Control Room', href: '#/control', icon: '⌂' },
    ],
  },
  {
    label: 'Developer',
    entries: [
      // Studio requires a taskId — the entry links to Progress, its mother page;
      // it highlights only when a task Studio view is actually open (route=studio).
      { route: 'studio', label: 'Studio', href: '#/progress', icon: '⬡' },
      { route: 'events', label: 'Events', href: '#/events', icon: '⌬' },
      { route: 'reflections', label: 'Reflections', href: '#/reflections', icon: '⚑' },
      { route: 'steward', label: 'Steward', href: '#/steward', icon: '✦' },
    ],
  },
  {
    label: 'Intel',
    entries: [
      { route: 'kpi', label: 'KPI', href: '#/kpi', icon: '◈' },
      // Proposals is a filter shortcut onto the Progress board; no distinct page.
      { route: 'proposals', label: 'Proposals', href: '#/progress', icon: '⌥' },
    ],
  },
]

// ── ShellTopbar ───────────────────────────────────────────────────────────────

interface ShellTopbarProps {
  hash: string
}

const ShellTopbar = ({ hash }: ShellTopbarProps) => {
  const crumbs = deriveBreadcrumbs(hash)
  const connected = useDaemonConnected()

  return (
    <header className="col-span-2 flex h-10 items-center gap-3 border-b border-neutral-700 bg-neutral-800 px-4">
      {/* Wordmark */}
      <span
        className="shrink-0 font-mono text-[13px] font-bold tracking-wide"
        style={{ color: 'var(--color-amber)' }}
      >
        ◆ mars
      </span>

      <span className="h-4 w-px shrink-0 bg-neutral-700" aria-hidden="true" />

      {/* Project switcher */}
      <div className="relative shrink-0">
        <ProjectSelector />
      </div>

      {/* Breadcrumb — only rendered when there is something to show */}
      {crumbs.length > 0 && (
        <>
          <span className="h-4 w-px shrink-0 bg-neutral-700" aria-hidden="true" />
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            {crumbs.map((crumb, i) => (
              <span key={i} className="flex shrink-0 items-center gap-1.5">
                {i > 0 && (
                  <span className="font-mono text-[11px] text-neutral-500" aria-hidden="true">
                    ›
                  </span>
                )}
                {crumb.href ? (
                  <a
                    href={crumb.href}
                    className="font-mono text-[11px] text-neutral-400 hover:text-neutral-200"
                  >
                    {crumb.label}
                  </a>
                ) : (
                  <span className="font-mono text-[11px] text-neutral-200">{crumb.label}</span>
                )}
              </span>
            ))}
          </nav>
        </>
      )}

      {/* Live indicator — reflects daemon SSE connection state */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <span
          className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-success animate-pulse' : 'bg-muted'}`}
          aria-hidden="true"
          data-testid="shell-live-dot"
        />
        <span className="font-mono text-[10px] text-neutral-400">
          {connected ? 'Live' : 'Offline'}
        </span>
      </div>
    </header>
  )
}

// ── ShellSidebar ──────────────────────────────────────────────────────────────

interface ShellSidebarProps {
  activeRoute: RouteName
  decisionBadge: number
}

/**
 * Dark 200 px sidebar with three labelled groups and nine nav entries.
 *
 * Exported for direct testing with controlled props — the badge count and
 * active route are passed in rather than fetched inside the component, keeping
 * it a pure render function suitable for `renderToStaticMarkup` tests.
 */
export const ShellSidebar = ({ activeRoute, decisionBadge }: ShellSidebarProps) => (
  <nav
    aria-label="Main navigation"
    className="flex flex-col overflow-y-auto border-r border-neutral-800 bg-neutral-900 pt-2"
  >
    {SHELL_NAV_GROUPS.map((group) => (
      <div key={group.label} className="mb-1">
        <p className="px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-widest text-neutral-600">
          {group.label}
        </p>
        {group.entries.map((entry) => {
          // 'proposals' is a link shortcut, never highlighted as its own active state.
          const isActive = entry.route !== 'proposals' && entry.route === activeRoute
          const showBadge = entry.route === 'triage' && decisionBadge > 0

          return (
            <a
              key={entry.label}
              href={entry.href}
              aria-current={isActive ? 'page' : undefined}
              className={[
                'relative flex items-center gap-2 px-3 py-[5px] font-mono text-[11px] transition-colors hover:bg-neutral-800 hover:text-neutral-200',
                isActive
                  ? 'border-r-2 border-highlight bg-highlight/20'
                  : 'text-neutral-400',
              ].join(' ')}
              style={isActive ? { color: 'var(--color-amber)' } : undefined}
            >
              <span className="w-3.5 text-center text-[12px] opacity-70" aria-hidden="true">
                {entry.icon}
              </span>
              {entry.label}
              {showBadge && (
                <span
                  aria-label={`${decisionBadge > 99 ? '99+' : decisionBadge} decisions pending`}
                  className="ml-auto rounded-full bg-primary/60 px-1 py-0.5 font-mono text-[9px] leading-none text-foreground"
                >
                  {decisionBadge > 99 ? '99+' : decisionBadge}
                </span>
              )}
            </a>
          )
        })}
      </div>
    ))}
  </nav>
)

// ── Shell ─────────────────────────────────────────────────────────────────────

interface ShellProps {
  hash: string
  children: ReactNode
}

/**
 * Persistent shell that wraps every page.
 *
 * Renders a CSS grid:
 *   columns  200 px sidebar | 1 fr content
 *   rows     40 px topbar   | 1 fr body
 *
 * The topbar spans both columns (col-span-2). Shell fills the remaining flex
 * height of its parent (flex-1 min-h-0).
 */
export const Shell = ({ hash, children }: ShellProps) => {
  const { staleWorktrees } = useStaleWorktrees()
  const activeRoute = resolvePageRoute(hash)
  const decisionBadge = actionQueueCount({ staleWorktrees })

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[200px_1fr] grid-rows-[40px_1fr]">
      <ShellTopbar hash={hash} />
      <ShellSidebar activeRoute={activeRoute} decisionBadge={decisionBadge} />
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}
