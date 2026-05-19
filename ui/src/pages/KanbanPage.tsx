import { useTasks } from '@/hooks/useTasks'
import { Column } from '@/widgets/Column'
import { Footer } from '@/widgets/Footer'
import { Sidebar } from '@/widgets/Sidebar'
import { TopStripe } from '@/widgets/TopStripe'

export const KanbanPage = () => {
  const { snapshot, error, connected } = useTasks()
  const cols = snapshot?.columns ?? {
    backlog: [],
    in_progress: [],
    done: [],
  }
  const counts = snapshot?.counts ?? { inProgress: 0, todo: 0, done: 0 }
  const totalTasks =
    cols.backlog.length + cols.in_progress.length + cols.done.length

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg">
      <Sidebar
        tasksCount={totalTasks}
        triageCount={cols.backlog.length}
        connected={connected}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopStripe
          inProgress={counts.inProgress}
          todo={counts.todo}
          done={counts.done}
          connected={connected}
        />
        <main className="flex min-h-0 flex-1 gap-3 overflow-hidden bg-bg p-4">
          <Column
            label="IN PROGRESS"
            accent="flame"
            tasks={cols.in_progress}
            startIndex={0}
          />
        </main>
        {error ? (
          <div className="border-t border-iron/40 bg-iron/10 px-6 py-1.5 font-mono text-[11px] text-iron">
            {error}
          </div>
        ) : null}
        <Footer />
      </div>
    </div>
  )
}
