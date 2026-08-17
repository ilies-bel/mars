import { useEffect, useMemo, useRef, useState } from 'react'
import { FallbackSurface } from '@/components/FallbackSurface'
import { useProgress } from '@/hooks/useProgress'
import { useStatusCounts } from '@/hooks/useStatusCounts'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import {
  readExplicitViewFromUrl,
  readProgressStateFromUrl,
  writeProgressStateToUrl,
} from '@/shared/progressUrlState'
import type { Tab } from '@/shared/tabs'
import { DEFAULT_TAB } from '@/shared/tabs'
import { readPersistedView, writePersistedView } from '@/shared/viewPreference'
import { BoardView } from '@/widgets/BoardView'
import { Footer } from '@/widgets/Footer'
import { TabStrip } from '@/widgets/TabStrip'
import { sanitizeProposalTitle } from '@/widgets/topologyFlowModel'
import { TopologyView } from '@/widgets/TopologyView'
import { TopStripe } from '@/widgets/TopStripe'

// ---------------------------------------------------------------------------
// Terminal task statuses — proposals whose only tasks are all terminal are
// considered "finished arcs" and hidden from the combobox by default.
// ---------------------------------------------------------------------------
const TERMINAL_TASK_STATUSES = new Set<string>(['done', 'dropped'])

// ---------------------------------------------------------------------------
// ProposalCombobox — searchable typeahead that replaces the native <select>.
//
// Active-arc behaviour: only proposals that have at least one non-terminal
// task appear in the list by default.  A "N finished arcs" affordance lets
// the user expand to the full set.  When a proposal is selected the control
// collapses to a dismissible chip; clicking × clears the filter.
// ---------------------------------------------------------------------------

interface ProposalComboboxProps {
  proposals: ProgressProposalNode[]
  tasks: ProgressTask[] | null
  selectedProposalId: string | null
  onSelect: (id: string | null) => void
}

function ProposalCombobox({ proposals, tasks, selectedProposalId, onSelect }: ProposalComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [includeFinished, setIncludeFinished] = useState(false)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (blurTimer.current !== null) clearTimeout(blurTimer.current)
    },
    [],
  )

  const isLoading = tasks === null

  // Proposals that have at least one non-terminal task in the current view.
  const activeProposalIds = useMemo(() => {
    const ids = new Set<string>()
    for (const t of tasks ?? []) {
      if (t.parentProposalId && !TERMINAL_TASK_STATUSES.has(t.status)) {
        ids.add(t.parentProposalId)
      }
    }
    return ids
  }, [tasks])

  const activeProposals = proposals.filter((p) => activeProposalIds.has(p.id))
  const finishedProposals = proposals.filter((p) => !activeProposalIds.has(p.id))

  const visibleProposals = includeFinished ? proposals : activeProposals
  const filteredProposals = query.trim()
    ? visibleProposals.filter((p) =>
        p.title.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : visibleProposals

  const selectedProposal = proposals.find((p) => p.id === selectedProposalId) ?? null

  // ── Chip mode: a proposal is selected ────────────────────────────────────
  if (selectedProposal) {
    return (
      <div
        className="flex items-center gap-2 border-b border-border px-4 py-1.5"
        data-testid="proposal-filter"
      >
        <span className="shrink-0 font-mono text-label text-muted-foreground">Proposal</span>
        <div
          className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 font-mono text-label text-foreground"
          data-testid="proposal-filter-chip"
        >
          <span className="max-w-[320px] truncate">{selectedProposal.title}</span>
          <button
            onClick={() => onSelect(null)}
            aria-label="Clear proposal filter"
            className="ml-0.5 leading-none text-muted-foreground hover:text-foreground"
            data-testid="proposal-filter-chip-clear"
          >
            ×
          </button>
        </div>
      </div>
    )
  }

  // ── Hidden: data settled, no active proposals ─────────────────────────────
  if (!isLoading && activeProposals.length === 0) return null

  // ── Combobox mode ─────────────────────────────────────────────────────────
  return (
    <div
      className="relative flex items-center gap-2 border-b border-border px-4 py-1.5"
      data-testid="proposal-filter"
    >
      <span className="shrink-0 font-mono text-label text-muted-foreground">Proposal</span>
      <input
        type="text"
        data-testid="proposal-filter-input"
        aria-label="Search proposals"
        placeholder="Search proposals…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 150)
        }}
        disabled={isLoading}
        className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-0.5 font-mono text-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-border disabled:opacity-50"
      />
      {/*
       * The options list is always in the DOM (hidden attribute, not unmounted)
       * so that SSR-based tests can locate proposal titles in the HTML string.
       */}
      <ul
        hidden={!open}
        data-testid="proposal-filter-options"
        className="absolute left-0 top-full z-50 mt-px max-h-60 w-full overflow-auto rounded border border-border bg-card py-1 shadow-md"
      >
        {filteredProposals.map((p) => (
          <li key={p.id}>
            <button
              onMouseDown={(e) => {
                e.preventDefault()
                if (blurTimer.current !== null) clearTimeout(blurTimer.current)
                onSelect(p.id)
                setOpen(false)
                setQuery('')
              }}
              className="w-full px-3 py-1.5 text-left font-mono text-label text-foreground hover:bg-muted/50"
            >
              {sanitizeProposalTitle(p.title)}
            </button>
          </li>
        ))}
        {filteredProposals.length === 0 && !isLoading && (
          <li className="px-3 py-1.5 font-mono text-label text-muted-foreground">
            No proposals match
          </li>
        )}
        {finishedProposals.length > 0 && !includeFinished && (
          <li>
            <button
              onMouseDown={(e) => {
                e.preventDefault()
                if (blurTimer.current !== null) clearTimeout(blurTimer.current)
                setIncludeFinished(true)
              }}
              className="w-full border-t border-border px-3 py-1.5 text-left font-mono text-label text-muted-foreground hover:bg-muted/50"
              data-testid="proposal-filter-include-finished"
            >
              + {finishedProposals.length} finished arc
              {finishedProposals.length !== 1 ? 's' : ''}
            </button>
          </li>
        )}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ProgressPage
