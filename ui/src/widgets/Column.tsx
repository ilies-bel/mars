import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { UITask } from '@/shared/types'
import { TaskCard } from '@/components/TaskCard'

interface Props {
  label: string
  tasks: UITask[]
  startIndex: number
  accent?: 'flame' | 'muted'
}

export const Column = ({ label, tasks, startIndex, accent = 'muted' }: Props) => {
  const scrollRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 140,
    overscan: 3,
    // initialRect ensures items render during SSR (renderToStaticMarkup in tests)
    // where scrollRef.current is null and no ResizeObserver fires.
    initialRect: { width: 0, height: 4000 },
  })

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-2 rounded-lg border border-border bg-panel p-3">
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
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {tasks.length === 0 ? (
          <div className="px-1 py-2 font-mono text-[11px] text-muted/70">
            empty
          </div>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((vItem) => (
              <div
                key={vItem.key}
                data-index={vItem.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vItem.start}px)`,
                  // replicate the original gap-2 (8px) between cards
                  paddingBottom: vItem.index < tasks.length - 1 ? '8px' : 0,
                }}
              >
                <TaskCard
                  task={tasks[vItem.index]}
                  index={startIndex + vItem.index}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
