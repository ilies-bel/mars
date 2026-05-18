import { NavBar } from '@/widgets/NavBar'
import { TaskDetailDrawer } from '@/widgets/TaskDetailDrawer'
import { useHashRoute } from '@/shared/useHashRoute'
import { detectRoute, parseTaskRoute } from '@/shared/routing'
import { AgentsPage } from '@/pages/AgentsPage'
import { KanbanPage } from '@/pages/KanbanPage'
import { ActionQueuePage } from '@/pages/TodoPage'

const clearTaskHash = (): void => {
  if (typeof window === 'undefined') return
  // Closing the drawer must return the operator to the Kanban — the only
  // origin that opens a task drawer in this slice.
  window.location.hash = '#/kanban'
}

const App = () => {
  const hash = useHashRoute()
  const taskId = parseTaskRoute(hash)
  // A bare `#/task/<id>` overlays the Kanban (entry point from a TaskCard,
  // or a pasted URL). Any other explicit route is honoured behind the drawer.
  const route = taskId && hash.startsWith('#/task/') ? 'kanban' : detectRoute(hash)
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg">
      <NavBar hash={hash} />
      <div className="min-h-0 flex-1">
        {route === 'agents' ? (
          <AgentsPage />
        ) : route === 'kanban' ? (
          <KanbanPage />
        ) : (
          <ActionQueuePage />
        )}
      </div>
      {taskId ? (
        <TaskDetailDrawer taskId={taskId} onClose={clearTaskHash} />
      ) : null}
    </div>
  )
}

export default App
