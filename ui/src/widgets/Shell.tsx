import { useState } from 'react'
import type { ReactNode } from 'react'
import { useCounts } from '@/entities/counts/useCounts'
import { resolvePageRoute } from '@/shared/routing'
import type { RouteName } from '@/shared/routing'
import { useSseConnected } from '@/shared/sseStatus'
import { deriveBreadcrumbs } from './Breadcrumbs'
import { DaemonDownBanner } from './DaemonDownBanner'
import { DispatchPausedChip } from './DispatchPausedChip'
import { LiveParkedChip } from './LiveParkedChip'
import { ProjectSelector } from './ProjectSelector'
import { BellMenu } from './BellMenu'

// ── Nav groups ────────────────────────────────────────────────────────────────

interface NavEntry {
  route: RouteName
  label: string
  href: string
  icon: string
}

interface NavGroup {
  label: string
  /** Shown as a one-line muted subtitle under the group label. */
  description?: string
  entries: NavEntry[]
  /** When true the group is collapsible; collapsed by default. */
  collapsible?: boolean
}

/**
 * Four-group sidebar navigation: Decide → Watch → Tune → Advanced.
 * Ten entries total. Advanced is collapsed by default, and auto-expands
 * when the active route is one of its own (steward, studio, events, reflections).
 *
 * Glyph rules:
 *   - Every icon is unique; the wordmark glyph (◆) is not reused here.
 *   - 'proposals' links to the dedicated #/proposals page.
 *   - 'studio' links to #/progress (the entry point to studio per-task);
 *     while on a studio route the Studio entry highlights and Advanced expands.
 *   - 'triage' ("Needs You") is the default landing page and carries the
 *     pending-decision badge.
 *   - 'steward' (#/steward) has a sidebar entry under Advanced.
 */
export const SHELL_NAV_GROUPS: NavGroup[] = [
  {
    label: 'Decide',
    description: 'things waiting on you',
    entries: [
      { route: 'triage', label: 'Needs You', href: '#/triage', icon: '◉' },
      { route: 'proposals', label: 'Proposals', href: '#/proposals', icon: '⌥' },
    ],
  },
  {
    label: 'Watch',
    description: 'what is running and what landed',
    entries: [
      { route: 'progress', label: 'Progress', href: '#/progress', icon: '◈' },
      { route: 'chat', label: 'Chat', href: '#/chat', icon: '⊙' },
    ],
  },
  {
    label: 'Tune',
    description: 'levers and health',
    entries: [
      { route: 'control', label: 'Control Room', href: '#/control', icon: '⌂' },
      { route: 'kpi', label: 'KPI', href: '#/kpi', icon: '◧' },
    ],
  },
  {
    label: 'Advanced',
    collapsible: true,
    entries: [
      { route: 'events', label: 'Events', href: '#/events', icon: '⌬' },
      { route: 'reflections', label: 'Reflections', href: '#/reflections', icon: '⚑' },
      { route: 'steward', label: 'Steward', href: '#/steward', icon: '◎' },
      { route: 'studio', label: 'Studio', href: '#/progress', icon: '⊞' },
    ],
  },
]

// ── ShellTopbar ───────────────────────────────────────────────────────────────

interface ShellTopbarProps {
  hash: string
}

const ShellTopbar = ({ hash }: ShellTopbarProps) => {
  const connected = useSseConnected()
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
        className="shrink-0 font-mono text-body font-semibold tracking-wide"
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
                  <span className="font-mono text-label text-muted-dark/40" aria-hidden="true">
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

      {/* Right-side chrome — SSE status, dispatch pause, then awaiting-human counter.
          All hidden when they don't apply, so the bar costs nothing in the normal case. */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {!connected && (
          <span
            data-testid="sse-reconnecting-pill"
            aria-label="Live updates paused — reconnecting to the daemon"
            className="shrink-0 rounded-full px-2 py-0.5 font-mono text-micro leading-none"
            style={{ background: 'rgba(168, 150, 132, 0.15)', color: 'var(--color-muted-dark)' }}
          >
            ⊘ live updates paused
          </span>
        )}
        <DispatchPausedChip />
        <LiveParkedChip />
        <BellMenu />
      </div>
    </header>
  )
}

// ── ShellSidebar ──────────────────────────────────────────────────────────────

interface ShellSidebarProps {
  activeRoute: RouteName
  decisionBadge: number
  /**
   * When provided, overrides the default "N decisions pending" aria-label with a
   * richer composition string, e.g. "4 decisions pending (3 alerts + 1 proposal cluster)".
   * Lets operators and the chat agent reconcile the badge count at a glance.
   */
  badgeAriaLabel?: string
  /**
   * Controls whether the collapsible Advanced group is expanded.
   * Defaults to false (collapsed). Passed explicitly so tests can use
   * renderToStaticMarkup without needing localStorage or useState.
   */
  advancedExpanded?: boolean
  /** Called when the user clicks the Advanced group toggle. */
  onAdvancedToggle?: () => void
}

/**
 * Dark 200 px sidebar with four labelled groups and ten nav entries.
 *
 * Exported for direct testing with controlled props — the badge count,
 * active route, and Advanced-group expansion state are passed in rather than
 * fetched inside the component, keeping it a pure render function suitable
 * for `renderToStaticMarkup` tests.
 *
 * Active-route rules:
 *   - Every entry is active when entry.route === activeRoute. No exceptions.
 *   - Studio and Steward are in the Advanced group; pass advancedExpanded=true
 *     to see their entries and their active highlight.
 *   - The Shell wrapper auto-expands Advanced when activeRoute is 'studio' or
 *     'steward', so the highlight is always visible in the full shell.
 */
