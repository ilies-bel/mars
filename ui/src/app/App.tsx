import { NavBar } from '@/widgets/NavBar'
import { TaskDetailDrawer } from '@/widgets/TaskDetailDrawer'
import { ProposalDetailDrawer } from '@/widgets/ProposalDetailDrawer'
import { useHashRoute } from '@/shared/useHashRoute'
import { parseProposalRoute, parseTaskRoute, resolvePageRoute } from '@/shared/routing'
import { useTodo } from '@/entities/todo/useTodo'
import { useProgress } from '@/hooks/useProgress'
import { AgentsPage } from '@/pages/AgentsPage'
import { ProgressPage } from '@/pages/ProgressPage'
import { ActionQueuePage } from '@/pages/TodoPage'
import { EventsPage } from '@/pages/EventsPage'

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
  // Graph data for the task drawer's subgraph.  React Query deduplicates this
  // against the identical call inside ProgressPage — no extra network request.
  const { tasks, proposals } = useProgress()
  const proposal = proposalId
    ? (drafts.find((d) => d.id === proposalId) ?? null)
    : null
  const route = resolvePageRoute(hash)
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
        ) : (
          <ActionQueuePage />
        )}
      </div>
      {taskId ? (
        <TaskDetailDrawer
          taskId={taskId}
          onClose={clearTaskHash}
          tasks={tasks ?? []}
          proposals={proposals}
        />
      ) : null}
      {proposal ? (
        <ProposalDetailDrawer proposal={proposal} onClose={clearTaskHash} tasks={tasks ?? []} />
      ) : null}
    </div>
  )
}

export default App