// ---------------------------------------------------------------------------

export const ProgressPage = () => {
  // Initialise query and proposal filter dimensions from the URL on first render.
  // readProgressStateFromUrl() returns defaults in non-browser environments.
  const [initialUrlState] = useState(() => readProgressStateFromUrl())

  const { byCluster, tasks, proposals, error, connected } = useProgress()
  const { running: inProgressFromCounts, failed: failedCount, doneToday } = useStatusCounts()

  // Resolve the initial active tab with the following precedence:
  //   1. Explicit ?view= param in the URL (shareable links are always honoured)
  //      — also includes col=proposals (sidebar shortcut → board view)
  //   2. Last persisted view from localStorage (remembered across sessions)
  //   3. DEFAULT_TAB ('topology') as the final fallback
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const explicit = readExplicitViewFromUrl()
    if (explicit !== null) return explicit
    return readPersistedView() ?? DEFAULT_TAB
  })

  // col=proposals: tracks whether the Proposals sidebar shortcut is the
  // current navigation origin. Preserved in the URL so the sidebar Proposals
  // entry stays highlighted. Cleared when the user explicitly switches tabs.
  const [colMode, setColMode] = useState<'proposals' | null>(() => initialUrlState.col)

  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(
    initialUrlState.proposal,
  )
  const [searchQuery, setSearchQuery] = useState<string>(initialUrlState.query)

  // Validate the selected proposal id against the proposals that are currently
  // known. If data has settled (tasks !== null) and the stored id is not a
  // known proposal id, treat it as null (reset to "All"). This handles stale
  // ?proposal=<task-id> URLs (e.g. from origin-arc clicks before the fix) and
  // links to fully-completed or deleted proposals without producing a
  // permanently blank board.
  const effectiveProposalId = useMemo((): string | null => {
    if (selectedProposalId === null || tasks === null) return selectedProposalId
    return proposals.some((p) => p.id === selectedProposalId) ? selectedProposalId : null
  }, [selectedProposalId, tasks, proposals])

  // Sync state after the effective id diverges so the URL and dropdown also
  // clear (avoids a stale value lingering in the hash after a reload).
  useEffect(() => {
    if (effectiveProposalId !== selectedProposalId) setSelectedProposalId(effectiveProposalId)
  }, [effectiveProposalId, selectedProposalId])

  // Persist the active tab to localStorage whenever it changes so the user's
  // last-selected view is restored on future bare '#/progress' visits.
  useEffect(() => {
    writePersistedView(activeTab)
  }, [activeTab])

  // Compute the set of IDs that match the search query (null = no active filter).
  const searchMatchIds = useMemo((): Set<string> | null => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return null
    const matchingTaskIds = new Set<string>(
      (tasks ?? [])
        .filter(
          (t) =>
            t.id.toLowerCase().includes(q) ||
            t.prompt.toLowerCase().includes(q) ||
            (t.branch?.toLowerCase() ?? '').includes(q),
        )
        .map((t) => t.id),
    )
    // Include proposals that have at least one matching child task.
    const matchingProposalIds = new Set<string>(
      proposals
        .filter((p) =>
          (tasks ?? []).some(
            (t) => t.parentProposalId === p.id && matchingTaskIds.has(t.id),
          ),
        )
        .map((p) => p.id),
    )
    return new Set([...matchingTaskIds, ...matchingProposalIds])
  }, [searchQuery, tasks, proposals])

  // Sync filter state to the URL after every change (debounced at 300 ms so
  // rapid search keystrokes don't produce a history entry per character).
  // history.replaceState is used — no hashchange event fires, so the app-level
  // hash router is not disturbed.
  useEffect(() => {
    const id = setTimeout(() => {
      writeProgressStateToUrl({
        view: activeTab,
        query: searchQuery,
        proposal: selectedProposalId,
        col: colMode,
      })
    }, 300)
    return () => clearTimeout(id)
  }, [activeTab, searchQuery, selectedProposalId, colMode])

  // inProgressFromCounts and failedCount/doneToday come from useStatusCounts()
  // (server-side single query) so every surface shows the same numbers.
  const inProgressCount = inProgressFromCounts

  return (
    <div className="flex h-full w-full min-h-0 overflow-hidden bg-background">
      <div className="flex min-w-0 flex-1 flex-col">
        <TopStripe
          inProgress={inProgressCount}
          doneToday={doneToday}
          failed={failedCount}
          connected={connected}
        />
        <TabStrip
          active={activeTab}
          onSelect={(tab) => {
            setActiveTab(tab)
            // Clear the proposals column shortcut when the user explicitly
            // switches tabs — they are no longer in the sidebar-navigated
            // proposals view, so the Proposals sidebar entry should unhighlight.
            setColMode(null)
          }}
        />
        {/* Text search — always visible */}
        <div className="flex items-center gap-2 border-b border-primary/20 bg-background px-4 py-1.5">
          <input
            type="text"
            data-testid="search-tasks"
            placeholder="Search id, prompt, branch…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-0.5 font-mono text-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-border"
          />
        </div>
        {/* Proposal filter — searchable combobox with chip UX.
            Hidden when data is settled and no active-arc proposals exist. */}
        <ProposalCombobox
          proposals={proposals}
          tasks={tasks}
          selectedProposalId={effectiveProposalId}
          onSelect={setSelectedProposalId}
        />
        {error && tasks === null ? (
          <main className="flex min-h-0 flex-1 overflow-hidden bg-background">
            <FallbackSurface error={error} of="tasks" variant="pane" />
          </main>
        ) : activeTab === 'topology' ? (
          <TopologyView
            tasks={tasks ?? []}
            proposals={proposals}
            selectedProposalId={effectiveProposalId}
            searchMatchIds={searchMatchIds}
            searchQuery={searchQuery}
            onSelectProposal={setSelectedProposalId}
          />
        ) : (
          <BoardView
            byCluster={byCluster}
            proposals={proposals}
            error={error}
            selectedProposalId={effectiveProposalId}
            searchMatchIds={searchMatchIds}
            searchQuery={searchQuery}
            onClearProposalFilter={() => setSelectedProposalId(null)}
          />
        )}
        <Footer />
      </div>
    </div>
  )
}
