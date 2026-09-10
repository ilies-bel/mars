import type { RouteName } from '@/shared/routing'
import {
  parseKpiRoute,
  parseTaskOrigin,
  parsePrimitiveRoute,
  parseProposalRoute,
  parseProposalNodeRoute,
  parseStudioRoute,
  parseTaskRoute,
  parseTaskStep,
  taskHash,
} from '@/shared/routing'
import type { KpiKey } from '@/shared/schemas'

interface Crumb {
  label: string
  href: string | null
}

const KPI_LABELS: Record<KpiKey, string> = {
  cost_per_arc: 'Cost per Arc',
  failure_rate: 'Failure Rate',
  autonomous_completion_rate: 'Autonomous Completion',
  recovery_success_rate: 'Recovery Success',
  'cost-per-merged-task': 'Cost / merged task',
}

/**
 * Shorten an id for the breadcrumb.
 *
 * The threshold is 20, not 12, because a task id is `mars-` + 8 hex = 13
 * characters: at 12 it elided a single character and produced `mars-c7f…ce6`,
 * which costs the reader more than the character it saved. Only genuinely long
 * ids — `<8hex>-<slug>` idea ids and composed recovery ids — get elided.
 */
const truncateId = (id: string): string =>
  id.length > 20 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id

/**
 * Where a task overlay was opened FROM, as a crumb.
 *
 * The trail replaced the page you were on instead of appending to it: opening
 * a task from Needs You showed "Task mars-…" alone, so the one control whose
 * whole job is to say where you are said nothing about where you came from,
 * and the way back was the browser button. The route already carries the
 * origin in `?from=` — the drawer uses it to decide where to return on close —
 * so the trail can simply say the same thing.
 */
const ORIGIN_CRUMBS: Record<RouteName, Crumb> = {
  triage: { label: 'Needs You', href: '#/triage' },
  proposals: { label: 'Drafts', href: '#/proposals' },
  chat: { label: 'Chat', href: '#/chat' },
  progress: { label: 'Progress', href: '#/progress' },
  events: { label: 'Events', href: '#/events' },
  kpi: { label: 'KPI', href: '#/kpi' },
  studio: { label: 'Scores', href: '#/studio' },
  reflections: { label: 'Reflections', href: '#/reflections' },
  control: { label: 'Control Room', href: '#/control' },
  steward: { label: 'Steward', href: '#/steward' },
  'arc-qa': { label: 'Arc QA', href: null },
}

export function deriveBreadcrumbs(hash: string): Crumb[] {
  const kpiKey = parseKpiRoute(hash)
  if (kpiKey) {
    return [
      { label: 'Events', href: '#/events' },
      { label: KPI_LABELS[kpiKey], href: null },
    ]
  }

  const taskId = parseTaskRoute(hash)
  if (taskId) {
    const step = parseTaskStep(hash)
    const origin = parseTaskOrigin(hash)
    const crumbs: Crumb[] = []
    if (origin !== null) crumbs.push(ORIGIN_CRUMBS[origin])
    crumbs.push({ label: 'Task ' + truncateId(taskId), href: null })
    if (step) {
      const last = crumbs.length - 1
      crumbs[last] = { ...crumbs[last]!, href: taskHash(taskId) }
      crumbs.push({ label: `Step: ${step}`, href: null })
    }
    return crumbs
  }

  const studioTaskId = parseStudioRoute(hash)
  if (studioTaskId) {
    // The nav calls this section "Scores"; the trail used to call it "Studio"
    // and to parent it under Progress, which it has never been a child of.
    // Three names for one place is two too many.
    return [
      { label: 'Scores', href: '#/studio' },
      { label: truncateId(studioTaskId), href: null },
    ]
  }

  const proposalId = parseProposalRoute(hash)
  if (proposalId) {
    return [{ label: 'Proposal ' + truncateId(proposalId), href: null }]
  }

  const proposalNodeId = parseProposalNodeRoute(hash)
  if (proposalNodeId) {
    return [{ label: 'Proposal ' + truncateId(proposalNodeId), href: null }]
  }

  const primitiveName = parsePrimitiveRoute(hash)
  if (primitiveName) {
    return [{ label: primitiveName, href: null }]
  }

  return []
}

interface BreadcrumbsProps {
  hash: string
}

export const Breadcrumbs = ({ hash }: BreadcrumbsProps) => {
  const crumbs = deriveBreadcrumbs(hash)
  if (crumbs.length === 0) return null

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex shrink-0 items-center gap-1.5 border-b border-border bg-secondary px-4 py-1"
    >
      {crumbs.map((crumb, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && (
            <span className="text-micro text-muted-foreground" aria-hidden="true">›</span>
          )}
          {crumb.href ? (
            <a
              href={crumb.href}
              className="font-mono text-micro text-muted-foreground hover:text-foreground"
            >
              {crumb.label}
            </a>
          ) : (
            <span className="font-mono text-micro font-semibold text-foreground">
              {crumb.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  )
}
