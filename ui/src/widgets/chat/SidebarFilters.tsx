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
        className="w-full border border-primary/30 bg-background px-2 py-1 font-mono text-body text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
      />
      <div className="flex items-center gap-1">
        <select
          aria-label="Filter by thread origin"
          data-testid="sidebar-filter-origin"
          value={value.origin}
          onChange={(e) => onChange({ ...value, origin: e.target.value as 'all' | 'alerts' | 'operator' })}
          className="flex-1 border border-primary/30 bg-background px-1.5 py-0.5 font-mono text-micro text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
        >
          <option value="all">Any origin</option>
          <option value="alerts">Alerts</option>
          <option value="operator">Operator</option>
        </select>
        {canRestart && (
          <button
            type="button"
            data-testid="restart-selected"
            title={restartContext ? `Restart: ${restartContext}` : 'Restart selected thread'}
            className="border border-highlight/50 px-1.5 py-0.5 font-mono text-micro uppercase text-highlight hover:bg-highlight/10"
            onClick={() => onFastAction('restart')}
          >
            Restart selected
          </button>
        )}
      </div>
    </div>
  )
}
