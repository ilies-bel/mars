import { TABS, tabLabel, type Tab } from '@/shared/tabs'

interface TabStripProps {
  active: Tab
  onSelect: (tab: Tab) => void
}

const tabClass = (active: boolean): string =>
  [
    'rounded px-2 py-1 font-mono text-[11px] uppercase tracking-wide transition-colors',
    active ? 'bg-iron/30 text-fg' : 'text-iron hover:text-fg',
  ].join(' ')

/**
 * Tab strip rendered above the Kanban body. Selecting a tab calls
 * `onSelect` — the strip is a controlled component, parent owns the
 * active tab so it can keep the choice in component state without
 * mutating the URL/hash.
 */
export const TabStrip = ({ active, onSelect }: TabStripProps) => (
  <div
    role="tablist"
    aria-label="Kanban views"
    className="flex items-center gap-2 border-b border-iron/30 bg-bg px-4 py-1.5"
  >
    {TABS.map((tab) => {
      const isActive = tab === active
      return (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={isActive}
          data-testid={`tab-${tab}`}
          className={tabClass(isActive)}
          onClick={() => onSelect(tab)}
        >
          {tabLabel(tab)}
        </button>
      )
    })}
  </div>
)
