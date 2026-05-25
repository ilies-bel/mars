import { useState } from 'react'
import { ApiErrorPanel } from '@/components/ApiErrorPanel'
import { ProposalCard } from '@/components/ProposalCard'
import { useTodo } from '@/entities/todo/useTodo'
import { useProgress } from '@/hooks/useProgress'
import type { Cluster, ProgressTask } from '@/shared/schemas'
import { DEFAULT_TAB, type Tab } from '@/shared/tabs'
import type { Role, UITask } from '@/shared/types'
import { Column } from '@/widgets/Column'
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
import { EventsView } from '@/widgets/EventsView'
import { TopologyView } from '@/widgets/TopologyView'
import { TopStripe } from '@/widgets/TopStripe'

const titleFromPrompt = (prompt: string): string => {
  const first = prompt.split(/\r?\n/, 1)[0]?.trim() ?? ''
  return first.length > 0 ? first : prompt.trim()
}

const roleFromStatus = (status: ProgressTask['status']): Role => {
  switch (status) {
    case 'running':
      return 'builder'
    case 'verifying':
      return 'reviewer'
    case 'merging':
    case 'vega-reconciling':
      return 'orchestrator'
    case 'draft':
    case 'queued':
      return 'planner'
    case 'blocked':
    case 'done':
    case 'failed':
    case 'dropped':
      return 'orchestrator'
  }
}

const toUI = (t: ProgressTask): UITask => ({
  id: t.id,
  title: titleFromPrompt(t.prompt),
  status: t.status,
  role: roleFromStatus(t.status),
  failed: t.status === 'failed',
  dropReason: t.dropReason ?? null,
  retryCount: t.retryCount ?? 0,
  blockerTaskId: t.blockerTaskId ?? null,
  spec: t.spec ?? null,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
})

const CLUSTERS: readonly Cluster[] = ['Queued', 'In progress', 'Blocked', 'Failed']

export const ProgressPage = () => {
  const [recencyStop, setRecencyStop] = useState<RecencyStop>(RECENCY_STOP_DEFAULT)
  const failedWindowMs = recencyStopToMs(recencyStop)
  const { byCluster, tasks, proposals, error, connected } = useProgress({ failedWindowMs })
  const { drafts } = useTodo()
  const [activeTab, setActiveTab] = useState<Tab>(DEFAULT_TAB)
  const [activeToggles, setActiveToggles] = useState<Set<ClusterToggle>>(
    new Set(ALL_CLUSTER_TOGGLES),
  )

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

  let cursor = 0
  const startIdx = (n: number): number => {
    const v = cursor
    cursor += n
    return v
  }

  const boardBody = (
    <>
      <main className="flex min-h-0 flex-1 gap-3 overflow-hidden bg-bg p-4">
        {CLUSTERS.map((cluster) => {
          // 'Queued' has no toggle; 'In progress', 'Blocked', 'Failed' respect theirs.
          if (cluster !== 'Queued' && ghostedClusters.has(cluster)) return null
          const tasksForCluster = byCluster[cluster].map(toUI)
          const accent: 'flame' | 'muted' =
            cluster === 'In progress' ? 'flame' : 'muted'
          return (
            <Column
              key={cluster}
              label={cluster}
              accent={accent}
              tasks={tasksForCluster}
              startIndex={startIdx(tasksForCluster.length)}
            />
          )
        })}
        {drafts.length > 0 ? (
          <section className="flex h-full min-h-0 min-w-0 flex-1 basis-0 flex-col gap-2 rounded-lg border border-border bg-panel p-3">
            <header className="flex items-center justify-between px-1 py-0.5">
              <span className="font-sans text-[11px] font-semibold tracking-[0.1em] text-muted">
                Proposals
              </span>
              <span className="font-mono text-[11px] font-semibold text-muted">
                {drafts.length}
              </span>
            </header>
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
              {drafts.map((proposal) => (
                <ProposalCard key={proposal.id} proposal={proposal} />
              ))}
            </div>
          </section>
        ) : null}
      </main>
      {error ? (
        <div className="border-t border-iron/40 bg-iron/10 px-6 py-1.5 font-mono text-[11px] text-iron">
          {error}
        </div>
      ) : null}
    </>
  )

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
        <TabStrip active={activeTab} onSelect={setActiveTab} />
        <ClusterToggleBar active={activeToggles} onToggle={handleToggle} />
        <div className="flex items-center border-b border-iron/20 bg-bg px-4 py-1">
          <RecencySlider value={recencyStop} onChange={setRecencyStop} />
        </div>
        {error && tasks === null ? (
          <main className="flex min-h-0 flex-1 overflow-hidden bg-bg">
            <ApiErrorPanel error={error} />
          </main>
        ) : activeTab === 'events' ? (
          <EventsView />
        ) : activeTab === 'topology' ? (
          <TopologyView
            tasks={tasks ?? []}
            proposals={proposals}
            ghostedClusters={ghostedClusters}
          />
        ) : (
          boardBody
        )}
        <Footer />
      </div>
    </div>
  )
}
