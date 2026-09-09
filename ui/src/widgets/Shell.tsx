import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  FlaskConical,
  Inbox,
  Lightbulb,
  MessagesSquare,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  Workflow,
} from 'lucide-react'
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
  icon: LucideIcon
}

interface NavGroup {
  label: string
  entries: NavEntry[]
  /**
   * Renders pinned to the bottom of the sidebar, below a divider, instead of
   * in the scrolling stack. Used for levers, which are a different job from
   * the three reading groups above them.
   */
  footer?: boolean
}

/**
 * Sidebar navigation, clustered by operator intent rather than by subsystem.
 *
 * The previous shape had a four-entry "Advanced" junk drawer that hid 40% of
 * the app behind a disclosure triangle — Events, Reflections, Steward and
 * Studio are not advanced, they answer a different question from the rest.
 * Regrouping by the question each page answers removes the drawer entirely:
 *
 *   Inbox     — what is waiting on me?          Needs You, Proposals, Chat
 *   Activity  — what is the system doing?       Progress, Events
 *   Insight   — how well is it doing it?        KPI, Studio, Reflections, Steward
 *   (footer)  — what can I change?              Control Room
 *
 * Nothing is collapsed and nothing is hidden: all ten destinations are visible
 * at rest, which is the point — a queue you have to expand to see is a queue
 * you stop checking.
 *
 * Icon rules:
 *   - Lucide throughout. The previous Unicode geometric glyphs (◉ ⌥ ◈ ⊙ ⌂ ◧
 *     ⌬ ⚑ ◎ ⊞) had no shared stroke weight, no optical alignment, and font-
 *     dependent rendering. The wordmark keeps its ◆ as a deliberate mark.
 *   - Every icon is unique and semantically motivated.
 */
