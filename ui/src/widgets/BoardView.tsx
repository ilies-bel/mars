import { useState } from 'react'
import { ProposalCard } from '@/components/ProposalCard'
import type { Cluster, DraftFeature, ProgressTask } from '@/shared/schemas'
import type { Role, UITask } from '@/shared/types'
import { titleFromPrompt } from '@/shared/promptTitle'
import { Column } from '@/widgets/Column'

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

type ActiveTab = Cluster | 'Proposals'

// Display order in the tab strip (mirrors column order — attention-first)
const ALL_TABS: readonly ActiveTab[] = ['Failed', 'Blocked', 'In progress', 'Queued', 'Proposals']

// Priority for the default tab: leftmost non-empty of Failed, Blocked, In progress, Queued.
// Same story as ALL_TABS and CLUSTERS — the "what needs me right now" column wins.
const DEFAULT_TAB_PRIORITY: readonly ActiveTab[] = ['Failed', 'Blocked', 'In progress', 'Queued']

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
    default:
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

// Column order — attention-first (Failed / Blocked leftmost) so the "what needs me
// right now" columns land in the first scan positions. Matches DEFAULT_TAB_PRIORITY
// and ALL_TABS so desktop and mobile tell the same story.
const CLUSTERS: readonly Cluster[] = ['Failed', 'Blocked', 'In progress', 'Queued']

// ---------------------------------------------------------------------------
// BoardView component
// ---------------------------------------------------------------------------

export interface BoardViewProps {
  byCluster: Record<Cluster, ProgressTask[]>
  drafts: DraftFeature[]
  error: Error | null
  selectedProposalId: string | null
  /**
   * When set, only tasks whose ID is in this set are rendered in each column.
   * null = no active text search (show all tasks).
   */
  searchMatchIds?: Set<string> | null
  /**
   * The raw search query string — displayed in the zero-state message when
   * searchMatchIds is non-null and no tasks match. Optional for back-compat.
   */
  searchQuery?: string
}

