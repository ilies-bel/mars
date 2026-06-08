import { NavBar } from '@/widgets/NavBar'
import { TaskDetailDrawer } from '@/widgets/TaskDetailDrawer'
import { ProposalDetailDrawer } from '@/widgets/ProposalDetailDrawer'
import { ProposalNodeDrawer } from '@/widgets/ProposalNodeDrawer'
import { useHashRoute } from '@/shared/useHashRoute'
import {
  parseProposalRoute,
  parseProposalNodeRoute,
  parseTaskOrigin,
  parseTaskRoute,
  resolvePageRoute,
} from '@/shared/routing'
import type { RouteName } from '@/shared/routing'
import { useTodo } from '@/entities/todo/useTodo'
import { useProgress } from '@/hooks/useProgress'
import { FocusedProjectProvider } from '@/shared/useFocusedProject'
import { ProgressPage } from '@/pages/ProgressPage'
import { ActionQueuePage } from '@/pages/ActionQueuePage'
import { EventsPage } from '@/pages/EventsPage'
import { FrameworkUpdateBanner } from '@/components/FrameworkUpdateBanner'

/** Hash bases the drawer returns to, keyed by the origin recorded in the hash. */
const ROUTE_BASE: Record<RouteName, string> = {
  'action-queue': '#/action-queue',
  progress: '#/progress',
  events: '#/events',
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
  // Proposal fields come from the existing `/api/todo` drafts fetch — no new
  // endpoint is introduced for the drawer.
  const { drafts } = useTodo()
  // Graph data for the task drawer's subgraph.  React Query deduplicates this
  // against the identical call inside ProgressPage — no extra network request.
  const { tasks, proposals } = useProgress()
  const proposal = proposalId
    ? (drafts.find((d) => d.id === proposalId) ?? null)
    : null
  const route = resolvePageRoute(hash)
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg">
      <FrameworkUpdateBanner />
      <NavBar hash={hash} />
      <div className="min-h-0 flex-1">
        {route === 'progress' ? (
          <ProgressPage />
        ) : route === 'events' ? (
          <EventsPage />
        ) : (
          <ActionQueuePage />
        )}
      </div>
      {taskId ? (
        <TaskDetailDrawer
          taskId={taskId}
          onClose={() => clearTaskHash(hash)}
          tasks={tasks ?? []}
          proposals={proposals}
        />
      ) : null}
      {proposal ? (
        <ProposalDetailDrawer
          proposal={proposal}
          onClose={() => {
            if (typeof window !== 'undefined') window.location.hash = '#/progress'
          }}
          tasks={tasks ?? []}
        />
      ) : null}
      {proposalNodeId ? (
        <ProposalNodeDrawer
          proposalId={proposalNodeId}
          proposals={proposals}
          tasks={tasks ?? []}
          onClose={() => {
            if (typeof window !== 'undefined') window.location.hash = '#/progress'
          }}
        />
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
