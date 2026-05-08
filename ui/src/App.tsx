import { NavBar } from './components/NavBar'
import { useHashRoute } from './hooks/useHashRoute'
import { KanbanPage } from './pages/KanbanPage'
import { QuestionsPage } from './pages/QuestionsPage'

export const App = () => {
  const hash = useHashRoute()
  const onQuestions = hash.startsWith('#/questions')
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg">
      <NavBar hash={hash} />
      <div className="min-h-0 flex-1">
        {onQuestions ? <QuestionsPage /> : <KanbanPage />}
      </div>
    </div>
  )
}
