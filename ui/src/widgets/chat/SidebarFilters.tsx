import {
  filterByQuery,
  subtitleFor,
  whyNowText,
} from '@/pages/ActionQueuePageFilters'
import type { ActionQueueItem } from '@/shared/schemas'
import type { ThreadListFilters } from './queueThreads'

export interface SidebarFiltersValue extends ThreadListFilters {
  selectedItem: ActionQueueItem | null
}

interface SidebarFiltersProps {
  value: SidebarFiltersValue
  onChange: (value: SidebarFiltersValue) => void
  onFastAction: (action: 'restart') => void
}

/**
 * Controls shared by the chat thread list. Alert-origin threads retain the
 * queue's search and scope vocabulary without bringing back a second page.
 */
export const SidebarFilters = ({ value, onChange, onFastAction }: SidebarFiltersProps) => {
  const selected = value.selectedItem
  const restartContext = selected === null
    ? null
    : filterByQuery(
      [selected],
      value.query,
      (item) => `${item.title}\n${subtitleFor(item)}\n${whyNowText(item) ?? ''}`,
    ).map((item) => whyNowText(item) ?? subtitleFor(item))[0] ?? subtitleFor(selected)
  const canRestart = selected?.actions.some((action) => action.op === 'restart')

  return (
    <div className="space-y-2 border-b border-primary/30 px-2 py-2">
      <input
        type="search"
        value={value.query}
        onChange={(event) => onChange({ ...value, query: event.target.value })}
        placeholder="Search open threads…"
        aria-label="Search threads"
        data-testid="thread-search"
        className="w-full border border-primary/30 bg-background px-2 py-1 font-mono text-[12px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
      />
      <div className="flex flex-wrap gap-1" aria-label="Filter by failure kind">
        {([
          ['all', 'All'],
          ['failed-task', 'Failures'],
          ['draft-proposal', 'Drafts'],
        ] as const).map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            data-testid={`sidebar-filter-${kind}`}
            aria-pressed={value.kind === kind}
            className={`border px-1.5 py-0.5 font-mono text-[10px] uppercase ${value.kind === kind ? 'border-primary/70 bg-primary/15 text-foreground' : 'border-primary/25 text-primary hover:bg-primary/10'}`}
            onClick={() => onChange({ ...value, kind })}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1" aria-label="Filter by thread origin">
        {([
          ['all', 'Any origin'],
          ['alerts', 'Alerts'],
          ['operator', 'Operator'],
        ] as const).map(([origin, label]) => (
          <button
            key={origin}
            type="button"
            data-testid={`sidebar-filter-${origin}`}
            aria-pressed={value.origin === origin}
            className={`border px-1.5 py-0.5 font-mono text-[10px] uppercase ${value.origin === origin ? 'border-primary/70 bg-primary/15 text-foreground' : 'border-primary/25 text-primary hover:bg-primary/10'}`}
            onClick={() => onChange({ ...value, origin })}
          >
            {label}
          </button>
        ))}
        {canRestart && (
          <button
            type="button"
            data-testid="restart-selected"
            title={restartContext ? `Restart: ${restartContext}` : 'Restart selected thread'}
            className="ml-auto border border-highlight/50 px-1.5 py-0.5 font-mono text-[10px] uppercase text-highlight hover:bg-highlight/10"
            onClick={() => onFastAction('restart')}
          >
            Restart selected
          </button>
        )}
      </div>
    </div>
  )
}
