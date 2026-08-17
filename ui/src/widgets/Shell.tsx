import type { ReactNode } from 'react'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { sortItems, buildRenderedRows } from '@/entities/actionQueue/clusterRows'
import { useDaemonConnected } from '@/hooks/useDaemonConnected'
import { resolvePageRoute } from '@/shared/routing'
import type { RouteName } from '@/shared/routing'
import { deriveBreadcrumbs } from './Breadcrumbs'
import { ProjectSelector } from './ProjectSelector'

// ── Nav groups ────────────────────────────────────────────────────────────────

interface NavEntry {
  route: RouteName
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
 *   - 'proposals' links to the dedicated #/proposals page.
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
      { route: 'proposals', label: 'Proposals', href: '#/proposals', icon: '⌥' },
    ],
  },
]

// ── ShellTopbar ───────────────────────────────────────────────────────────────

interface ShellTopbarProps {
  hash: string
}

const ShellTopbar = ({ hash }: ShellTopbarProps) => {
  const connected = useDaemonConnected()
  const derivedCrumbs = deriveBreadcrumbs(hash)

  // For top-level nav routes, deriveBreadcrumbs returns []; fall back to group › page crumbs
  // derived from SHELL_NAV_GROUPS so the topbar always shows a location trail.
  const crumbs =
    derivedCrumbs.length > 0
      ? derivedCrumbs
      : (() => {
          const route = resolvePageRoute(hash)
          for (const group of SHELL_NAV_GROUPS) {
            const entry = group.entries.find(
              (e) => e.route === route,
            )
            if (entry)
              return [
                { label: group.label, href: null },
                { label: entry.label, href: null },
              ]
          }
          return []
        })()

  return (
    <header className="col-span-2 flex h-10 items-center gap-3 border-b border-border-dark bg-surface-dark px-4">
      {/* Wordmark */}
      <span
        className="shrink-0 font-mono text-body font-bold tracking-wide"
        style={{ color: 'var(--color-amber)' }}
      >
        ◆ mars
      </span>

      <span className="h-4 w-px shrink-0 bg-border-dark" aria-hidden="true" />

      {/* Project switcher */}
      <div className="relative shrink-0">
        <ProjectSelector />
      </div>

      {/* Breadcrumb — only rendered when there is something to show */}
      {crumbs.length > 0 && (
        <>
          <span className="h-4 w-px shrink-0 bg-border-dark" aria-hidden="true" />
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            {crumbs.map((crumb, i) => (
              <span key={i} className="flex shrink-0 items-center gap-1.5">
                {i > 0 && (
                  <span className="font-mono text-label text-muted-dark" aria-hidden="true">
                    ›
                  </span>
                )}
                {crumb.href ? (
                  <a
                    href={crumb.href}
                    className="font-mono text-label text-muted-dark hover:text-fg-dark"
                  >
                    {crumb.label}
                  </a>
                ) : i === crumbs.length - 1 ? (
                  // Terminal (active page): brightest on-dark text so it reads as the current location
                  <span className="font-mono text-label text-fg-dark">{crumb.label}</span>
                ) : (
                  // Non-terminal without href (e.g. group label): muted
                  <span className="font-mono text-label text-muted-dark">{crumb.label}</span>
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
        <span className="font-mono text-micro text-muted-dark">
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
}

/**
 * Dark 200 px sidebar with three labelled groups and nine nav entries.
 *
 * Exported for direct testing with controlled props — the badge count and
 * active route are passed in rather than fetched inside the component, keeping
 * it a pure render function suitable for `renderToStaticMarkup` tests.
 *
 * Active-route rules:
 *   - 'progress' entry: active when activeRoute === 'progress' or 'studio'
 *     (studio is nested under Progress in the nav).
 *   - All other entries (including 'proposals'): active when entry.route === activeRoute.
 */
export const ShellSidebar = ({ activeRoute, decisionBadge }: ShellSidebarProps) => (
  <nav
    aria-label="Main navigation"
    className="flex flex-col overflow-y-auto border-r border-border-dark bg-bg-dark pt-2"
  >
    {SHELL_NAV_GROUPS.map((group) => (
      <div key={group.label} className="mb-1">
        <p className="px-3 pb-1 pt-2 font-mono text-micro uppercase tracking-widest text-muted-dark">
          {group.label}
        </p>
        {group.entries.map((entry) => {
          // Progress entry highlights for bare progress visits AND studio
          // sub-pages (studio is nested under Progress in the nav).
          // All other entries (including proposals) highlight when their route
          // matches activeRoute.
          const isActive: boolean =
            entry.route === 'progress'
              ? activeRoute === 'progress' || activeRoute === 'studio'
              : entry.route === activeRoute

          const showBadge = entry.route === 'triage' && decisionBadge > 0

          return (
            <a
              key={entry.label}
              href={entry.href}
              aria-current={isActive ? 'page' : undefined}
              className={[
                'relative flex items-center gap-2 px-3 py-[5px] font-mono text-label transition-colors hover:bg-surface-dark hover:text-fg-dark',
                isActive
                  ? 'border-r-2 border-highlight bg-highlight/20'
                  : 'text-muted-dark',
              ].join(' ')}
              style={isActive ? { color: 'var(--color-amber)' } : undefined}
            >
              <span className="w-3.5 text-center text-body opacity-70" aria-hidden="true">
                {entry.icon}
              </span>
              {entry.label}
              {showBadge && (
                <span
                  aria-label={`${decisionBadge > 99 ? '99+' : decisionBadge} decisions pending`}
                  className="ml-auto rounded-full bg-primary/60 px-1 py-0.5 font-mono text-micro leading-none text-foreground"
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
  const { items: actionQueueItems } = useActionQueue()
  const activeRoute = resolvePageRoute(hash)
  // Badge = rendered rows after clustering — matches the count the triage page
  // badge shows (clusters count as 1, not N). Uses the same sortItems +
  // buildRenderedRows pipeline so sidebar and page badges are always equal.
  const decisionBadge = buildRenderedRows(sortItems(actionQueueItems)).length

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[200px_1fr] grid-rows-[40px_1fr]">
      <ShellTopbar hash={hash} />
      <ShellSidebar activeRoute={activeRoute} decisionBadge={decisionBadge} />
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}
