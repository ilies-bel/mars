import { NavBar } from '@/widgets/NavBar'
import { TaskDetailDrawer } from '@/widgets/TaskDetailDrawer'
import { ProposalDetailDrawer } from '@/widgets/ProposalDetailDrawer'
import { useHashRoute } from '@/shared/useHashRoute'
import { detectRoute, parseProposalRoute, parseTaskRoute } from '@/shared/routing'
import { useTodo } from '@/entities/todo/useTodo'
import { AgentsPage } from '@/pages/AgentsPage'
import { ProgressPage } from '@/pages/ProgressPage'
import { ActionQueuePage } from '@/pages/TodoPage'
import { EventsPage } from '@/pages/EventsPage'
import { GraphView } from '@/views/Graph'

const clearTaskHash = (): void => {
  if (typeof window === 'undefined') return
  window.location.hash = '#/progress'
}

const App = () => {
  const hash = useHashRoute()
  const taskId = parseTaskRoute(hash)
  const proposalId = parseProposalRoute(hash)
  // Proposal fields come from the existing `/api/todo` drafts fetch — no new
  // endpoint is introduced for the drawer.
  const { drafts } = useTodo()
  const proposal = proposalId
    ? (drafts.find((d) => d.id === proposalId) ?? null)
    : null
  const overlayOpen =
    (taskId && hash.startsWith('#/task/')) ||
    (proposalId && hash.startsWith('#/proposal/'))
  const route = overlayOpen ? 'progress' : detectRoute(hash)
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg">
      <NavBar hash={hash} />
      <div className="min-h-0 flex-1">
        {route === 'agents' ? (
          <AgentsPage />
        ) : route === 'progress' ? (
          <ProgressPage />
        ) : route === 'events' ? (
          <EventsPage />
        ) : route === 'graph' ? (
          <GraphView />
        ) : (
          <ActionQueuePage />
        )}
      </div>
      {taskId ? (
        <TaskDetailDrawer taskId={taskId} onClose={clearTaskHash} />
      ) : null}
      {proposal ? (
        <ProposalDetailDrawer proposal={proposal} onClose={clearTaskHash} />
      ) : null}
    </div>
  )
}

export default App
