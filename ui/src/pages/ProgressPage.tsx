import { useEffect, useMemo, useState } from 'react'
import { FallbackSurface } from '@/components/FallbackSurface'
import { useProgress } from '@/hooks/useProgress'
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
import { TopologyView } from '@/widgets/TopologyView'
import { TopStripe } from '@/widgets/TopStripe'

export const ProgressPage = () => {
  // Initialise query and proposal filter dimensions from the URL on first render.
  // readProgressStateFromUrl() returns defaults in non-browser environments.
  const [initialUrlState] = useState(() => readProgressStateFromUrl())

  const { byCluster, tasks, proposals, aggregates, error, connected } = useProgress()

  // Resolve the initial active tab with the following precedence:
  //   1. Explicit ?view= param in the URL (shareable links are always honoured)
  //   2. Last persisted view from localStorage (remembered across sessions)
  //   3. DEFAULT_TAB ('topology') as the final fallback
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const explicit = readExplicitViewFromUrl()
    if (explicit !== null) return explicit
    return readPersistedView() ?? DEFAULT_TAB
  })

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
      })
    }, 300)
    return () => clearTimeout(id)
  }, [activeTab, searchQuery, selectedProposalId])

  const inProgressCount = byCluster['In progress'].length
  // Use server-side aggregate counts so done/failed are accurate even though
  // terminal task rows are excluded from the progress graph projection.
  const doneToday = aggregates.doneToday
  const failedCount = aggregates.failedOpen

  return (
    <div className="flex h-full w-full min-h-0 overflow-hidden bg-background">
      <div className="flex min-w-0 flex-1 flex-col">
        <TopStripe
          inProgress={inProgressCount}
          doneToday={doneToday}
          failed={failedCount}
          connected={connected}
        />
        <TabStrip active={activeTab} onSelect={setActiveTab} />
        {/* Text search — always visible */}
        <div className="flex items-center gap-2 border-b border-primary/20 bg-background px-4 py-1.5">
          <input
            type="text"
            data-testid="search-tasks"
            placeholder="Search id, prompt, branch…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-0.5 font-mono text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-border"
          />
        </div>
        {/* Proposal filter — shown while loading (tasks===null) to reserve the
            slot height, and whenever there are in-scope proposals to filter by.
            Hidden only when data has settled and no proposals exist. */}
        {(tasks === null || proposals.length > 0) ? (
          <div
            className="flex items-center gap-2 border-b border-border px-4 py-2"
            data-testid="proposal-filter"
          >
            <label
              htmlFor="proposal-filter-select"
              className="shrink-0 font-mono text-[11px] text-muted-foreground"
            >
              Proposal
            </label>
            <select
              id="proposal-filter-select"
              value={effectiveProposalId ?? ''}
              onChange={(e) => setSelectedProposalId(e.target.value || null)}
              disabled={tasks === null}
              className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-0.5 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-border disabled:opacity-50"
            >
              <option value="">All</option>
              {proposals.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title.length > 60 ? `${p.title.slice(0, 59)}…` : p.title}
                </option>
              ))}
            </select>
          </div>
        ) : null}
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
          />
        )}
        <Footer />
      </div>
    </div>
  )
}
