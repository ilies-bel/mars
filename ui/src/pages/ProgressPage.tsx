import { useEffect, useMemo, useState } from 'react'
import { ApiErrorPanel } from '@/components/ApiErrorPanel'
import { useProposals } from '@/entities/proposals/useProposals'
import { useProgress } from '@/hooks/useProgress'
import { ApiError } from '@/shared/api'
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

  const { byCluster, tasks, proposals, error, connected } = useProgress()
  const { proposals: drafts } = useProposals()

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
  const failedCount = byCluster.Failed.length
  const doneCount = (tasks ?? []).filter((t) => t.status === 'done').length

  return (
    <div className="flex h-full w-full min-h-0 overflow-hidden bg-bg">
      <div className="flex min-w-0 flex-1 flex-col">
        <TopStripe
          inProgress={inProgressCount}
          done={doneCount}
          failed={failedCount}
          connected={connected}
        />
        <TabStrip active={activeTab} onSelect={setActiveTab} />
        {/* Text search — always visible */}
        <div className="flex items-center gap-2 border-b border-iron/20 bg-bg px-4 py-1.5">
          <input
            type="text"
            data-testid="search-tasks"
            placeholder="Search id, prompt, branch…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-0.5 font-mono text-[11px] text-fg placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-border"
          />
        </div>
        {/* Proposal filter — shown only when there are in-scope proposals */}
        {proposals.length > 0 ? (
          <div
            className="flex items-center gap-2 border-b border-border px-4 py-2"
            data-testid="proposal-filter"
          >
            <label
              htmlFor="proposal-filter-select"
              className="shrink-0 font-mono text-[11px] text-muted"
            >
              Proposal
            </label>
            <select
              id="proposal-filter-select"
              value={selectedProposalId ?? ''}
              onChange={(e) => setSelectedProposalId(e.target.value || null)}
              className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-0.5 font-mono text-[11px] text-fg focus:outline-none focus:ring-1 focus:ring-border"
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
          <main className="flex min-h-0 flex-1 overflow-hidden bg-bg">
            <ApiErrorPanel
              error={error.message}
              kind={error instanceof ApiError ? error.kind : undefined}
            />
          </main>
        ) : activeTab === 'topology' ? (
          <TopologyView
            tasks={tasks ?? []}
            proposals={proposals}
            selectedProposalId={selectedProposalId}
            searchMatchIds={searchMatchIds}
            onSelectProposal={setSelectedProposalId}
          />
        ) : (
          <BoardView
            byCluster={byCluster}
            drafts={drafts}
            error={error}
            selectedProposalId={selectedProposalId}
            searchMatchIds={searchMatchIds}
          />
        )}
        <Footer />
      </div>
    </div>
  )
}