export const SHELL_NAV_GROUPS: NavGroup[] = [
  {
    label: 'Inbox',
    entries: [
      { route: 'triage', label: 'Needs You', href: '#/triage', icon: Inbox },
      { route: 'proposals', label: 'Proposals', href: '#/proposals', icon: Lightbulb },
      { route: 'chat', label: 'Chat', href: '#/chat', icon: MessagesSquare },
    ],
  },
  {
    label: 'Activity',
    entries: [
      { route: 'progress', label: 'Progress', href: '#/progress', icon: Workflow },
      { route: 'events', label: 'Events', href: '#/events', icon: Activity },
    ],
  },
  {
    label: 'Insight',
    entries: [
      { route: 'kpi', label: 'KPI', href: '#/kpi', icon: TrendingUp },
      { route: 'studio', label: 'Studio', href: '#/studio', icon: FlaskConical },
      { route: 'reflections', label: 'Reflections', href: '#/reflections', icon: Sparkles },
      { route: 'steward', label: 'Steward', href: '#/steward', icon: ShieldCheck },
    ],
  },
  {
    label: 'Control',
    footer: true,
    entries: [
      {
        route: 'control',
        label: 'Control Room',
        href: '#/control',
        icon: SlidersHorizontal,
      },
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
            const entry = group.entries.find((e) => e.route === route)
            if (entry)
              return [
                { label: group.label, href: null },
                { label: entry.label, href: null },
              ]
          }
          return []
        })()

  return (
    <header className="col-span-2 flex h-12 items-center gap-3 border-b border-border-dark bg-surface-dark pl-4 pr-5">
      {/* Wordmark — the one place the geometric mark is still used, as a mark. */}
      <span className="flex shrink-0 items-center gap-1.5 text-title font-semibold tracking-tight text-accent-on-dark">
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
                  <span className="text-label text-muted-dark/40" aria-hidden="true">
                    /
                  </span>
                )}
                {crumb.href ? (
                  <a
                    href={crumb.href}
                    className="rounded text-label text-muted-dark transition-colors duration-[var(--dur-fast)] hover:text-fg-dark"
                  >
                    {crumb.label}
                  </a>
                ) : i === crumbs.length - 1 ? (
                  // Terminal (active page): brightest on-dark text so it reads as the current location
                  <span className="text-label font-medium text-fg-dark">{crumb.label}</span>
                ) : (
                  // Non-terminal without href (e.g. group label): muted
                  <span className="text-label text-muted-dark">{crumb.label}</span>
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
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-muted-dark/15 px-2.5 py-1 text-micro leading-none text-muted-dark"
          >
            <span className="size-1.5 rounded-full bg-muted-dark" aria-hidden="true" />
            live updates paused
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
}

/** One nav row. Extracted so the scrolling groups and the footer share it exactly. */
const NavItem = ({
  entry,
  isActive,
  badge,
  badgeAriaLabel,
}: {
  entry: NavEntry
  isActive: boolean
  badge?: number
  badgeAriaLabel?: string
}) => {
  const Icon = entry.icon
  return (
    <a
      href={entry.href}
      aria-current={isActive ? 'page' : undefined}
      className={[
        // A filled, rounded, inset row — the Linear/Cursor pattern. The old
        // treatment was a full-bleed row with a 2px right border, which reads
        // as a table selection rather than as a navigation target.
        'group relative mx-2 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-label',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        isActive
          ? 'bg-accent-on-dark/12 font-medium text-accent-on-dark'
          : 'text-muted-dark hover:bg-fg-dark/6 hover:text-fg-dark',
      ].join(' ')}
    >
      {/* Active marker — a short rail inside the pill's left padding. Kept
          inside the row (not bled to the sidebar edge) so it cannot be clipped
          by the nav's overflow context. */}
      {isActive && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1/2 h-3.5 w-0.5 -translate-y-1/2 rounded-r-full bg-accent-on-dark"
        />
      )}
      <Icon
        size={15}
        strokeWidth={isActive ? 2.25 : 1.75}
        className="shrink-0 transition-opacity duration-[var(--dur-fast)]"
        aria-hidden="true"
      />
      <span className="truncate">{entry.label}</span>
      {badge !== undefined && badge > 0 && (
        <span
          aria-label={badgeAriaLabel ?? `${badge > 99 ? '99+' : badge} decisions pending`}
          className="ml-auto min-w-[20px] animate-badge-pulse rounded-full px-1.5 py-0.5 text-center text-micro font-semibold leading-none tabular-nums text-white"
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </a>
  )
}

/**
 * Dark sidebar with three intent-clustered groups and a pinned Control footer.
 *
 * Exported for direct testing with controlled props — the badge count and
 * active route are passed in rather than fetched inside the component, keeping
 * it a pure render function suitable for `renderToStaticMarkup` tests.
 *
 * Active-route rule: an entry is active when entry.route === activeRoute. There
 * are no exceptions and nothing is hidden behind a disclosure, so the active
 * highlight is always on screen.
 */
export const ShellSidebar = ({
  activeRoute,
  decisionBadge,
  badgeAriaLabel,
}: ShellSidebarProps) => {
  const scrolling = SHELL_NAV_GROUPS.filter((g) => g.footer !== true)
  const footer = SHELL_NAV_GROUPS.filter((g) => g.footer === true)

  return (
    <nav
      aria-label="Main navigation"
      className="flex flex-col overflow-y-auto border-r border-border-dark bg-bg-dark pb-3 pt-3"
    >
      <div className="flex-1">
        {scrolling.map((group) => (
          <div key={group.label} className="mb-4 last:mb-0">
            <p className="px-4 pb-1.5 text-micro font-semibold uppercase tracking-[0.09em] text-muted-dark/60">
              {group.label}
            </p>
            <div className="flex flex-col gap-px">
              {group.entries.map((entry) => (
                <NavItem
                  key={entry.label}
                  entry={entry}
                  isActive={entry.route === activeRoute}
                  badge={entry.route === 'triage' ? decisionBadge : undefined}
                  badgeAriaLabel={badgeAriaLabel}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {footer.length > 0 && (
        <div className="mt-4 border-t border-border-dark/70 pt-3">
          {footer.map((group) => (
            <div key={group.label} className="flex flex-col gap-px">
              {group.entries.map((entry) => (
                <NavItem
                  key={entry.label}
                  entry={entry}
                  isActive={entry.route === activeRoute}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </nav>
  )
}

// ── Shell ─────────────────────────────────────────────────────────────────────

interface ShellProps {
  hash: string
  children: ReactNode
}

/**
 * Persistent shell that wraps every page.
 *
 * Renders a CSS grid:
 *   columns  224 px sidebar | 1 fr content
 *   rows     48 px topbar   | 1 fr body
 *
 * The topbar spans both columns (col-span-2). Shell fills the remaining flex
 * height of its parent (flex-1 min-h-0).
 */
export const Shell = ({ hash, children }: ShellProps) => {
  // Badge = the canonical "needs you" count from the unified counts endpoint.
  // This is the single source of truth shared by the sidebar badge, board
  // header, Control Room Now-strip, and chat greeting — all read from
  // useCounts() so no widget recomputes the number independently.
  // Draft proposals are excluded from needsYou server-side (same predicate
  // as viewStatusCounts.needYou and countNeedsYou).
  const { needsYou: decisionBadge } = useCounts()
  const activeRoute = resolvePageRoute(hash)

  const badgeAriaLabel: string | undefined =
    decisionBadge > 0
      ? `${decisionBadge > 99 ? '99+' : decisionBadge} decisions pending`
      : undefined

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[224px_1fr] grid-rows-[48px_1fr]">
      <ShellTopbar hash={hash} />
      <ShellSidebar
        activeRoute={activeRoute}
        decisionBadge={decisionBadge}
        badgeAriaLabel={badgeAriaLabel}
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
