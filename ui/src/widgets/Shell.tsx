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
 * Workspace → Developer → Intel, nine entries total.
 *
 * Glyph rules:
 *   - Every icon is unique; the wordmark glyph (◆) is not reused here.
 *   - 'proposals' is a shortcut that links to #/progress?col=proposals.
 *     It highlights when the URL contains col=proposals; Progress highlights
 *     for bare #/progress visits. The two states are mutually exclusive.
 *   - 'studio' has no top-level entry — it is accessed via #/studio/<taskId>
 *     from the task detail UI; while on that route the Progress entry highlights.
 *   - 'triage' ("Needs you") is the default landing page and carries the
 *     pending-decision badge.
 */
export const SHELL_NAV_GROUPS: NavGroup[] = [
  {
    label: 'Workspace',
    entries: [
      { route: 'triage', label: 'Needs you', href: '#/triage', icon: '◉' },
      { route: 'chat', label: 'Chat', href: '#/chat', icon: '⊙' },
      { route: 'progress', label: 'Progress', href: '#/progress', icon: '◈' },
      { route: 'control', label: 'Control Room', href: '#/control', icon: '⌂' },
    ],
  },
  {
    label: 'Developer',
    entries: [
      { route: 'events', label: 'Events', href: '#/events', icon: '⌬' },
      { route: 'reflections', label: 'Reflections', href: '#/reflections', icon: '⚑' },
      { route: 'steward', label: 'Steward', href: '#/steward', icon: '✦' },
    ],
  },
  {
    label: 'Intel',
    entries: [
      { route: 'kpi', label: 'KPI', href: '#/kpi', icon: '◧' },
      // Proposals is a filter shortcut onto the Progress board (col=proposals).
      { route: 'proposals', label: 'Proposals', href: '#/progress?col=proposals', icon: '⌥' },
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

      {/* Live indicator — reflects daemon SSE connection state.
          When connected the dot pulses green and shows 'Live'.
          When disconnected it shows 'Reconnecting' (EventSource always retries;
          'Offline' is never shown while data may still be rendering from cache). */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <span
          className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-success animate-pulse' : 'bg-muted'}`}
          aria-hidden="true"
          data-testid="shell-live-dot"
        />
        <span className="font-mono text-[10px] text-neutral-400">
          {connected ? 'Live' : 'Reconnecting'}
        </span>
      </div>
    </header>
  )
}

// ── ShellSidebar ──────────────────────────────────────────────────────────────

interface ShellSidebarProps {
  activeRoute: RouteName
  decisionBadge: number
  /**
   * True when the current URL is #/progress?col=proposals (or any
   * #/progress hash that contains col=proposals). When set, the
   * Proposals entry is highlighted and Progress is not, since the two
   * are mutually exclusive views of the same underlying page.
   */
  isProposalsActive?: boolean
}

/**
 * Dark 200 px sidebar with three labelled groups and nine nav entries.
 *
 * Exported for direct testing with controlled props — the badge count and
 * active route are passed in rather than fetched inside the component, keeping
 * it a pure render function suitable for `renderToStaticMarkup` tests.
 *
 * Active-route rules:
 *   - 'proposals' entry: active iff isProposalsActive === true.
 *   - 'progress' entry: active when activeRoute === 'progress' or 'studio'
 *     (studio is nested under Progress) AND isProposalsActive is not set.
 *   - All other entries: active when entry.route === activeRoute.
 */
export const ShellSidebar = ({ activeRoute, decisionBadge, isProposalsActive }: ShellSidebarProps) => (
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
          // Proposals entry highlights only when col=proposals is active.
          // Progress entry highlights for bare progress visits AND studio
          // sub-pages (studio is nested under Progress in the nav).
          // All other entries highlight when their route matches activeRoute.
          let isActive: boolean
          if (entry.route === 'proposals') {
            isActive = isProposalsActive === true
          } else if (entry.route === 'progress') {
            isActive =
              (activeRoute === 'progress' || activeRoute === 'studio') &&
              isProposalsActive !== true
          } else {
            isActive = entry.route === activeRoute
          }

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
  // Proposals shortcut: #/progress?col=proposals highlights the Proposals entry
  // instead of Progress. Mutually exclusive: Progress only highlights for bare
  // #/progress visits (without col=proposals).
  const isProposalsActive = hash.startsWith('#/progress') && hash.includes('col=proposals')

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[200px_1fr] grid-rows-[40px_1fr]">
      <ShellTopbar hash={hash} />
      <ShellSidebar activeRoute={activeRoute} decisionBadge={decisionBadge} isProposalsActive={isProposalsActive} />
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}
