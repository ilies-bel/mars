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
import { BoardView } from '@/widgets/BoardView'
import { Footer } from '@/widgets/Footer'
import { TabStrip } from '@/widgets/TabStrip'
import { TopologyView } from '@/widgets/TopologyView'
import { TopStripe } from '@/widgets/TopStripe'
import { useDispatchState } from '@/entities/operator/useDispatchState'
import { useDaemonHealth } from '@/entities/daemon/useDaemonHealth'

export const ProgressPage = () => {
  // Initialise query and proposal filter dimensions from the URL on first render.
  // readProgressStateFromUrl() returns defaults in non-browser environments.
  const [initialUrlState] = useState(() => readProgressStateFromUrl())

  const { byCluster, tasks, proposals, aggregates, error, connected } = useProgress()

  // Resolve the initial active tab:
  //   1. Explicit ?view= param in the URL (shareable links are always honoured)
  //   2. DEFAULT_TAB ('topology')
  //
  // Topology is THE Progress view; Board is the alternate. The tab used to be
  // remembered in localStorage, which quietly defeated that: one visit to Board
  // pinned it as the landing view forever, so the declared default never
  // applied again and Progress opened on Board indefinitely. A per-session tab
  // choice is not worth overriding the primary view of the page.
  const [activeTab, setActiveTab] = useState<Tab>(
    () => readExplicitViewFromUrl() ?? DEFAULT_TAB,
  )

  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(
    initialUrlState.proposal,
  )
  const [searchQuery, setSearchQuery] = useState<string>(initialUrlState.query)

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
        col: null,
      })
    }, 300)
    return () => clearTimeout(id)
  }, [activeTab, searchQuery, selectedProposalId])

  const dispatch = useDispatchState()
  const { isDown: daemonDown } = useDaemonHealth()
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
          dispatch={dispatch}
          daemonDown={daemonDown}
        />
        <TabStrip active={activeTab} onSelect={setActiveTab} />
        {/* Text search — always visible */}
        <div className="flex items-center border-b border-border bg-background px-4 py-1.5">
          <div className="relative min-w-0 flex-1">
            <span
              className="pointer-events-none absolute inset-y-0 left-2 flex select-none items-center text-muted-foreground/60"
              aria-hidden="true"
            >
              ⌕
            </span>
            <input
              type="text"
              data-testid="search-tasks"
              placeholder="Search id, prompt, branch…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-md border border-border bg-card py-0.5 pl-6 pr-2 font-mono text-label text-foreground placeholder:text-muted-foreground/60 focus:border-highlight/40 focus:outline-none"
            />
          </div>
        </div>
        {error && tasks === null ? (
          <main className="flex min-h-0 flex-1 overflow-hidden bg-background">
            <FallbackSurface error={error} of="tasks" variant="pane" />
          </main>
        ) : activeTab === 'topology' ? (
          <TopologyView
            tasks={tasks ?? []}
            proposals={proposals}
            selectedProposalId={selectedProposalId}
            searchMatchIds={searchMatchIds}
            searchQuery={searchQuery}
            onSelectProposal={setSelectedProposalId}
          />
        ) : (
          <BoardView
            byCluster={byCluster}
            proposals={proposals}
            error={error}
            selectedProposalId={selectedProposalId}
            searchMatchIds={searchMatchIds}
            searchQuery={searchQuery}
          />
        )}
        <Footer />
      </div>
    </div>
  )
}
