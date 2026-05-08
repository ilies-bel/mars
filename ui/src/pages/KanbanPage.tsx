import { useTasks } from '../hooks/useTasks'
import { Column } from '../components/Column'
import { Footer } from '../components/Footer'
import { Sidebar } from '../components/Sidebar'
import { TopStripe } from '../components/TopStripe'

export const KanbanPage = () => {
  const { snapshot, error, connected } = useTasks()
  const cols = snapshot?.columns ?? {
    backlog: [],
    planned: [],
    in_progress: [],
    blocked: [],
    done: [],
    dropped: [],
  }
  const counts = snapshot?.counts ?? { inProgress: 0, todo: 0, done: 0 }
  const totalTasks =
    cols.backlog.length +
    cols.planned.length +
    cols.in_progress.length +
    cols.blocked.length +
    cols.done.length +
    cols.dropped.length

  let cursor = 0
  const startIdx = (n: number) => {
    const v = cursor
    cursor += n
    return v
  }

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
            label="BACKLOG"
            tasks={cols.backlog}
            startIndex={startIdx(cols.backlog.length)}
          />
          <Column
            label="PLANNED"
            tasks={cols.planned}
            startIndex={startIdx(cols.planned.length)}
          />
          <Column
            label="IN PROGRESS"
            accent="flame"
            tasks={cols.in_progress}
            startIndex={startIdx(cols.in_progress.length)}
          />
          <Column
            label="BLOCKED"
            tasks={cols.blocked}
            startIndex={startIdx(cols.blocked.length)}
          />
          <Column
            label="DONE"
            tasks={cols.done}
            startIndex={startIdx(cols.done.length)}
          />
          <Column
            label="DROPPED"
            tasks={cols.dropped}
            startIndex={startIdx(cols.dropped.length)}
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