export const BoardView = ({
  byCluster,
  drafts,
  error,
  selectedProposalId,
  searchMatchIds,
  searchQuery,
}: BoardViewProps) => {
  // Filter drafts for the Proposals column
  const visibleDrafts =
    selectedProposalId !== null
      ? drafts.filter((d) => d.id === selectedProposalId)
      : drafts

  // Pre-compute filtered+searched task lists per cluster (used for both rendering and counts)
  const filteredByCluster = Object.fromEntries(
    CLUSTERS.map((cluster) => {
      const clusterTasks = byCluster[cluster]
      const filtered =
        selectedProposalId !== null
          ? clusterTasks.filter((t) => t.parentProposalId === selectedProposalId)
          : clusterTasks
      const searched =
        searchMatchIds != null
          ? filtered.filter((t) => searchMatchIds.has(t.id))
          : filtered
      return [cluster, searched.map(toUI)]
    }),
  ) as Record<Cluster, UITask[]>

  // Total tasks visible across all clusters after proposal + search filtering.
  // Used to detect the search zero-state (active query that matches nothing).
  const totalMatchedTasks =
    filteredByCluster.Queued.length +
    filteredByCluster['In progress'].length +
    filteredByCluster.Blocked.length +
    filteredByCluster.Failed.length

  // Task count per tab (for the mobile strip badges)
  const tabCounts: Record<ActiveTab, number> = {
    Queued: filteredByCluster.Queued.length,
    'In progress': filteredByCluster['In progress'].length,
    Blocked: filteredByCluster.Blocked.length,
    Failed: filteredByCluster.Failed.length,
    Proposals: visibleDrafts.length,
  }

  // Default to the leftmost non-empty of Failed → Blocked → In progress → Queued; else Queued
  const defaultTab = DEFAULT_TAB_PRIORITY.find((t) => tabCounts[t] > 0) ?? 'Queued'

  // Active tab controls which single column is visible on mobile
  const [activeTab, setActiveTab] = useState<ActiveTab>(defaultTab)

  let cursor = 0

  // Tabs to show in the strip (Proposals only when there are visible drafts)
  const visibleTabs = visibleDrafts.length > 0 ? ALL_TABS : (ALL_TABS.slice(0, 4) as readonly ActiveTab[])

  return (
    <>
      {/* ------------------------------------------------------------------ */}
      {/* Mobile-only horizontal status tab strip (hidden at md / 768px+)     */}
      {/* ------------------------------------------------------------------ */}
      <div
        role="tablist"
        aria-label="Board status"
        data-testid="board-tab-strip"
        className="flex min-h-[44px] shrink-0 items-center overflow-x-auto border-b border-border bg-bg px-2 md:hidden"
      >
        {visibleTabs.map((tab) => {
          const count = tabCounts[tab]
          return (
            <button
              key={tab}
              role="tab"
              data-tab={tab}
              aria-selected={activeTab === tab}
              onClick={() => setActiveTab(tab)}
              className={`flex min-h-[44px] shrink-0 items-center gap-1.5 border-b-2 px-3 font-sans text-[11px] font-semibold tracking-[0.08em] transition-colors ${
                activeTab === tab
                  ? 'border-flame text-flame'
                  : 'border-transparent text-muted hover:text-fg'
              }`}
            >
              {tab}
              {count > 0 ? (
                <span className="font-mono text-[10px] tabular-nums opacity-70">{count}</span>
              ) : null}
            </button>
          )
        })}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Board layout                                                         */}
      {/*   mobile  (<768px):   flex-col, one column at a time (tab-driven)   */}
      {/*   tablet  (768–1024px): CSS grid, 2–3 fluid columns, vertical scroll */}
      {/*   desktop (>1024px):  flex-row, original 5 equal columns            */}
      {/* ------------------------------------------------------------------ */}
      <main className="relative flex flex-col min-h-0 flex-1 gap-3 overflow-hidden bg-bg p-4 md:grid md:grid-cols-[repeat(auto-fit,minmax(280px,1fr))] md:auto-rows-[400px] md:overflow-y-auto lg:flex lg:flex-row lg:overflow-hidden">
        {/* Zero-state search pill — shown when a non-empty search matches no tasks.
            pointer-events:none so it never blocks column scroll interaction. */}
        {searchMatchIds != null && totalMatchedTasks === 0 && (
          <div
            data-testid="search-zero-state"
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
          >
            <span className="rounded border border-border bg-surface px-3 py-1.5 font-mono text-[11px] text-muted">
              {`0 tasks match '${(searchQuery ?? '').trim()}'`}
            </span>
          </div>
        )}
        {CLUSTERS.map((cluster) => {
          const tasksForCluster = filteredByCluster[cluster]
          const startIndex = cursor
          cursor += tasksForCluster.length
          const accent: 'flame' | 'muted' =
            cluster === 'In progress' ? 'flame' : 'muted'
          // Mobile: show only the active tab's column. Tablet+: show all.
          const isActiveOnMobile = activeTab === cluster
          return (
            <div
              key={cluster}
              data-cluster={cluster}
              className={`${isActiveOnMobile ? 'flex' : 'hidden'} flex-col flex-1 min-h-0 md:flex lg:flex-1 lg:basis-0`}
            >
              <Column
                label={cluster}
                accent={accent}
                tasks={tasksForCluster}
                startIndex={startIndex}
              />
            </div>
          )
        })}
        {visibleDrafts.length > 0 ? (
          <div
            data-cluster="Proposals"
            className={`${activeTab === 'Proposals' ? 'flex' : 'hidden'} flex-col flex-1 min-h-0 md:flex lg:flex-1 lg:basis-0`}
          >
            <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-2 rounded-lg border border-border bg-panel p-3">
              <header className="flex items-center justify-between px-1 py-0.5">
                <span className="font-sans text-[11px] font-semibold tracking-[0.1em] text-muted">
                  Proposals
                </span>
                <span className="font-mono text-[11px] font-semibold text-muted">
                  {visibleDrafts.length}
                </span>
              </header>
              <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
                {visibleDrafts.map((proposal) => (
                  <ProposalCard key={proposal.id} proposal={proposal} />
                ))}
              </div>
            </section>
          </div>
        ) : null}
      </main>
      {error ? (
        <div className="border-t border-iron/40 bg-iron/10 px-6 py-1.5 font-mono text-[11px] text-iron">
          {error.message}
        </div>
      ) : null}
    </>
  )
}
