import { useState, useMemo } from 'react'
import { ApiErrorPanel } from '@/components/ApiErrorPanel'
import { useProgress } from '@/hooks/useProgress'
import type { Cluster, ProgressTask, TaskStatus } from '@/shared/schemas'

/**
 * Events view (renamed from Topology).
 *
 * Renders the current task set as a layered list grouped by depth in the
 * blocker graph, with search and filtering. Each row links to `#/task/<id>`
 * so the existing TaskDetailDrawer opens for inspection.
 *
 * Field mapping note: ProgressTask has no dedicated "worker/agent name" or
 * "severity" field. `status` is used for both the Event-type filter and the
 * Severity filter (they are the same field — the task lifecycle status).
 * `cluster` ('Queued' | 'In progress' | 'Blocked' | 'Failed') is surfaced as
 * the Severity filter because it maps naturally to error/warn/info severity
 * levels. `prompt` is the event message/text body.
 *
 * TODO(events-graph): swap this list rendering for a real DAG layout.
 */

// ---------------------------------------------------------------------------
// Time-range filter
// ---------------------------------------------------------------------------

type TimeRange = 'all' | '15m' | '1h' | '24h'

const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: '15m', label: 'Last 15m' },
  { value: '1h', label: 'Last 1h' },
  { value: '24h', label: 'Last 24h' },
]

const TIME_RANGE_MS: Record<Exclude<TimeRange, 'all'>, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
}

// ---------------------------------------------------------------------------
// Depth layering (unchanged from former TopologyPage)
// ---------------------------------------------------------------------------

interface LayeredTask {
  task: ProgressTask
  depth: number
}

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

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