export const ShellSidebar = ({
  activeRoute,
  decisionBadge,
  badgeAriaLabel,
  advancedExpanded = false,
  onAdvancedToggle,
}: ShellSidebarProps) => (
  <nav
    aria-label="Main navigation"
    className="flex flex-col overflow-y-auto border-r border-border-dark bg-bg-dark pt-2 pb-4"
  >
    {SHELL_NAV_GROUPS.map((group) => {
      const isCollapsible = group.collapsible === true
      const isExpanded = isCollapsible ? advancedExpanded : true

      return (
        <div key={group.label} className="mb-1">
          {isCollapsible ? (
            <button
              onClick={onAdvancedToggle}
              aria-expanded={isExpanded}
              className="flex w-full items-center justify-between px-3 pb-1 pt-2"
            >
              <p className="font-mono text-micro uppercase tracking-widest text-muted-dark">
                {group.label}
              </p>
              <span
                className={[
                  'font-mono text-micro text-muted-dark/60 transition-transform duration-200',
                  isExpanded ? 'rotate-180' : '',
                ].join(' ')}
                aria-hidden="true"
              >
                ▾
              </span>
            </button>
          ) : (
            <div className="px-3 pb-1 pt-2">
              <p className="font-mono text-micro uppercase tracking-widest text-muted-dark">
                {group.label}
              </p>
              {group.description && (
                <p className="mt-0.5 font-mono text-micro text-muted-dark/40">
                  {group.description}
                </p>
              )}
            </div>
          )}
          {isExpanded &&
            group.entries.map((entry) => {
              // Every entry highlights when its route matches the active route.
              // Studio and Steward are in Advanced; Shell auto-expands Advanced
              // when those routes are active so the highlight is always visible.
              const isActive: boolean = entry.route === activeRoute

              const showBadge = entry.route === 'triage' && decisionBadge > 0

              return (
                <a
                  key={entry.label}
                  href={entry.href}
                  aria-current={isActive ? 'page' : undefined}
                  className={[
                    'group relative flex items-center gap-2 px-3 py-[5px] font-mono text-label transition-all duration-150 ease-out hover:bg-surface-dark hover:text-fg-dark',
                    isActive
                      ? 'border-r-2 border-highlight bg-highlight/20'
                      : 'text-muted-dark',
                  ].join(' ')}
                  style={isActive ? { color: 'var(--color-amber)' } : undefined}
                >
                  <span className="w-3.5 text-center text-body opacity-70 transition-opacity duration-150 ease-out group-hover:opacity-100" aria-hidden="true">
                    {entry.icon}
                  </span>
                  {entry.label}
                  {showBadge && (
                    <span
                      aria-label={badgeAriaLabel ?? `${decisionBadge > 99 ? '99+' : decisionBadge} decisions pending`}
                      className="ml-auto min-w-[18px] animate-badge-pulse rounded-full px-1.5 py-0.5 text-center font-mono text-micro font-medium leading-none text-white"
                    >
                      {decisionBadge > 99 ? '99+' : decisionBadge}
                    </span>
                  )}
                </a>
              )
            })}
        </div>
      )
    })}
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
const ADVANCED_LS_KEY = 'shell-advanced-expanded'

export const Shell = ({ hash, children }: ShellProps) => {
  // Badge = the canonical "needs you" count from the unified counts endpoint.
  // This is the single source of truth shared by the sidebar badge, board
  // header, Control Room Now-strip, and chat greeting — all read from
  // useCounts() so no widget recomputes the number independently.
  // Draft proposals are excluded from needsYou server-side (same predicate
  // as viewStatusCounts.needYou and countNeedsYou).
  const { needsYou: decisionBadge } = useCounts()
  const activeRoute = resolvePageRoute(hash)

  const [advancedExpanded, setAdvancedExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ADVANCED_LS_KEY) === 'true'
    } catch {
      return false
    }
  })

  const handleAdvancedToggle = () => {
    setAdvancedExpanded((prev) => {
      const next = !prev
      try {
        localStorage.setItem(ADVANCED_LS_KEY, String(next))
      } catch {
        // localStorage may be blocked in private browsing — silently ignore
      }
      return next
    })
  }

  const badgeAriaLabel: string | undefined =
    decisionBadge > 0
      ? `${decisionBadge > 99 ? '99+' : decisionBadge} decisions pending`
      : undefined

  // Auto-expand the Advanced group when the active route is one of its routes
  // (steward, studio) so the highlighted entry is always visible regardless of
  // the user's localStorage preference. Does not persist the expansion state.
  const effectiveAdvancedExpanded =
    advancedExpanded || activeRoute === 'steward' || activeRoute === 'studio'

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[200px_1fr] grid-rows-[40px_1fr]">
      <ShellTopbar hash={hash} />
      <ShellSidebar
        activeRoute={activeRoute}
        decisionBadge={decisionBadge}
        badgeAriaLabel={badgeAriaLabel}
        advancedExpanded={effectiveAdvancedExpanded}
        onAdvancedToggle={handleAdvancedToggle}
      />
      {/* The banner sits above the page content rather than above the topbar so
          it reads as a statement about what is on screen: everything under it
          is stale. It renders nothing while the daemon is healthy. */}
      <div className="flex min-h-0 flex-col overflow-hidden">
        <DaemonDownBanner />
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  )
}
