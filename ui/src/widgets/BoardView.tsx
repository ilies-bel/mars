import { ProposalCard } from '@/components/ProposalCard'
import type { Cluster, DraftFeature, ProgressTask } from '@/shared/schemas'
import type { Role, UITask } from '@/shared/types'
import { Column } from '@/widgets/Column'

// ---------------------------------------------------------------------------
// Helpers (used only by this module)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// BoardView component
// ---------------------------------------------------------------------------

export interface BoardViewProps {
  byCluster: Record<Cluster, ProgressTask[]>
  drafts: DraftFeature[]
  error: Error | null
  selectedProposalId: string | null
  /**
   * Cluster names whose entire column should be suppressed (driven by the
   * per-cluster toggle chips). 'Queued' has no toggle and is never hidden.
   */
  ghostedClusters?: Set<string>
}

export const BoardView = ({
  byCluster,
  drafts,
  error,
  selectedProposalId,
  ghostedClusters,
}: BoardViewProps) => {
  let cursor = 0

  const visibleDrafts =
    selectedProposalId !== null
      ? drafts.filter((d) => d.id === selectedProposalId)
      : drafts

  return (
    <>
      <main className="flex min-h-0 flex-1 gap-3 overflow-hidden bg-bg p-4">
        {CLUSTERS.map((cluster) => {
          // 'Queued' has no toggle; the rest respect the cluster toggles.
          if (cluster !== 'Queued' && ghostedClusters?.has(cluster)) return null
          const clusterTasks = byCluster[cluster]
          const filtered =
            selectedProposalId !== null
              ? clusterTasks.filter((t) => t.parentProposalId === selectedProposalId)
              : clusterTasks
          const tasksForCluster = filtered.map(toUI)
          const startIndex = cursor
          cursor += tasksForCluster.length
          const accent: 'flame' | 'muted' =
            cluster === 'In progress' ? 'flame' : 'muted'
          return (
            <Column
              key={cluster}
              label={cluster}
              accent={accent}
              tasks={tasksForCluster}
              startIndex={startIndex}
            />
          )
        })}
        {visibleDrafts.length > 0 ? (
          <section className="flex h-full min-h-0 min-w-0 flex-1 basis-0 flex-col gap-2 rounded-lg border border-border bg-panel p-3">
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