const chipClass = (active: boolean): string =>
  [
    'rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors',
    active
      ? 'border-iron/60 bg-iron/30 text-fg'
      : 'border-iron/30 bg-transparent text-iron hover:border-iron/50 hover:text-fg',
  ].join(' ')

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const EventsPage = () => {
  const { tasks, error } = useProgress()

  // --- filter state ---
  const [search, setSearch] = useState('')
  const [selectedStatuses, setSelectedStatuses] = useState<Set<TaskStatus>>(new Set())
  const [timeRange, setTimeRange] = useState<TimeRange>('all')
  const [taskIdFilter, setTaskIdFilter] = useState('')
  const [selectedClusters, setSelectedClusters] = useState<Set<Cluster>>(new Set())

  // --- derived: full layered list ---
  const layered = useMemo(() => (tasks ? layerByBlocker(tasks) : []), [tasks])

  // --- distinct values for filter chips (from full set) ---
  const distinctStatuses = useMemo(
    () =>
      [...new Set(layered.map(({ task }) => task.status))].sort() as TaskStatus[],
    [layered],
  )

  const distinctClusters = useMemo(
    () =>
      [...new Set(layered.map(({ task }) => task.cluster))].sort() as Cluster[],
    [layered],
  )

  // --- toggle helpers ---
  const toggleStatus = (s: TaskStatus): void =>
    setSelectedStatuses((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })

  const toggleCluster = (c: Cluster): void =>
    setSelectedClusters((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })

  // --- filtered list (AND across filters) ---
  const filtered = useMemo(() => {
    const cutoff =
      timeRange !== 'all' ? Date.now() - TIME_RANGE_MS[timeRange] : null
    const q = search.trim().toLowerCase()
    const idExact = taskIdFilter.trim()

    return layered.filter(({ task }) => {
      // Search: case-insensitive match across prompt, id, status
      if (q !== '') {
        const hit =
          task.prompt.toLowerCase().includes(q) ||
          task.id.toLowerCase().includes(q) ||
          task.status.toLowerCase().includes(q)
        if (!hit) return false
      }

      // Event-type multi-select
      if (selectedStatuses.size > 0 && !selectedStatuses.has(task.status))
        return false

      // Time range
      if (cutoff !== null) {
        const ts = new Date(task.createdAt).getTime()
        if (Number.isNaN(ts) || ts < cutoff) return false
      }

      // Task ID exact match
      if (idExact !== '' && task.id !== idExact) return false

      // Severity / cluster multi-select
      if (selectedClusters.size > 0 && !selectedClusters.has(task.cluster))
        return false

      return true
    })
  }, [layered, search, selectedStatuses, timeRange, taskIdFilter, selectedClusters])

  if (error && tasks === null) {
    return (
      <main className="flex min-h-0 flex-1 overflow-hidden bg-bg">
        <ApiErrorPanel error={error} />
      </main>
    )
  }

  return (
    <main className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-auto bg-bg p-4">
      {/* Header */}
      <header className="font-mono text-[11px] uppercase tracking-wide text-iron">
        Events — {layered.length} task{layered.length === 1 ? '' : 's'}
      </header>

      {/* Search bar */}
      <input
        type="text"
        aria-label="Search events"
        placeholder="Search by message, task id, or type…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full rounded border border-iron/30 bg-iron/5 px-3 py-1.5 font-mono text-[12px] text-fg placeholder-iron focus:border-iron/60 focus:outline-none"
      />

      {/* Filter row */}
      <div className="flex flex-wrap items-start gap-4">
        {/* Event type chips */}
        {distinctStatuses.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="self-center font-mono text-[10px] uppercase tracking-wide text-iron">
              Type:
            </span>
            {distinctStatuses.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={selectedStatuses.has(s)}
                onClick={() => toggleStatus(s)}
                className={chipClass(selectedStatuses.has(s))}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Time range */}
        <div className="flex items-center gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wide text-iron">
            Time:
          </span>
          <select
            aria-label="Time range"
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value as TimeRange)}
            className="rounded border border-iron/30 bg-iron/5 px-2 py-0.5 font-mono text-[11px] text-fg focus:border-iron/60 focus:outline-none"
          >
            {TIME_RANGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/* Task ID exact match */}
        <div className="flex items-center gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wide text-iron">
            Task&nbsp;ID:
          </span>
          <input
            type="text"
            aria-label="Filter by task ID"
            placeholder="exact id…"
            value={taskIdFilter}
            onChange={(e) => setTaskIdFilter(e.target.value)}
            className="rounded border border-iron/30 bg-iron/5 px-2 py-0.5 font-mono text-[11px] text-fg placeholder-iron focus:border-iron/60 focus:outline-none"
          />
        </div>

        {/* Severity / cluster chips */}
        {distinctClusters.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="self-center font-mono text-[10px] uppercase tracking-wide text-iron">
              Severity:
            </span>
            {distinctClusters.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={selectedClusters.has(c)}
                onClick={() => toggleCluster(c)}
                className={chipClass(selectedClusters.has(c))}
              >
                {c}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Events list */}
      <ul className="flex flex-col gap-1" data-testid="events-list">
        {filtered.map(({ task, depth }) => (
          <li key={task.id}>
            <a
              href={`#/task/${encodeURIComponent(task.id)}`}
              className="block rounded border border-iron/30 bg-iron/5 px-3 py-2 font-mono text-[12px] text-fg hover:bg-iron/15"
              style={{ marginLeft: `${depth * 24}px` }}
              data-testid={`event-node-${task.id}`}
              data-depth={depth}
            >
              <span className="text-iron">[{task.status}]</span>{' '}
              <span>{titleFromPrompt(task.prompt)}</span>
              {task.blockerTaskId ? (
                <span className="ml-2 text-iron">
                  ↳ blocked by {task.blockerTaskId}
                </span>
              ) : null}
            </a>
          </li>
        ))}

        {/* Empty state */}
        {filtered.length === 0 && layered.length > 0 ? (
          <li
            data-testid="events-empty"
            className="font-mono text-[11px] text-iron"
          >
            No events match the current filters.
          </li>
        ) : filtered.length === 0 && !error ? (
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
