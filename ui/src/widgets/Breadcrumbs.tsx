import {
  parseKpiRoute,
  parsePrimitiveRoute,
  parseProposalRoute,
  parseProposalNodeRoute,
  parseStudioRoute,
  parseTaskRoute,
  parseTaskStep,
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
}

const truncateId = (id: string): string =>
  id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-3)}` : id

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
    const crumbs: Crumb[] = [
      { label: 'Task ' + truncateId(taskId), href: null },
    ]
    if (step) {
      crumbs[0] = { ...crumbs[0], href: `#/task/${encodeURIComponent(taskId)}` }
      crumbs.push({ label: `Step: ${step}`, href: null })
    }
    return crumbs
  }

  const studioTaskId = parseStudioRoute(hash)
  if (studioTaskId) {
    return [
      { label: 'Progress', href: '#/progress' },
      { label: 'Studio: ' + truncateId(studioTaskId), href: null },
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
      className="flex shrink-0 items-center gap-1.5 border-b border-iron/20 bg-panel px-4 py-1"
    >
      {crumbs.map((crumb, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && (
            <span className="text-[10px] text-muted" aria-hidden="true">›</span>
          )}
          {crumb.href ? (
            <a
              href={crumb.href}
              className="font-mono text-[10px] text-muted hover:text-fg"
            >
              {crumb.label}
            </a>
          ) : (
            <span className="font-mono text-[10px] font-semibold text-fg">
              {crumb.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  )
}
