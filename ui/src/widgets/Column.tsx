import type { UITask } from '@/shared/types'
import { TaskCard } from '@/components/TaskCard'

interface Props {
  label: string
  tasks: UITask[]
  startIndex: number
  accent?: 'flame' | 'muted'
}

export const Column = ({ label, tasks, startIndex, accent = 'muted' }: Props) => (
  <section className="flex h-full min-h-0 min-w-0 flex-1 basis-0 flex-col gap-2 rounded-lg border border-border bg-panel p-3">
    <header className="flex items-center justify-between px-1 py-0.5">
      <span
        className={`font-sans text-[11px] font-semibold tracking-[0.1em] ${
          accent === 'flame' ? 'text-flame' : 'text-muted'
        }`}
      >
        {label}
      </span>
      <span className="font-mono text-[11px] font-semibold text-muted">
        {tasks.length}
      </span>
    </header>
    <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
      {tasks.length === 0 ? (
        <div className="px-1 py-2 font-mono text-[11px] text-muted/70">
          empty
        </div>
      ) : (
        tasks.map((t, i) => (
          <TaskCard key={t.id} task={t} index={startIndex + i} />
        ))
      )}
    </div>
  </section>
)
