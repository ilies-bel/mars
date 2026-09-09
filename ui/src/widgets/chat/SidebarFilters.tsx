import { SelectField } from '@/components/SelectField'
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
    <div className="space-y-2 border-b border-border px-2 py-2">
      <input
        type="search"
        value={value.query}
        onChange={(event) => onChange({ ...value, query: event.target.value })}
        placeholder="Search open threads…"
        aria-label="Search threads"
        data-testid="thread-search"
        className="h-7 w-full rounded-md border border-border bg-background px-2.5 text-label text-foreground shadow-[var(--shadow-e1)] transition-[border-color,box-shadow] duration-[var(--dur-fast)] placeholder:text-muted-foreground focus:border-highlight/50"
      />
      <div className="flex items-center gap-1">
        <SelectField
          aria-label="Filter by thread origin"
          data-testid="sidebar-filter-origin"
          value={value.origin}
          onChange={(e) => onChange({ ...value, origin: e.target.value as 'all' | 'alerts' | 'operator' })}
          className="flex-1"
        >
          <option value="all">Any origin</option>
          <option value="alerts">Alerts</option>
          <option value="operator">Operator</option>
        </SelectField>
        {canRestart && (
          <button
            type="button"
            data-testid="restart-selected"
            title={restartContext ? `Restart: ${restartContext}` : 'Restart selected thread'}
            className="rounded-md border border-highlight/40 px-2 py-1 text-micro font-medium text-highlight transition-colors duration-[var(--dur-fast)] hover:bg-highlight/10"
            onClick={() => onFastAction('restart')}
          >
            Restart selected
          </button>
        )}
      </div>
    </div>
  )
}
