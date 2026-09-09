import { TABS, tabLabel, type Tab } from '@/shared/tabs'

interface TabStripProps {
  active: Tab
  onSelect: (tab: Tab) => void
}

const tabClass = (active: boolean): string =>
  [
    // font-medium unconditionally. Selection used to add it, so the label
    // grew a few px and every sibling tab shifted sideways on click.
    '-mb-px border-b-2 px-2.5 pb-2 pt-1.5 text-label font-medium transition-colors',
    active
      ? 'border-highlight text-foreground'
      : 'border-transparent text-muted-foreground hover:text-foreground',
  ].join(' ')

/**
 * Tab strip rendered above the Progress body. Selecting a tab calls
 * `onSelect` — the strip is a controlled component, parent owns the
 * active tab so it can keep the choice in component state without
 * mutating the URL/hash.
 */
export const TabStrip = ({ active, onSelect }: TabStripProps) => (
  <div
    role="tablist"
    aria-label="Progress views"
    className="flex items-end gap-1 border-b border-border bg-surface px-6"
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
