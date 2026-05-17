import { NavBar } from '@/widgets/NavBar'
import { useHashRoute } from '@/shared/useHashRoute'
import { AgentsPage } from '@/pages/AgentsPage'
import { KanbanPage } from '@/pages/KanbanPage'
import { TodoPage } from '@/pages/TodoPage'

const App = () => {
  const hash = useHashRoute()
  const onKanban = hash.startsWith('#/kanban')
  const onAgents = hash.startsWith('#/agents')
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg">
      <NavBar hash={hash} />
      <div className="min-h-0 flex-1">
        {onAgents ? (
          <AgentsPage />
        ) : onKanban ? (
          <KanbanPage />
        ) : (
          <TodoPage />
        )}
      </div>
    </div>
  )
}

export default App
