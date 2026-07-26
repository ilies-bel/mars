/**
 * ActionQueuePage — two-pane action queue browser.
 *
 * Left sidebar: stale-worktree alerts + draft proposals, with All/Alerts/Drafts
 * filter buttons and a search input. Items are filtered with the pure helpers in
 * ActionQueuePageFilters.
 *
 * Right detail pane: renders the selected item's detail, or an empty-state
 * treatment when nothing is selected (or all items are filtered out).
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { Inbox } from 'lucide-react'
import { useStaleWorktrees } from '@/entities/stale-worktrees/useStaleWorktrees'
import { useProposals } from '@/entities/proposals/useProposals'
import {
  filterAlertItems,
  filterProposalItems,
  deriveSelectedKey,
  itemKey,
  type AlertItem,
  type ProposalItem,
  type SidebarItem,
} from './ActionQueuePageFilters'
import type { KindFilter } from '@/widgets/chat/queueThreads'
import { readAqStateFromUrl, writeAqStateToUrl } from '@/shared/actionQueueUrlState'
import { relativeTime } from '@/shared/time'

// ---------------------------------------------------------------------------
// Sidebar row components
// ---------------------------------------------------------------------------

interface AlertRowProps {
  item: AlertItem
  active: boolean
  onSelect: () => void
}

const AlertRow = ({ item, active, onSelect }: AlertRowProps) => (
  <button
    type="button"
    onClick={onSelect}
    data-testid="aq-alert-row"
    className={[
      'w-full px-3 py-2 text-left border-b border-primary/10 transition-colors',
      active ? 'bg-primary/20 text-foreground' : 'text-primary hover:bg-primary/10 hover:text-foreground',
    ].join(' ')}
  >
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-[10px] uppercase text-warn">stale</span>
      <span className="ml-auto font-mono text-[10px] text-muted-foreground">
        {relativeTime(item.worktree.updatedAt)}
      </span>
    </div>
    <p className="mt-0.5 truncate font-mono text-[11px]">
      {item.worktree.prompt || item.id}
    </p>
    <p className="truncate font-mono text-[10px] text-muted-foreground">{item.worktree.status}</p>
  </button>
)

interface ProposalRowProps {
  item: ProposalItem
  active: boolean
  onSelect: () => void
}

const ProposalRow = ({ item, active, onSelect }: ProposalRowProps) => (
  <button
    type="button"
    onClick={onSelect}
    data-testid="aq-proposal-row"
    className={[
      'w-full px-3 py-2 text-left border-b border-primary/10 transition-colors',
      active ? 'bg-primary/20 text-foreground' : 'text-primary hover:bg-primary/10 hover:text-foreground',
    ].join(' ')}
  >
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-[10px] uppercase text-muted-foreground">draft</span>
      <span className="ml-auto font-mono text-[10px] text-muted-foreground">{item.draft.source}</span>
    </div>
    <p className="mt-0.5 truncate font-mono text-[11px]">{item.draft.title || item.id}</p>
  </button>
)

// ---------------------------------------------------------------------------
// Right-pane: empty state
// ---------------------------------------------------------------------------

/**
 * Shown in the right detail pane when no sidebar item is selected, or when the
 * active filter returns an empty list. Replaces the previous bare "Select an
 * item" text with a proper empty-state treatment.
 */
const DetailEmptyState = () => (
  <div
    className="flex h-full flex-col items-center justify-center gap-3"
    data-testid="aq-empty-state"
  >
    <Inbox
      className="text-muted-foreground"
      style={{ width: 56, height: 56, opacity: 0.3 }}
      strokeWidth={1.25}
      aria-hidden="true"
    />
    <p className="font-mono text-[12px] text-muted-foreground">Select an item</p>
    <p className="font-mono text-[11px] text-muted-foreground/50">
      Click a row on the left to view details
    </p>
  </div>
)

// ---------------------------------------------------------------------------
// Right-pane: item detail views
// ---------------------------------------------------------------------------

const AlertDetail = ({ item }: { item: AlertItem }) => (
  <div className="flex h-full flex-col overflow-auto">
    <div className="px-4 pt-4">
      <header
        className="border border-primary/35 bg-card px-4 py-3"
        data-testid="aq-alert-detail"
      >
        <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <span className="uppercase text-warn">Stale worktree</span>
          <span className="ml-auto">{relativeTime(item.worktree.updatedAt)}</span>
        </div>
        <h2 className="mt-2 font-mono text-[14px] text-foreground">
          {item.worktree.prompt || item.id}
        </h2>
      </header>
    </div>
    <dl className="mt-4 flex flex-col gap-3 px-6 font-mono text-[12px]">
      <div>
        <dt className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          Status · Age · Branch
        </dt>
        <dd className="text-foreground">
          {item.worktree.status}
          {' · '}
          {item.worktree.ageHours.toFixed(1)}h
          {' · '}
          {item.worktree.branch ?? '—'}
        </dd>
      </div>
      {item.worktree.error !== null ? (
        <div>
          <dt className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Error</dt>
          <dd className="whitespace-pre-wrap text-error">{item.worktree.error}</dd>
        </div>
      ) : null}
    </dl>
  </div>
)

