import { ApiErrorPanel } from '@/components/ApiErrorPanel'
import { useProgress } from '@/hooks/useProgress'
import type { ProgressTask } from '@/shared/schemas'

/**
 * Topology view (tracer-bullet stub).
 *
 * Renders the current task set as a layered list grouped by depth in the
 * blocker graph, with each row linking to `#/task/<id>` so the existing
 * TaskDetailDrawer opens for inspection (free reuse of slice-7 work).
 *
 * TODO(topology-graph): swap this list rendering for a real DAG layout.
 *   The original PRD called for reactflow + @dagrejs/dagre; neither is
 *   installed yet, so we ship the layered list now and follow up with the
 *   visual graph in a separate slice. The data model (depth-by-blocker
 *   layering) is identical, so the upgrade is purely a render change.
 */

interface LayeredTask {
  task: ProgressTask
  depth: number
}

/**
 * Computes a depth-by-blocker layering. Tasks with no blocker live at
 * depth 0; a task's depth is 1 + max(depth of any blocker it points at).
 * Cycles and dangling blocker ids degrade gracefully to depth 0.
 */
const layerByBlocker = (tasks: readonly ProgressTask[]): LayeredTask[] => {
  const byId = new Map<string, ProgressTask>()
  for (const t of tasks) byId.set(t.id, t)

  const depths = new Map<string, number>()
  const visiting = new Set<string>()

  const depthOf = (id: string): number => {
    const cached = depths.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 0
    const task = byId.get(id)
    if (!task) return 0
    visiting.add(id)
    const blockerId = task.blockerTaskId ?? null
    const d = blockerId ? 1 + depthOf(blockerId) : 0
    visiting.delete(id)
    depths.set(id, d)
    return d
  }

  return tasks
    .map((task) => ({ task, depth: depthOf(task.id) }))
    .sort((a, b) => a.depth - b.depth || a.task.id.localeCompare(b.task.id))
}

const titleFromPrompt = (prompt: string): string => {
  const first = prompt.split(/\r?\n/, 1)[0]?.trim() ?? ''
  return first.length > 0 ? first : prompt.trim()
}

export const TopologyPage = () => {
  const { tasks, error } = useProgress()

  if (error && tasks === null) {
    return (
      <main className="flex min-h-0 flex-1 overflow-hidden bg-bg">
        <ApiErrorPanel error={error} />
      </main>
    )
  }

  const layered = tasks ? layerByBlocker(tasks) : []

  return (
    <main className="flex h-full min-h-0 flex-1 flex-col gap-2 overflow-auto bg-bg p-4">
      <header className="font-mono text-[11px] uppercase tracking-wide text-iron">
        Topology — {layered.length} task{layered.length === 1 ? '' : 's'}
      </header>
      {/* TODO(topology-graph): replace this layered list with a real graph */}
      <ul className="flex flex-col gap-1" data-testid="topology-list">
        {layered.map(({ task, depth }) => (
          <li key={task.id}>
            <a
              href={`#/task/${encodeURIComponent(task.id)}`}
              className="block rounded border border-iron/30 bg-iron/5 px-3 py-2 font-mono text-[12px] text-fg hover:bg-iron/15"
              style={{ marginLeft: `${depth * 24}px` }}
              data-testid={`topology-node-${task.id}`}
              data-depth={depth}
            >
              <span className="text-iron">[{task.status}]</span>{' '}
              <span>{titleFromPrompt(task.prompt)}</span>
              {task.blockerTaskId ? (
                <span className="ml-2 text-iron">↳ blocked by {task.blockerTaskId}</span>
              ) : null}
            </a>
          </li>
        ))}
        {layered.length === 0 && !error ? (
          <li className="font-mono text-[11px] text-iron">No tasks to display.</li>
        ) : null}
      </ul>
      {error ? (
        <div className="border-t border-iron/40 bg-iron/10 px-6 py-1.5 font-mono text-[11px] text-iron">
          {error}
        </div>
      ) : null}
    </main>
  )
}
