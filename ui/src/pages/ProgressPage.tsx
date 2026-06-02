import { useEffect, useMemo, useState } from 'react'
import { ApiErrorPanel } from '@/components/ApiErrorPanel'
import { useTodo } from '@/entities/todo/useTodo'
import { useProgress } from '@/hooks/useProgress'
import {
  readProgressStateFromUrl,
  writeProgressStateToUrl,
} from '@/shared/progressUrlState'
import type { Tab } from '@/shared/tabs'
import { BoardView } from '@/widgets/BoardView'
import {
  ALL_CLUSTER_TOGGLES,
  ClusterToggleBar,
  type ClusterToggle,
} from '@/widgets/ClusterToggleBar'
import { Footer } from '@/widgets/Footer'
import { Sidebar } from '@/widgets/Sidebar'
import { TabStrip } from '@/widgets/TabStrip'
import { TopologyView } from '@/widgets/TopologyView'
import { KpiVector } from '@/widgets/KpiVector'
import { TopStripe } from '@/widgets/TopStripe'

export const ProgressPage = () => {
  // Initialise every filter dimension from the URL on first render.
  // readProgressStateFromUrl() returns defaults in non-browser environments.
  const [initialUrlState] = useState(() => readProgressStateFromUrl())

  const { byCluster, tasks, proposals, error, connected } = useProgress()
  const { drafts } = useTodo()
  const [activeTab, setActiveTab] = useState<Tab>(initialUrlState.view)
  const [activeToggles, setActiveToggles] = useState<Set<ClusterToggle>>(
    initialUrlState.clusters,
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

  const handleToggle = (cluster: ClusterToggle): void =>
    setActiveToggles((prev) => {
      const next = new Set(prev)
      if (next.has(cluster)) next.delete(cluster)
      else next.add(cluster)
      return next
    })

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
        clusters: activeToggles,
      })
    }, 300)
    return () => clearTimeout(id)
  }, [activeTab, searchQuery, selectedProposalId, activeToggles])

  // Clusters whose nodes/cards should be suppressed.
  const ghostedClusters = new Set<string>(
    ALL_CLUSTER_TOGGLES.filter((c) => !activeToggles.has(c)),
  )

  const totalTasks = tasks?.length ?? 0
  const inProgressCount = byCluster['In progress'].length
  const blockedCount = byCluster.Blocked.length
  const failedCount = byCluster.Failed.length

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg">
      <Sidebar
        tasksCount={totalTasks}
        triageCount={blockedCount}
        connected={connected}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopStripe
          inProgress={inProgressCount}
          todo={blockedCount}
          done={failedCount}
          connected={connected}
        />
        <KpiVector />
        <TabStrip active={activeTab} onSelect={setActiveTab} />
        <ClusterToggleBar active={activeToggles} onToggle={handleToggle} />
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
            <ApiErrorPanel error={error.message} />
          </main>
        ) : activeTab === 'topology' ? (
          <TopologyView
            tasks={tasks ?? []}
            proposals={proposals}
            ghostedClusters={ghostedClusters}
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
            ghostedClusters={ghostedClusters}
            searchMatchIds={searchMatchIds}
          />
        )}
        <Footer />
      </div>
    </div>
  )
}