const ProposalDetail = ({ item }: { item: ProposalItem }) => (
  <div className="flex h-full flex-col overflow-auto">
    <div className="px-4 pt-4">
      <header
        className="border border-primary/35 bg-card px-4 py-3"
        data-testid="aq-proposal-detail"
      >
        <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <span className="uppercase">Draft proposal</span>
          <span className="ml-auto">{item.draft.source}</span>
        </div>
        <h2 className="mt-2 font-mono text-[14px] text-foreground">
          {item.draft.title || item.id}
        </h2>
      </header>
    </div>
    <dl className="mt-4 flex flex-col gap-3 px-6 font-mono text-[12px]">
      {item.draft.problem ? (
        <div>
          <dt className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Problem</dt>
          <dd className="whitespace-pre-wrap text-foreground">{item.draft.problem}</dd>
        </div>
      ) : null}
      {item.draft.solution ? (
        <div>
          <dt className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Solution</dt>
          <dd className="whitespace-pre-wrap text-foreground">{item.draft.solution}</dd>
        </div>
      ) : null}
    </dl>
  </div>
)

// ---------------------------------------------------------------------------
// Page root
// ---------------------------------------------------------------------------

/**
 * Renders the two-pane action-queue browser. State (selected item, kind filter,
 * search query) is synchronised with the URL hash so F5 restores the view.
 */
export const ActionQueuePage = () => {
  const [kindFilter, setKindFilter] = useState<KindFilter>(
    () => readAqStateFromUrl().kind,
  )
  const [query, setQuery] = useState(() => readAqStateFromUrl().q)
  const [selectedKey, setSelectedKey] = useState<string | null>(
    () => readAqStateFromUrl().item,
  )

  // Data sources
  const { staleWorktrees } = useStaleWorktrees()
  const { proposals } = useProposals()

  // Map raw entities to typed sidebar items
  const alertItems = useMemo<AlertItem[]>(
    () => staleWorktrees.map((w) => ({ kind: 'stale' as const, id: w.taskId, worktree: w })),
    [staleWorktrees],
  )
  const proposalItems = useMemo<ProposalItem[]>(
    () => proposals.map((d) => ({ kind: 'draft' as const, id: d.id, draft: d })),
    [proposals],
  )

  // Apply kind filter then text search
  const filteredAlerts = useMemo(
    () =>
      kindFilter === 'drafts' ? [] : filterAlertItems(alertItems, query),
    [alertItems, query, kindFilter],
  )
  const filteredProposals = useMemo(
    () =>
      kindFilter === 'alerts' ? [] : filterProposalItems(proposalItems, query),
    [proposalItems, query, kindFilter],
  )
  const allFiltered = useMemo<SidebarItem[]>(
    () => [...filteredAlerts, ...filteredProposals],
    [filteredAlerts, filteredProposals],
  )

  // Derive the effective selected key (auto-selects first item when current key
  // is filtered out; clears to null when the list is empty).
  const derivedKey = deriveSelectedKey(allFiltered, selectedKey)
  useEffect(() => {
    if (derivedKey !== selectedKey) setSelectedKey(derivedKey)
  }, [derivedKey, selectedKey])

  // Debounced URL write-back — mirrors selection and filter state.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      writeAqStateToUrl({ item: selectedKey, kind: kindFilter, q: query, thread: null, project: null })
    }, 300)
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    }
  }, [selectedKey, kindFilter, query])

  const selectedItem = useMemo(
    () => allFiltered.find((i) => itemKey(i) === derivedKey) ?? null,
    [allFiltered, derivedKey],
  )

  const handleSelect = useCallback((key: string) => {
    setSelectedKey(key)
  }, [])

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left sidebar ──────────────────────────────────────────────── */}
      <aside className="flex w-72 flex-shrink-0 flex-col border-r border-primary/30 bg-background">
        {/* Kind filter pills */}
        <div className="flex gap-1 border-b border-primary/30 px-2 py-2">
          {(['all', 'alerts', 'drafts'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setKindFilter(f)}
              className={[
                'flex-1 py-1 font-mono text-[10px] uppercase tracking-wide transition-colors',
                kindFilter === f
                  ? 'bg-primary/20 text-foreground'
                  : 'text-muted-foreground hover:bg-primary/10 hover:text-foreground',
              ].join(' ')}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Search input */}
        <div className="border-b border-primary/30 px-2 py-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            aria-label="Search action queue"
            data-testid="aq-search"
            className="w-full border border-primary/30 bg-background px-2 py-1 font-mono text-[12px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>

        {/* Item list */}
        <div className="flex-1 overflow-y-auto">
          {allFiltered.length === 0 && (
            <p className="px-3 py-4 font-mono text-[10px] text-muted-foreground">
              {query.trim() ? 'No matches' : 'Nothing here'}
            </p>
          )}
          {filteredAlerts.map((item) => (
            <AlertRow
              key={itemKey(item)}
              item={item}
              active={itemKey(item) === derivedKey}
              onSelect={() => handleSelect(itemKey(item))}
            />
          ))}
          {filteredProposals.map((item) => (
            <ProposalRow
              key={itemKey(item)}
              item={item}
              active={itemKey(item) === derivedKey}
              onSelect={() => handleSelect(itemKey(item))}
            />
          ))}
        </div>
      </aside>

      {/* ── Right detail pane ─────────────────────────────────────────── */}
      <main className="min-w-0 flex-1 overflow-hidden">
        {selectedItem === null ? (
          <DetailEmptyState />
        ) : selectedItem.kind === 'stale' ? (
          <AlertDetail item={selectedItem} />
        ) : (
          <ProposalDetail item={selectedItem} />
        )}
      </main>
    </div>
  )
}

export default ActionQueuePage
