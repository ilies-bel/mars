import { NavBar } from './components/NavBar'
import { useHashRoute } from './hooks/useHashRoute'
import { KanbanPage } from './pages/KanbanPage'
import { TodoPage } from './pages/TodoPage'

export const App = () => {
  const hash = useHashRoute()
  const onKanban = hash.startsWith('#/kanban')
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg">
      <NavBar hash={hash} />
      <div className="min-h-0 flex-1">
        {onKanban ? <KanbanPage /> : <TodoPage />}
      </div>
    </div>
  )
}
