import { useProgress } from '@/hooks/useProgress'
import type { Cluster, ProgressTask } from '@/shared/schemas'
import type { Role, UITask } from '@/shared/types'
import { Column } from '@/widgets/Column'
import { Footer } from '@/widgets/Footer'
import { Sidebar } from '@/widgets/Sidebar'
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
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
})

const CLUSTERS: readonly Cluster[] = ['In progress', 'Blocked', 'Failed']

export const ProgressPage = () => {
  const { byCluster, tasks, error, connected } = useProgress()

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
        <main className="flex min-h-0 flex-1 gap-3 overflow-hidden bg-bg p-4">
          {CLUSTERS.map((cluster) => {
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
        </main>
        {error ? (
          <div className="border-t border-iron/40 bg-iron/10 px-6 py-1.5 font-mono text-[11px] text-iron">
            {error}
          </div>
        ) : null}
        <Footer />
      </div>
    </div>
  )
}
