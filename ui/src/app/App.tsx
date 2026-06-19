import { NavBar } from '@/widgets/NavBar'
import { TaskDetailDrawer } from '@/widgets/TaskDetailDrawer'
import { ProposalDetailDrawer } from '@/widgets/ProposalDetailDrawer'
import { ProposalNodeDrawer } from '@/widgets/ProposalNodeDrawer'
import { ReleaseNotesModal } from '@/widgets/ReleaseNotesModal'
import { useHashRoute } from '@/shared/useHashRoute'
import {
  parseKpiRoute,
  parseProposalRoute,
  parseProposalNodeRoute,
  parseReleaseNotesRoute,
  parseTaskOrigin,
  parseTaskRoute,
  parseTaskStep,
  resolvePageRoute,
} from '@/shared/routing'
import type { RouteName } from '@/shared/routing'
import { useProposals } from '@/entities/proposals/useProposals'
import { useProgress } from '@/hooks/useProgress'
import { FocusedProjectProvider, useFocusedProjectId } from '@/shared/useFocusedProject'
import { useReleaseNotesAutoOpen } from '@/shared/useReleaseNotesAutoOpen'
import { ProgressPage } from '@/pages/ProgressPage'
import { ActionQueuePage } from '@/pages/ActionQueuePage'
import { EventsPage } from '@/pages/EventsPage'
import { KpiDetailPage } from '@/pages/KpiDetailPage'
import { FrameworkUpdateBanner } from '@/components/FrameworkUpdateBanner'
import { FallbackBoundary } from '@/components/FallbackBoundary'
import { AlertNotifier } from '@/shared/notifications/alertNotifier'

/** Hash bases the drawer returns to, keyed by the origin recorded in the hash. */
const ROUTE_BASE: Record<RouteName, string> = {
  'action-queue': '#/action-queue',
  progress: '#/progress',
  events: '#/events',
  kpi: '#/events',
}

/**
 * Closes a drawer opened from `closeHash` by returning to its origin page.
 * A `#/task/<id>?from=<route>` hash returns to `<route>`; a plain task hash
 * (or any hash with no recorded origin) returns to Progress — today's default.
 */
const clearTaskHash = (closeHash: string): void => {
  if (typeof window === 'undefined') return
  const origin = parseTaskOrigin(closeHash)
  window.location.hash = origin ? ROUTE_BASE[origin] : '#/progress'
}

const AppInner = () => {
  const hash = useHashRoute()
  const taskId = parseTaskRoute(hash)
  const proposalId = parseProposalRoute(hash)
  const proposalNodeId = parseProposalNodeRoute(hash)
  const showReleaseNotes = parseReleaseNotesRoute(hash)
  const kpiKey = parseKpiRoute(hash)
  const activeStepName = parseTaskStep(hash) ?? undefined

  // Auto-open the Release Notes drawer when arcs have landed since the user
  // last viewed them. Re-runs whenever the focused project changes.
  const projectId = useFocusedProjectId()
  useReleaseNotesAutoOpen(projectId)
  // Proposal fields come from the `/api/proposals` fetch — no new
  // endpoint is introduced for the drawer.
  const { proposals: drafts } = useProposals()
  // Graph data for the task drawer's subgraph.  React Query deduplicates this
  // against the identical call inside ProgressPage — no extra network request.
  const { tasks, proposals } = useProgress()
  const proposal = proposalId
    ? (drafts.find((d) => d.id === proposalId) ?? null)
    : null
  const route = resolvePageRoute(hash)
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg">
      <AlertNotifier />
      <FrameworkUpdateBanner />
      <NavBar hash={hash} />
      <div className="min-h-0 flex-1">
        <FallbackBoundary of="this view" variant="pane">
          {route === 'kpi' && kpiKey !== null ? (
            <KpiDetailPage kpiKey={kpiKey} />
          ) : route === 'progress' ? (
            <ProgressPage />
          ) : route === 'events' ? (
            <EventsPage />
          ) : (
            <ActionQueuePage />
          )}
        </FallbackBoundary>
      </div>
      {taskId ? (
        <FallbackBoundary of="task detail" variant="inline">
          <TaskDetailDrawer
            taskId={taskId}
            onClose={() => clearTaskHash(hash)}
            tasks={tasks ?? []}
            proposals={proposals}
            activeStepName={activeStepName}
            projectId={projectId ?? undefined}
          />
        </FallbackBoundary>
      ) : null}
      {proposal ? (
        <FallbackBoundary of="proposal detail" variant="inline">
          <ProposalDetailDrawer
            proposal={proposal}
            onClose={() => {
              if (typeof window !== 'undefined') window.location.hash = '#/progress'
            }}
            tasks={tasks ?? []}
          />
        </FallbackBoundary>
      ) : null}
      {proposalNodeId ? (
        <FallbackBoundary of="proposal" variant="inline">
          <ProposalNodeDrawer
            proposalId={proposalNodeId}
            proposals={proposals}
            tasks={tasks ?? []}
            onClose={() => {
              if (typeof window !== 'undefined') window.location.hash = '#/progress'
            }}
          />
        </FallbackBoundary>
      ) : null}
      {showReleaseNotes ? (
        <FallbackBoundary of="release notes" variant="inline">
          <ReleaseNotesModal
            onClose={() => {
              if (typeof window !== 'undefined') window.location.hash = '#/progress'
            }}
          />
        </FallbackBoundary>
      ) : null}
    </div>
  )
}

const App = () => (
  <FocusedProjectProvider>
    <AppInner />
  </FocusedProjectProvider>
)

export default App
