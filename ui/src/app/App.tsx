import { NavBar } from '@/widgets/NavBar'
import { TaskDetailDrawer } from '@/widgets/TaskDetailDrawer'
import { useHashRoute } from '@/shared/useHashRoute'
import { detectRoute, parseTaskRoute } from '@/shared/routing'
import { AgentsPage } from '@/pages/AgentsPage'
import { ProgressPage } from '@/pages/ProgressPage'
import { ActionQueuePage } from '@/pages/TodoPage'

const clearTaskHash = (): void => {
  if (typeof window === 'undefined') return
  window.location.hash = '#/progress'
}

const App = () => {
  const hash = useHashRoute()
  const taskId = parseTaskRoute(hash)
  const route = taskId && hash.startsWith('#/task/') ? 'progress' : detectRoute(hash)
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg">
      <NavBar hash={hash} />
      <div className="min-h-0 flex-1">
        {route === 'agents' ? (
          <AgentsPage />
        ) : route === 'progress' ? (
          <ProgressPage />
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
