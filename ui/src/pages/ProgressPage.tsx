import { useState } from 'react'
import { ApiErrorPanel } from '@/components/ApiErrorPanel'
import { useTodo } from '@/entities/todo/useTodo'
import { useProgress } from '@/hooks/useProgress'
import { DEFAULT_TAB, type Tab } from '@/shared/tabs'
import { BoardView } from '@/widgets/BoardView'
import {
  ALL_CLUSTER_TOGGLES,
  ClusterToggleBar,
  type ClusterToggle,
} from '@/widgets/ClusterToggleBar'
import { Footer } from '@/widgets/Footer'
import {
  RecencySlider,
  RECENCY_STOP_DEFAULT,
  recencyStopToMs,
  type RecencyStop,
} from '@/widgets/RecencySlider'
import { Sidebar } from '@/widgets/Sidebar'
import { TabStrip } from '@/widgets/TabStrip'
import { TopologyView } from '@/widgets/TopologyView'
import { KpiVector } from '@/widgets/KpiVector'
import { TopStripe } from '@/widgets/TopStripe'

export const ProgressPage = () => {
  const [recencyStop, setRecencyStop] = useState<RecencyStop>(RECENCY_STOP_DEFAULT)
  const failedWindowMs = recencyStopToMs(recencyStop)
  const { byCluster, tasks, proposals, error, connected } = useProgress({ failedWindowMs })
  const { drafts } = useTodo()
  const [activeTab, setActiveTab] = useState<Tab>(DEFAULT_TAB)
  const [activeToggles, setActiveToggles] = useState<Set<ClusterToggle>>(
    new Set(ALL_CLUSTER_TOGGLES),
  )
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null)

  const handleToggle = (cluster: ClusterToggle): void =>
    setActiveToggles((prev) => {
      const next = new Set(prev)
      if (next.has(cluster)) next.delete(cluster)
      else next.add(cluster)
      return next
    })

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
        <div className="flex items-center border-b border-iron/20 bg-bg px-4 py-1">
          <RecencySlider value={recencyStop} onChange={setRecencyStop} />
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
          />
        ) : (
          <BoardView
            byCluster={byCluster}
            drafts={drafts}
            error={error}
            selectedProposalId={selectedProposalId}
            ghostedClusters={ghostedClusters}
          />
        )}
        <Footer />
      </div>
    </div>
  )
}
