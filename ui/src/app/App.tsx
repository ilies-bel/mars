import { NavBar } from '@/widgets/NavBar'
import { useHashRoute } from '@/shared/useHashRoute'
import { detectRoute } from '@/shared/routing'
import { AgentsPage } from '@/pages/AgentsPage'
import { KanbanPage } from '@/pages/KanbanPage'
import { ActionQueuePage } from '@/pages/TodoPage'
import { ProposalsPage } from '@/pages/ProposalsPage'

const App = () => {
  const hash = useHashRoute()
  const route = detectRoute(hash)
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg">
      <NavBar hash={hash} />
      <div className="min-h-0 flex-1">
        {route === 'agents' ? (
          <AgentsPage />
        ) : route === 'kanban' ? (
          <KanbanPage />
        ) : route === 'proposals' ? (
          <ProposalsPage />
        ) : (
          <ActionQueuePage />
        )}
      </div>
    </div>
  )
}

export default App
