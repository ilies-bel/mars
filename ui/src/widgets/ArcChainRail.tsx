import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { AlertChainNode } from '@/shared/schemas'
import { fetchEvents } from '@/shared/api'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import { relativeTime } from '@/shared/time'
import { severityColor, summarizeTraceEvent, marsToolTextClass } from '@/shared/actionQueueDetail'
import { traceEventRowClass } from '@/shared/traceSeverity'
import { SkeletonList } from '@/components/Skeleton'

export interface ArcChainRailProps {
  chain: AlertChainNode[]
  onSelectTask?: (id: string) => void
  onOpenProposal?: (id: string) => void
  /**
   * Override the initially-selected node id. When omitted the first task node
   * in the chain is selected. Primarily useful in tests where click events
   * cannot be simulated (renderToStaticMarkup is synchronous).
   */
  initialSelectedId?: string
}

/** Returns the id of the first `kind='task'` node, or null for empty/proposal-only chains. */
function firstTaskId(chain: AlertChainNode[]): string | null {
  return chain.find((n) => n.kind === 'task')?.id ?? null
}

/** Paginated trace events for one task — rendered inside the detail aside. */
function TaskTracePanel({ taskId }: { taskId: string }) {
  const projectId = useFocusedProjectId()
  const { data, isPending } = useQuery({
    queryKey: ['events', projectId, taskId, 'arc-chain-rail'],
    queryFn: () => fetchEvents({ taskId, limit: 30 }, projectId ?? undefined),
    enabled: projectId !== null,
  })

  if (isPending) {
    return <SkeletonList rows={3} rowClassName="h-4 w-full mb-1" label="Loading traces" />
  }
  if (!data || data.events.length === 0) {
    return <p className="font-mono text-[11px] text-muted-foreground">No trace events for this task.</p>
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {data.events.map((e) => (
        <li key={e.id} className={`font-mono text-[10px] ${traceEventRowClass(e.severity)}`}>
          <span className="text-muted-foreground">{relativeTime(e.timestamp)}</span>{' '}
          <span className={`uppercase ${severityColor(e.severity)}`}>
            [{e.severity}]
          </span>{' '}
          <span className="text-primary">{e.kind}</span>{' '}
          <span className={marsToolTextClass(e)}>{summarizeTraceEvent(e)}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Renders the arc's `chain` as a vertical rail of clickable node buttons
 * (Proposal → origin run → each Attempt), with the selected task node's
 * full prompt and trace events shown in a detail aside to the right.
 *
 * - Task nodes: clicking selects them and updates the detail pane.
 * - Proposal node: clicking calls `onOpenProposal` (navigation handled by caller).
 * - First task node is selected by default.
 */
export default function ArcChainRail({
  chain,
  onSelectTask,
  onOpenProposal,
  initialSelectedId,
}: ArcChainRailProps) {
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId ?? firstTaskId(chain),
  )

  const selectedNode =
    selectedId !== null ? (chain.find((n) => n.id === selectedId) ?? null) : null

  const handleNodeClick = (node: AlertChainNode) => {
    if (node.kind === 'proposal') {
      onOpenProposal?.(node.id)
    } else {
      setSelectedId(node.id)
      onSelectTask?.(node.id)
    }
  }

  return (
    <div className="flex gap-4">
      {/* Rail — ordered list of node buttons */}
      <ol className="flex min-w-0 flex-col gap-1">
        {chain.map((node, idx) => (
          <li key={node.id}>
            <button
              type="button"
              data-node-rail-id={node.id}
              onClick={() => handleNodeClick(node)}
              className={[
                'flex w-full items-baseline gap-1.5 rounded px-2 py-1 text-left font-mono text-[11px]',
                'transition-colors hover:bg-primary/10',
                selectedId === node.id ? 'bg-primary/15 font-bold text-foreground' : 'text-foreground/80',
              ].join(' ')}
            >
              <span className="shrink-0 text-[9px] uppercase text-primary">
                {node.kind === 'proposal'
                  ? 'Proposal'
                  : node.attemptIndex !== undefined
                    ? `#${node.attemptIndex}`
                    : `Node ${idx + 1}`}
              </span>
              <span className="break-words">{node.label}</span>
              {node.status ? (
                <span className="ml-auto shrink-0 text-[9px] uppercase text-muted-foreground">
                  {node.status}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ol>

      {/* Detail — shown when a task node is selected */}
      {selectedNode?.kind === 'task' ? (
        <aside
          className="flex min-w-0 flex-1 flex-col gap-3"
          data-node-id={selectedNode.id}
        >
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-primary">Prompt</p>
            <p className="whitespace-pre-wrap font-mono text-[12px] text-foreground">
              {selectedNode.label}
            </p>
          </div>
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-primary">Traces</p>
            <TaskTracePanel taskId={selectedNode.id} />
          </div>
        </aside>
      ) : null}
    </div>
  )
}
