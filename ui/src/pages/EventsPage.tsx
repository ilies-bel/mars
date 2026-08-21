import { memo, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { fetchEvents, type EventsFilter } from '@/shared/api'
import { FallbackSurface } from '@/components/FallbackSurface'
import { SkeletonList } from '@/components/Skeleton'
import { severityColor, severityRowClass, summarizeTraceEvent, marsToolTextClass, humanizeKind, humanizePhase, traceEventTaskId } from '@/shared/actionQueueDetail'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import type { TraceEvent } from '@/shared/schemas'
import { relativeTime, formatRelativeAge } from '@/shared/time'
import { taskHash } from '@/shared/routing'
import { groupByArc, type ArcGroup, type TaskGroup, type StepGroup } from '@/shared/groupTraceEvents'
import { PageHeader } from '@/widgets/primitives/DensityPrimitives'

/**
 * Events tab — the unified trace stream.
 *
 * Repurposed from the prior "topology-rendered-as-events" page: the rows are
 * now real trace events from the daemon's `/events` endpoint (proxied as
 * `/api/trace-events`), not task records pretending to be events. Filters
 * mirror the endpoint's filter surface. Newest-first, cursor-paginated
 * `Load more`. Rows reuse the same summary helpers as the actionQueue detail
 * panel's Traces section so the two surfaces stay visually consistent.
 *
 * Manual refresh only — no SSE, no polling in this slice. The Refresh
 * button re-runs the active query.
 */

// ---------------------------------------------------------------------------
// Filter vocabulary
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

const sinceFromRange = (range: TimeRange, now = Date.now()): string | undefined =>
  range === 'all' ? undefined : new Date(now - TIME_RANGE_MS[range]).toISOString()

/** Closed vocabulary — must stay in sync with the daemon's TRACE_EVENT_KINDS. */
const KIND_OPTIONS = [
  'origin.created',
  'step_started',
  'step_ended',
  'tool_invoked',
  'task.blocked',
  'recovery.spawned',
  'task.failed',
  'log_line',
  'cli-invocation',
] as const
type Kind = (typeof KIND_OPTIONS)[number]

const SEVERITY_OPTIONS = ['info', 'warn', 'error'] as const
type Severity = (typeof SEVERITY_OPTIONS)[number]

/**
 * Phase options surface a synthetic `(n/a)` entry so the operator can
 * include events with no phase (e.g. `origin.created`) without having to
 * leave the filter unset. The synthetic value never reaches the endpoint;
 * we just omit it when normalising to the wire filter — and when ALL real
 * phases are selected alongside it, that matches the unfiltered default,
 * so we drop the phase filter entirely.
 */
const PHASE_OPTIONS = ['setup', 'code', 'verify', 'merge', '(n/a)'] as const
type Phase = (typeof PHASE_OPTIONS)[number]

// ---------------------------------------------------------------------------
// Filter state → wire filter
// ---------------------------------------------------------------------------

interface FilterState {
  range: TimeRange
  severities: ReadonlySet<Severity>
  kinds: ReadonlySet<Kind>
  phases: ReadonlySet<Phase>
  taskId: string
  originId: string
  q: string
}

const ALL_SEVERITIES: ReadonlySet<Severity> = new Set(SEVERITY_OPTIONS)
const ALL_KINDS: ReadonlySet<Kind> = new Set(KIND_OPTIONS)
const ALL_PHASES: ReadonlySet<Phase> = new Set(PHASE_OPTIONS)

/** Kinds enabled by default: all except cli-invocation (statusline polls are diagnostics, not operator events). */
const DEFAULT_KINDS: ReadonlySet<Kind> = new Set(
  KIND_OPTIONS.filter((k): k is Kind => k !== 'cli-invocation'),
)

const initialFilterState = (): FilterState => ({
  range: 'all',
  // Default to WARN+ERROR so INFO noise is hidden until explicitly enabled.
  severities: new Set(['warn', 'error'] as const),
  kinds: new Set(DEFAULT_KINDS),
  phases: new Set(PHASE_OPTIONS),
  taskId: '',
  originId: '',
  q: '',
})

/**
 * Build the wire-shape filter. Omits a multi-select entirely when every
 * option is selected (the endpoint treats absence as "no constraint").
 * The synthetic `(n/a)` phase is dropped before reaching the wire — we
 * can't ask the daemon for "events with no phase" today, so when the
 * operator deselects every real phase but keeps `(n/a)` we still send no
 * phase filter and rely on local rendering for the rest.
 */
const toWireFilter = (
  state: FilterState,
  cursor: string | null,
  limit: number,
): EventsFilter => {
  const filter: EventsFilter = { limit }
  const since = sinceFromRange(state.range)
  if (since !== undefined) filter.since = since
  if (state.severities.size > 0 && state.severities.size < SEVERITY_OPTIONS.length) {
    filter.severity = [...state.severities]
  }
  if (state.kinds.size > 0 && state.kinds.size < KIND_OPTIONS.length) {
    filter.kind = [...state.kinds]
  }
  const realPhases = [...state.phases].filter((p): p is Exclude<Phase, '(n/a)'> =>
    p !== '(n/a)',
  )
  // Drop the phase filter when every real phase is selected; otherwise pass
  // only the real phases (the synthetic `(n/a)` filter is local-only).
  if (
    realPhases.length > 0 &&
    realPhases.length < PHASE_OPTIONS.length - 1
  ) {
    filter.phase = realPhases
  }
  const taskId = state.taskId.trim()
  if (taskId !== '') filter.taskId = taskId
  const originId = state.originId.trim()
  if (originId !== '') filter.originId = originId
  const q = state.q.trim()
  if (q !== '') filter.q = q
  if (cursor !== null) filter.cursor = cursor
  return filter
}

/**
 * Locally honour the synthetic `(n/a)` phase option: hide events whose
 * phase column we don't want to see. The daemon can't filter on "phase is
 * null" today, so we always fetch the broadest matching set and trim
 * here. Cheap because pages are bounded by `limit`.
 */
const applyLocalPhaseFilter = (
  events: readonly TraceEvent[],
  phases: ReadonlySet<Phase>,
): TraceEvent[] => {
  if (phases.size === PHASE_OPTIONS.length) return [...events]
  return events.filter((e) => {
    if (e.phase === null) return phases.has('(n/a)')
    return phases.has(e.phase as Phase)
  })
}

// ---------------------------------------------------------------------------
// Filter UI primitives
// ---------------------------------------------------------------------------

const chipClass = (active: boolean): string =>
  [
    'rounded border px-2 py-0.5 font-mono text-micro uppercase tracking-wide transition-colors',
    active
      ? 'border-primary bg-primary/15 font-semibold text-foreground'
      : 'border-dashed border-border/50 bg-transparent text-muted-foreground/60 hover:border-primary/40 hover:text-muted-foreground',
  ].join(' ')

interface MultiSelectProps<T extends string> {
  label: string
  options: readonly T[]
  selected: ReadonlySet<T>
  onToggle: (value: T) => void
  testId: string
  displayLabel?: (value: T) => string
}

const MultiSelect = <T extends string>({
  label,
  options,
  selected,
  onToggle,
  testId,
  displayLabel,
}: MultiSelectProps<T>) => (
  <div className="flex flex-wrap items-center gap-1" data-testid={testId}>
    <span className="self-center font-mono text-micro uppercase tracking-wide text-muted-foreground/60">
      {label}:
    </span>
    {options.map((opt) => {
      const active = selected.has(opt)
      return (
        <button
          key={opt}
          type="button"
          aria-pressed={active}
          onClick={() => onToggle(opt)}
          className={chipClass(active)}
          data-testid={`${testId}-${opt}`}
        >
          {displayLabel ? displayLabel(opt) : opt}
        </button>
      )
    })}
  </div>
)

// ---------------------------------------------------------------------------
// Row render
// ---------------------------------------------------------------------------

const truncateId = (id: string): string =>
  id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-3)}` : id

interface EventRowProps {
  event: TraceEvent
  /** Current epoch-ms used for relative timestamp computation — updated every 30s. */
  now: number
  /** Whether this row's extended fields panel is open. Owned by the page-level Set. */
  fieldsExpanded: boolean
  /** Toggle this row's expanded state. Stable reference from the page. */
  onToggleFields: (eventId: string) => void
}

const EventRow = memo(({ event, now, fieldsExpanded, onToggleFields }: EventRowProps) => {
  const toggleFields = useCallback(() => onToggleFields(event.id), [onToggleFields, event.id])

  const stepName =
    (event.kind === 'step_started' || event.kind === 'step_ended') &&
    typeof event.payload.stepName === 'string'
      ? event.payload.stepName
      : undefined
  // Most kinds carry taskId on the envelope; the workflow engine's own
  // log_line events (run.failed/step.failed) only carry it inside
  // payload.fields.runId — traceEventTaskId normalises both so every row
  // that has an identifiable task shows its chip, not just the ones the
  // daemon happened to tag at the envelope level.
  const effectiveTaskId = traceEventTaskId(event)
  const href = effectiveTaskId
    ? taskHash(effectiveTaskId, 'events', stepName)
    : undefined

  const logLineSource =
    event.kind === 'log_line' && typeof event.payload.source === 'string'
      ? event.payload.source
      : null

  const callerSource = (() => {
    const p = event.payload
    if (typeof p.workerName === 'string') return p.workerName
    if (typeof p.source === 'string' && event.kind !== 'log_line') return p.source
    if (typeof p.originSessionId === 'string') {
      return `session ${(p.originSessionId as string).slice(0, 6)}`
    }
    return null
  })()
  const logLineFields =
    event.kind === 'log_line' &&
    event.payload.fields !== null &&
    event.payload.fields !== undefined &&
    typeof event.payload.fields === 'object'
      ? (event.payload.fields as Record<string, unknown>)
      : null
  const hasFields = logLineFields !== null && Object.keys(logLineFields).length > 0

  const body = (
    <>
      <div className="grid items-baseline gap-x-2" style={{ gridTemplateColumns: '4.5rem 2.5rem 4rem 6rem auto' }}>
        <span className="truncate text-muted-foreground">{relativeTime(event.timestamp, now)}</span>
        <span
          className={`font-mono text-micro uppercase ${event.severity !== 'info' ? 'font-semibold ' : ''}${severityColor(event.severity)}`}
        >
          {event.severity}
        </span>
        <span className="truncate rounded bg-primary/10 px-1 text-center font-mono text-micro text-primary">{humanizeKind(event.kind)}</span>
        <span className="truncate font-mono text-micro text-muted-foreground">
          {callerSource ?? ''}
          {event.phase ? ` · ${humanizePhase(event.phase)}` : ''}
        </span>
        <div className="flex min-w-0 items-baseline gap-x-1">
          {effectiveTaskId ? (
            <a
              href={taskHash(effectiveTaskId, 'events')}
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 font-mono text-micro text-muted-foreground hover:text-foreground hover:underline"
            >
              {truncateId(effectiveTaskId)}
            </a>
          ) : null}
          {logLineSource && logLineSource !== callerSource ? (
            <span
              className="shrink-0 rounded bg-primary/20 px-1 font-mono text-micro text-muted-foreground"
              data-testid={`event-row-source-${event.id}`}
            >
              {logLineSource}
            </span>
          ) : null}
          <span className={`min-w-0 truncate ${marsToolTextClass(event)}`}>
            {summarizeTraceEvent(event)}
          </span>
          {hasFields ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                toggleFields()
              }}
              className="-my-1 inline-flex min-h-[24px] shrink-0 items-center px-2 py-1 font-mono text-micro text-muted-foreground underline hover:text-primary"
              data-testid={`event-row-fields-toggle-${event.id}`}
            >
              {fieldsExpanded ? 'hide fields' : 'fields'}
            </button>
          ) : null}
        </div>
      </div>
      {fieldsExpanded && logLineFields ? (
        <pre
          className="mt-1 max-w-full overflow-x-auto font-mono text-micro text-muted-foreground"
          data-testid={`event-row-fields-${event.id}`}
        >
          {JSON.stringify(logLineFields, null, 2)}
        </pre>
      ) : null}
    </>
  )
  if (href === undefined) {
    return (
      <div
        className={`block rounded border ${severityRowClass(event.severity)} px-3 py-1.5 font-mono text-body text-foreground`}
        data-testid={`event-row-${event.id}`}
      >
        {body}
      </div>
    )
  }
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => {
        window.location.hash = href
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || e.target !== e.currentTarget) return
        e.preventDefault()
        window.location.hash = href
      }}
      className={`block cursor-pointer rounded border ${severityRowClass(event.severity)} px-3 py-1.5 font-mono text-body text-foreground hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
      data-testid={`event-row-${event.id}`}
    >
      {body}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Run-length grouping — collapses consecutive identical-payload events
// ---------------------------------------------------------------------------

type EventListRow =
  | { type: 'single'; event: TraceEvent }
  | { type: 'group'; events: TraceEvent[] }
  /** Consecutive tool_invoked INFO events from the same task, ≥2 events. */
  | { type: 'tool-group'; events: TraceEvent[] }
  /** Consecutive workflow-engine rows (run/step/agent) for one incident, ≥2 events. */
  | { type: 'incident'; events: TraceEvent[] }

/**
 * True for the event shapes that make up a "workflow incident": the
 * workflow engine's own `run.failed`/`step.failed` log lines, and the
 * `step_ended` row (outcome `failed`/`killed`) for the worker step that
 * caused them. These are the three rows one failure produces — see
 * `traceEventTaskId` for why they don't already share a `taskId` column.
 * Deliberately narrow (not "any non-info event"): task.failed, tool_invoked
 * errors, and other WARN/ERROR kinds are real standalone incidents in their
 * own right and must not be folded together just for sharing a task.
 */
const isIncidentEvent = (e: TraceEvent): boolean => {
  if (e.severity === 'info') return false
  if (e.kind === 'log_line') return e.payload.source === 'workflow'
  return e.kind === 'step_ended'
}

/**
 * Collapse consecutive events into grouped rows.
 *
 * Three grouping criteria (checked in priority order):
 *
 * 1. **Tool-call noise reduction** — consecutive `tool_invoked` INFO events
 *    from the same task (same taskId, ≥2) are collapsed into a `tool-group`
 *    row showing "N tool calls · Xs". Renders as an expandable row.
 *
 * 2. **Incident grouping** — consecutive workflow-incident rows (see
 *    `isIncidentEvent`) sharing the same effective task id (via
 *    `traceEventTaskId`, ≥2) are collapsed into an `incident` row. This is
 *    the run/step/agent triple one failure emits — one incident, one row.
 *
 * 3. **Identical-payload dedup** — other consecutive events whose payload
 *    serialises to the same JSON string are collapsed into a `group` row.
 *    Groups require at least 2 events; a run of 1 is always `single`.
 */
const groupConsecutiveEvents = (events: readonly TraceEvent[]): EventListRow[] => {
  const rows: EventListRow[] = []
  let i = 0
  while (i < events.length) {
    const e = events[i]

    // Tool-call noise reduction: consecutive tool_invoked INFO from same task
    if (e.kind === 'tool_invoked' && e.severity === 'info' && e.taskId !== null) {
      let j = i + 1
      while (
        j < events.length &&
        events[j].kind === 'tool_invoked' &&
        events[j].severity === 'info' &&
        events[j].taskId === e.taskId
      ) j++
      if (j - i >= 2) {
        rows.push({ type: 'tool-group', events: events.slice(i, j) })
        i = j
        continue
      }
    }

    // Incident grouping: fold the run/step/agent rows of one failure into
    // one row instead of three.
    if (isIncidentEvent(e)) {
      const incidentId = traceEventTaskId(e)
      if (incidentId !== null) {
        let j = i + 1
        while (
          j < events.length &&
          isIncidentEvent(events[j]) &&
          traceEventTaskId(events[j]) === incidentId
        ) j++
        if (j - i >= 2) {
          rows.push({ type: 'incident', events: events.slice(i, j) })
          i = j
          continue
        }
      }
    }

    // Identical-payload grouping
    const key = JSON.stringify(e.payload)
    let j = i + 1
    while (j < events.length && JSON.stringify(events[j].payload) === key) j++
    if (j - i === 1) {
      rows.push({ type: 'single', event: e })
    } else {
      rows.push({ type: 'group', events: events.slice(i, j) })
    }
    i = j
  }
  return rows
}

interface GroupedRowProps {
  events: TraceEvent[]
  /** Stable group identity — the first event's id. */
  groupId: string
  expanded: boolean
  /** Stable callback; called with groupId. */
  onToggleGroup: (groupId: string) => void
  now: number
  fieldsExpandedSet: Set<string>
  onToggleFields: (eventId: string) => void
}

/** Collapsed/expanded row for a run of consecutive identical-payload events. */
const GroupedRow = memo(({
  events,
  groupId,
  expanded,
  onToggleGroup,
  now,
  fieldsExpandedSet,
  onToggleFields,
}: GroupedRowProps) => {
  const handleToggle = useCallback(() => onToggleGroup(groupId), [onToggleGroup, groupId])
  const first = events[0]
  const last = events[events.length - 1]

  if (expanded) {
    return (
      <div>
        <button
          type="button"
          onClick={handleToggle}
          className="mb-1 flex w-full items-center gap-2 rounded border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-micro text-primary hover:text-foreground"
          data-testid={`group-row-${first.id}`}
        >
          <span>▾</span>
          <span className="rounded bg-primary/20 px-1 font-semibold">×{events.length}</span>
          <span className="text-muted-foreground">{relativeTime(first.timestamp, now)} – {relativeTime(last.timestamp, now)}</span>
          <span className="min-w-0 truncate">{summarizeTraceEvent(first)}</span>
        </button>
        <div className="flex flex-col gap-1">
          {events.map((e) => (
            <EventRow
              key={e.id}
              event={e}
              now={now}
              fieldsExpanded={fieldsExpandedSet.has(e.id)}
              onToggleFields={onToggleFields}
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={handleToggle}
      className="flex w-full items-center gap-2 rounded border border-primary/20 bg-primary/5 px-3 py-1.5 font-mono text-body text-foreground hover:bg-primary/15"
      data-testid={`group-row-${first.id}`}
    >
      <span className="shrink-0 text-micro text-muted-foreground">{relativeTime(first.timestamp, now)}</span>
      <span className="shrink-0 text-micro text-muted-foreground">–</span>
      <span className="shrink-0 text-micro text-muted-foreground">{relativeTime(last.timestamp, now)}</span>
      <span className="shrink-0 rounded bg-primary/20 px-1.5 font-mono text-micro font-semibold text-primary">×{events.length}</span>
      <span className="min-w-0 truncate text-label text-muted-foreground">{summarizeTraceEvent(first)}</span>
    </button>
  )
})

// ---------------------------------------------------------------------------
// Incident group row — collapses the run/step/agent rows of one workflow
// failure into a single expandable row.
// ---------------------------------------------------------------------------

/**
 * Pick the most informative event in an incident to summarize the collapsed
 * row: the `step_ended` row reads as a full sentence ("run-agent step
 * killed"); failing that, prefer a `log_line` that carries an `err` detail
 * (see `summarizeTraceEvent`'s log_line branch); otherwise fall back to the
 * first event chronologically in the run.
 */
const incidentSummary = (events: TraceEvent[]): string => {
  const stepEnded = events.find((e) => e.kind === 'step_ended')
  if (stepEnded) return summarizeTraceEvent(stepEnded)
  const withErr = events.find((e) => {
    const fields = e.payload.fields
    return (
      e.kind === 'log_line' &&
      typeof fields === 'object' &&
      fields !== null &&
      typeof (fields as Record<string, unknown>).err === 'string'
    )
  })
  return summarizeTraceEvent(withErr ?? events[0])
}

const worstSeverityOf = (events: TraceEvent[]): TraceEvent['severity'] =>
  events.some((e) => e.severity === 'error')
    ? 'error'
    : events.some((e) => e.severity === 'warn')
      ? 'warn'
      : 'info'

interface IncidentGroupProps {
  events: TraceEvent[]
  groupId: string
  expanded: boolean
  onToggleGroup: (groupId: string) => void
  now: number
  fieldsExpandedSet: Set<string>
  onToggleFields: (eventId: string) => void
}

/** Collapsed/expanded row for the run/step/agent rows of one workflow incident. */
const IncidentGroup = memo(({
  events,
  groupId,
  expanded,
  onToggleGroup,
  now,
  fieldsExpandedSet,
  onToggleFields,
}: IncidentGroupProps) => {
  const handleToggle = useCallback(() => onToggleGroup(groupId), [onToggleGroup, groupId])
  const first = events[0]
  const worst = worstSeverityOf(events)
  const taskId = traceEventTaskId(first)
  const summary = incidentSummary(events)

  if (expanded) {
    return (
      <div>
        <button
          type="button"
          onClick={handleToggle}
          className={`mb-1 flex w-full items-center gap-2 rounded border px-3 py-1 font-mono text-micro hover:text-foreground ${severityRowClass(worst)}`}
          data-testid={`incident-group-row-${first.id}`}
        >
          <span>▾</span>
          <span className={`uppercase font-semibold ${severityColor(worst)}`}>{worst}</span>
          <span className="rounded bg-primary/20 px-1 font-semibold">×{events.length}</span>
          {taskId ? <span className="text-muted-foreground">{truncateId(taskId)}</span> : null}
          <span className="min-w-0 truncate">{summary}</span>
        </button>
        <div className="flex flex-col gap-1">
          {events.map((e) => (
            <EventRow
              key={e.id}
              event={e}
              now={now}
              fieldsExpanded={fieldsExpandedSet.has(e.id)}
              onToggleFields={onToggleFields}
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={handleToggle}
      className={`flex w-full items-center gap-2 rounded border px-3 py-1.5 font-mono text-body hover:bg-primary/15 ${severityRowClass(worst)}`}
      data-testid={`incident-group-row-${first.id}`}
    >
      <span className="shrink-0 text-micro text-muted-foreground">{relativeTime(first.timestamp, now)}</span>
      <span className={`shrink-0 text-micro font-semibold uppercase ${severityColor(worst)}`}>{worst}</span>
      <span className="shrink-0 rounded bg-primary/20 px-1.5 font-mono text-micro font-semibold text-primary">×{events.length}</span>
      {taskId ? (
        <span className="shrink-0 font-mono text-micro text-muted-foreground">{truncateId(taskId)}</span>
      ) : null}
      <span className="min-w-0 truncate text-label text-muted-foreground">{summary}</span>
    </button>
  )
})

// ---------------------------------------------------------------------------
// Tool-call group row — collapses consecutive tool_invoked INFO events
// ---------------------------------------------------------------------------

const formatToolDuration = (ms: number): string => {
  const totalS = Math.round(ms / 1000)
  if (totalS < 60) return `${totalS}s`
  const m = Math.floor(totalS / 60)
  const s = totalS % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

interface ToolCallGroupProps {
  events: TraceEvent[]
  groupId: string
  expanded: boolean
  onToggleGroup: (groupId: string) => void
  now: number
  fieldsExpandedSet: Set<string>
  onToggleFields: (eventId: string) => void
}

/**
 * Collapsed/expanded row for a run of consecutive tool_invoked INFO events
 * from the same task. Collapsed state shows "N tool calls · Xs"; click to
 * expand and see the individual rows.
 */
const ToolCallGroup = memo(({
  events,
  groupId,
  expanded,
  onToggleGroup,
  now,
  fieldsExpandedSet,
  onToggleFields,
}: ToolCallGroupProps) => {
  const handleToggle = useCallback(() => onToggleGroup(groupId), [onToggleGroup, groupId])
  const first = events[0]
  const last = events[events.length - 1]
  const durationMs = last.timestamp - first.timestamp
  const label = `${events.length} tool call${events.length !== 1 ? 's' : ''} · ${formatToolDuration(durationMs)}`

  if (expanded) {
    return (
      <div>
        <button
          type="button"
          onClick={handleToggle}
          className="mb-1 flex w-full items-center gap-2 rounded border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-micro text-primary hover:text-foreground"
          data-testid={`tool-group-row-${first.id}`}
        >
          <span>▾</span>
          <span>{label}</span>
          <span className="text-muted-foreground">{relativeTime(first.timestamp, now)}</span>
        </button>
        <div className="flex flex-col gap-1">
          {events.map((e) => (
            <EventRow
              key={e.id}
              event={e}
              now={now}
              fieldsExpanded={fieldsExpandedSet.has(e.id)}
              onToggleFields={onToggleFields}
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={handleToggle}
      className="flex w-full items-center gap-2 rounded border border-primary/20 bg-primary/5 px-3 py-1.5 font-mono text-body text-muted-foreground hover:bg-primary/15"
      data-testid={`tool-group-row-${first.id}`}
    >
      <span className="shrink-0 text-micro">{relativeTime(first.timestamp, now)}</span>
      <span className="min-w-0 truncate text-label font-medium text-foreground">{label}</span>
    </button>
  )
})

// ---------------------------------------------------------------------------
// Timeline view components
// ---------------------------------------------------------------------------

type EventsViewMode = 'flat' | 'timeline'

const arcSeverityBorder = (severity: TraceEvent['severity']): string => {
  if (severity === 'error') return 'border-l-error/60'
  if (severity === 'warn') return 'border-l-warn/60'
  return 'border-l-success/60'
}

const arcSeverityBg = (severity: TraceEvent['severity']): string => {
  if (severity === 'error') return 'bg-error/[0.03]'
  if (severity === 'warn') return 'bg-warn/[0.03]'
  return 'bg-card'
}

interface TimelineStepProps {
  group: StepGroup
  now: number
}

const TimelineStep = ({ group, now }: TimelineStepProps) => {
  const [expanded, setExpanded] = useState(false)
  const stepName =
    typeof group.step.payload.stepName === 'string'
      ? group.step.payload.stepName
      : '(step)'
  const outcome = group.endEvent
    ? typeof group.endEvent.payload.outcome === 'string'
      ? group.endEvent.payload.outcome
      : 'ended'
    : 'running'
  const outcomeClass =
    outcome === 'completed'
      ? 'text-success'
      : outcome === 'failed' || outcome === 'failure'
        ? 'text-error'
        : outcome === 'running'
          ? 'text-warn'
          : 'text-muted-foreground'

  return (
    <div className="ml-4">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 py-0.5 text-left font-mono text-label"
      >
        <span className="shrink-0 text-micro text-muted-foreground">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="font-semibold text-foreground">{stepName}</span>
        <span className={`text-micro ${outcomeClass}`}>{outcome}</span>
        <span className="text-micro text-muted-foreground">
          {relativeTime(group.step.timestamp, now)}
        </span>
        {group.tools.length > 0 && (
          <span className="text-micro text-muted-foreground">
            ({group.tools.length} tool call{group.tools.length !== 1 ? 's' : ''})
          </span>
        )}
      </button>
      {expanded && group.tools.length > 0 && (
        <div className="ml-5 border-l border-primary/20 pl-2">
          {group.tools.map((tool) => (
            <div
              key={tool.id}
              className="flex items-baseline gap-1 py-0.5 font-mono text-micro"
            >
              <span className="shrink-0 text-muted-foreground">
                {relativeTime(tool.timestamp, now)}
              </span>
              <span
                className={`${severityColor(tool.severity)} ${marsToolTextClass(tool)}`}
              >
                {summarizeTraceEvent(tool)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface TimelineTaskGroupProps {
  group: TaskGroup
  now: number
}

const TimelineTaskGroup = ({ group, now }: TimelineTaskGroupProps) => {
  const [expanded, setExpanded] = useState(true)
  const nonStepEvents = group.events.filter(
    (e) =>
      e.kind !== 'step_started' &&
      e.kind !== 'step_ended' &&
      e.kind !== 'tool_invoked',
  )

  return (
    <div className="border-l-2 border-primary/20 pl-3">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 py-1 text-left"
      >
        <span className="font-mono text-micro text-muted-foreground">
          {expanded ? '▾' : '▸'}
        </span>
        <a
          href={taskHash(group.taskId, 'events')}
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-label text-foreground hover:underline"
        >
          {group.taskId.length > 16
            ? `${group.taskId.slice(0, 8)}…${group.taskId.slice(-4)}`
            : group.taskId}
        </a>
        <span
          className={`rounded px-1 py-0.5 font-mono text-micro uppercase ${
            group.severity === 'error'
              ? 'bg-error/10 text-error'
              : group.severity === 'warn'
                ? 'bg-warn/10 text-warn'
                : 'bg-primary/10 text-muted-foreground'
          }`}
        >
          {group.severity}
        </span>
        <span className="font-mono text-micro text-muted-foreground">
          {group.events.length} event{group.events.length !== 1 ? 's' : ''}
          {group.steps.length > 0 &&
            ` · ${group.steps.length} step${group.steps.length !== 1 ? 's' : ''}`}
        </span>
      </button>
      {expanded && (
        <div className="flex flex-col gap-0.5 pb-1">
          {/* Non-step events (task.failed, task.blocked, recovery.spawned, etc.) */}
          {nonStepEvents.map((e) => (
            <div
              key={e.id}
              className={`ml-2 flex items-baseline gap-1 rounded border px-2 py-0.5 font-mono text-micro ${severityRowClass(e.severity)}`}
            >
              <span className="shrink-0 text-muted-foreground">
                {relativeTime(e.timestamp, now)}
              </span>
              <span className={`shrink-0 text-micro uppercase ${severityColor(e.severity)}`}>
                {humanizeKind(e.kind)}
              </span>
              <span className={marsToolTextClass(e)}>
                {summarizeTraceEvent(e)}
              </span>
            </div>
          ))}
          {/* Step groups with nested tool calls */}
          {group.steps.map((sg) => (
            <TimelineStep key={sg.step.id} group={sg} now={now} />
          ))}
        </div>
      )}
    </div>
  )
}

interface TimelineArcGroupProps {
  group: ArcGroup
  now: number
}

const TimelineArcGroup = ({ group, now }: TimelineArcGroupProps) => {
  const [expanded, setExpanded] = useState(true)

  return (
    <div
      className={`rounded border-l-4 ${arcSeverityBorder(group.severity)} ${arcSeverityBg(group.severity)} p-2`}
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="font-mono text-micro text-muted-foreground">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="font-mono text-label font-semibold text-foreground">
          Arc{' '}
          {group.arcId === '__unlinked__'
            ? '(unlinked)'
            : group.arcId.length > 16
              ? `${group.arcId.slice(0, 8)}…${group.arcId.slice(-4)}`
              : group.arcId}
        </span>
        <span
          className={`rounded px-1.5 py-0.5 font-mono text-micro uppercase ${
            group.severity === 'error'
              ? 'bg-error/10 text-error'
              : group.severity === 'warn'
                ? 'bg-warn/10 text-warn'
                : 'bg-success/10 text-success'
          }`}
        >
          {group.severity === 'error'
            ? 'failed'
            : group.severity === 'warn'
              ? 'warning'
              : 'ok'}
        </span>
        <span className="font-mono text-micro text-muted-foreground">
          {group.taskGroups.length} task
          {group.taskGroups.length !== 1 ? 's' : ''}
        </span>
        <span className="ml-auto font-mono text-micro text-muted-foreground">
          {relativeTime(group.firstTimestamp, now)}
          {group.firstTimestamp !== group.lastTimestamp &&
            ` — ${relativeTime(group.lastTimestamp, now)}`}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 flex flex-col gap-1">
          {group.taskGroups.map((tg) => (
            <TimelineTaskGroup key={tg.taskId} group={tg} now={now} />
          ))}
        </div>
      )}
    </div>
  )
}

interface TimelineViewProps {
  events: TraceEvent[]
  now: number
}

const TimelineView = ({ events, now }: TimelineViewProps) => {
  const arcGroups = useMemo(() => groupByArc(events), [events])

  if (arcGroups.length === 0) {
    return (
      <div data-testid="events-empty" className="font-mono text-label text-primary">
        No events match these filters.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {arcGroups.map((ag) => (
        <TimelineArcGroup key={ag.arcId} group={ag} now={now} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const PAGE_LIMIT = 100

export const EventsPage = () => {
  const [state, setState] = useState<FilterState>(initialFilterState)
  const [viewMode, setViewMode] = useState<EventsViewMode>('flat')
  const [extraPages, setExtraPages] = useState<TraceEvent[][]>([])
  /** Whether the secondary filter panel (kind/phase/id/time) is visible. */
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [overrideCursor, setOverrideCursor] = useState<
    string | null | undefined
  >(undefined)
  const projectId = useFocusedProjectId()

  // Page-level expansion Set — keyed by event id so virtualizer row recycling
  // (unmount → re-mount) re-receives the stored entry and stays expanded.
  const [fieldsExpandedSet, setFieldsExpandedSet] = useState<Set<string>>(
    () => new Set(),
  )
  const toggleFieldsExpanded = useCallback((eventId: string) => {
    setFieldsExpandedSet((prev) => {
      const next = new Set(prev)
      if (next.has(eventId)) next.delete(eventId)
      else next.add(eventId)
      return next
    })
  }, [])

  // Page-level expansion Set for grouped rows — keyed by first event id of the
  // group. Lifted out of the GroupedRow component so virtualizer row recycling
  // (unmount → re-mount) preserves the expanded state.
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(
    () => new Set(),
  )
  const toggleGroupExpanded = useCallback((groupId: string) => {
    setExpandedGroupIds((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

  // Debounced text filter values — the query key uses these so that rapid
  // typing (taskId / originId / q) fires at most one request per 300 ms
  // burst rather than one request per keystroke.
  const [debouncedText, setDebouncedText] = useState({
    taskId: state.taskId,
    originId: state.originId,
    q: state.q,
  })
  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedText({
        taskId: state.taskId,
        originId: state.originId,
        q: state.q,
      })
    }, 300)
    return () => clearTimeout(id)
  }, [state.taskId, state.originId, state.q])

  // The query key folds in every filter so a filter change forces a
  // refetch (and resets pagination via the `useMemo` reset below).
  // Text filters (taskId / originId / q) use the debounced snapshot to
  // avoid a fetch on every keystroke.
  const queryKey = useMemo(
    () => [
      'events-page',
      projectId,
      state.range,
      [...state.severities].sort(),
      [...state.kinds].sort(),
      [...state.phases].sort(),
      debouncedText.taskId.trim(),
      debouncedText.originId.trim(),
      debouncedText.q.trim(),
    ],
    [state.range, state.severities, state.kinds, state.phases, debouncedText, projectId],
  )

  const initial = useQuery({
    queryKey,
    queryFn: () => fetchEvents(toWireFilter(state, null, PAGE_LIMIT), projectId ?? undefined),
    enabled: projectId !== null,
    // Auto-refetch every 30s so the stream doesn't silently go stale.
    refetchInterval: 30_000,
    // Keep the previous page's data visible while the new query loads after a
    // filter change. This prevents the "Loading events…" flash on each filter
    // change keystroke — the list stays rendered until fresh data arrives.
    placeholderData: keepPreviousData,
  })

  // Reset the paginated tail whenever the underlying filter set changes.
  // Using a memo-derived key avoids a useEffect.
  const filterKey = useMemo(
    () => JSON.stringify(queryKey),
    [queryKey],
  )
  const [resetKey, setResetKey] = useState(filterKey)
  if (resetKey !== filterKey) {
    setResetKey(filterKey)
    if (extraPages.length > 0) setExtraPages([])
    if (overrideCursor !== undefined) setOverrideCursor(undefined)
  }

  const more = useMutation({
    mutationFn: async (cursor: string) =>
      fetchEvents(toWireFilter(state, cursor, PAGE_LIMIT), projectId ?? undefined),
    onSuccess: (res) => {
      setExtraPages((p) => [...p, res.events])
      setOverrideCursor(res.nextCursor)
    },
  })

  // Derive the event list before hooks that depend on it (hooks must all
  // come before any conditional return).
  const rawEvents = initial.data
    ? [initial.data.events, ...extraPages].flat()
    : []
  const events = applyLocalPhaseFilter(rawEvents, state.phases)
  const nextCursor =
    overrideCursor === undefined
      ? (initial.data?.nextCursor ?? null)
      : overrideCursor

  // Collapse runs of consecutive identical-payload events into grouped rows.
  // Individual events and groups with distinct payloads stay as single rows.
  const groupedRows = useMemo(() => groupConsecutiveEvents(events), [events])

  // Virtual list for the events stream (100+ items per page, multiple pages possible).
  // scrollRef and virtualizer are declared here — before the conditional early
  // return — to satisfy the rules of hooks.
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: groupedRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 45,
    overscan: 5,
    // initialRect ensures items render during SSR (renderToStaticMarkup in tests)
    // where scrollRef.current is null and no ResizeObserver fires.
    initialRect: { width: 0, height: 4000 },
  })

  // Clock tick — forces a re-render every 30s so relative timestamps in event
  // rows and the "fetched … ago" chip in the header don't silently go stale
  // between auto-refetches.
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // "fetched just now" / "fetched 2m" / … chip text. Only shown once the
  // first successful fetch has completed (dataUpdatedAt is 0 beforehand).
  const fetchedAt =
    initial.dataUpdatedAt > 0
      ? `fetched ${formatRelativeAge(now - initial.dataUpdatedAt)}`
      : null

  // --- filter mutators ---
  const toggleIn = <T extends string>(
    key: 'severities' | 'kinds' | 'phases',
    value: T,
  ): void =>
    setState((prev) => {
      const next = new Set(
        prev[key] as ReadonlySet<string>,
      ) as Set<string>
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return { ...prev, [key]: next as ReadonlySet<unknown> } as FilterState
    })

  const onRefresh = (): void => {
    setExtraPages([])
    setOverrideCursor(undefined)
    void initial.refetch()
  }

  if (initial.isError && !initial.data) {
    return (
      <main className="flex min-h-0 flex-1 overflow-hidden bg-background">
        <FallbackSurface error={initial.error} of="events stream" variant="pane" />
      </main>
    )
  }

  return (
    <main className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden bg-background p-4">
      {/* Header — fixed above the scrollable list */}
      <PageHeader
        title={`Events — ${events.length} event${events.length === 1 ? '' : 's'}`}
        right={
          <div className="flex items-center gap-1">
            {(['flat', 'timeline'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                data-testid={`events-view-${mode}`}
                className={[
                  'rounded px-2 py-0.5 font-mono text-micro uppercase tracking-wide transition-colors',
                  viewMode === mode
                    ? 'bg-primary/30 text-foreground'
                    : 'text-primary hover:text-foreground',
                ].join(' ')}
              >
                {mode}
              </button>
            ))}
            <button
              type="button"
              onClick={onRefresh}
              disabled={initial.isFetching}
              data-testid="events-refresh"
              className="rounded border border-primary/40 px-2 py-0.5 font-mono text-micro uppercase tracking-wide text-foreground hover:bg-primary/15 disabled:opacity-50"
            >
              {initial.isFetching ? 'Refreshing…' : 'Refresh'}
            </button>
            {fetchedAt !== null ? (
              <span
                data-testid="events-fetched-at"
                className="font-mono text-micro text-muted-foreground"
              >
                {fetchedAt}
              </span>
            ) : null}
          </div>
        }
      />

      {/* Filter bar — one primary row: severity + search + "Filters" toggle.
          Secondary panel (kind/phase/time/id) lives below, revealed on demand.
          All filter controls remain in the DOM even when the panel is hidden so
          tests and keyboard access work regardless of panel state. */}
      <div className="flex flex-col gap-1.5">
        {/* Primary row */}
        <div className="flex flex-wrap items-center gap-2">
          <MultiSelect
            label="Severity"
            options={SEVERITY_OPTIONS}
            selected={state.severities}
            onToggle={(v) => toggleIn<Severity>('severities', v)}
            testId="events-severity"
          />

          <div className="h-4 w-px shrink-0 bg-primary/20" aria-hidden="true" />

          {/* Free-text / payload search */}
          <div className="flex flex-1 items-center gap-1 min-w-[160px]">
            <span className="font-mono text-micro uppercase tracking-wide text-muted-foreground/60">
              Search:
            </span>
            <input
              type="text"
              aria-label="Search payload"
              data-testid="events-q"
              placeholder="payload contains…"
              value={state.q}
              onChange={(e) =>
                setState((prev) => ({ ...prev, q: e.target.value }))
              }
              className="flex-1 rounded border border-primary/30 bg-primary/5 px-2 py-0.5 font-mono text-label text-foreground placeholder-muted-foreground/40 focus:border-primary/60 focus:outline-none"
            />
          </div>

          <div className="h-4 w-px shrink-0 bg-primary/20" aria-hidden="true" />

          {/* Filters toggle */}
          <button
            type="button"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((o) => !o)}
            className="rounded border border-primary/30 bg-primary/5 px-2 py-0.5 font-mono text-micro uppercase tracking-wide text-foreground hover:bg-primary/15"
          >
            Filters {filtersOpen ? '▴' : '▾'}
          </button>
        </div>

        {/* Secondary panel — always in DOM (hidden attr keeps tests green) */}
        <div hidden={!filtersOpen} className="flex flex-col gap-2 rounded border border-primary/10 bg-primary/[0.02] p-2">
          {/* Row: time · KIND */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Time range */}
            <div className="flex items-center gap-1">
              <span className="font-mono text-micro uppercase tracking-wide text-muted-foreground/60">
                Time:
              </span>
              <select
                aria-label="Time range"
                data-testid="events-time-range"
                value={state.range}
                onChange={(e) =>
                  setState((prev) => ({
                    ...prev,
                    range: e.target.value as TimeRange,
                  }))
                }
                className="rounded border border-primary/30 bg-primary/5 px-2 py-0.5 font-mono text-label text-foreground focus:border-primary/60 focus:outline-none"
              >
                {TIME_RANGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="h-4 w-px shrink-0 bg-primary/20" aria-hidden="true" />

            <MultiSelect
              label="Kind"
              options={KIND_OPTIONS}
              selected={state.kinds}
              onToggle={(v) => toggleIn<Kind>('kinds', v)}
              testId="events-kind"
              displayLabel={humanizeKind}
            />
          </div>

          {/* Row: PHASE · task/origin id inputs */}
          <div className="flex flex-wrap items-center gap-3">
            <MultiSelect
              label="Phase"
              options={PHASE_OPTIONS}
              selected={state.phases}
              onToggle={(v) => toggleIn<Phase>('phases', v)}
              testId="events-phase"
              displayLabel={(p) => humanizePhase(p) ?? p}
            />

            <div className="h-4 w-px shrink-0 bg-primary/20" aria-hidden="true" />

            {/* Task ID exact match */}
            <div className="flex items-center gap-1">
              <span className="font-mono text-micro uppercase tracking-wide text-muted-foreground/60">
                Task&nbsp;ID:
              </span>
              <input
                type="text"
                aria-label="Filter by task ID"
                data-testid="events-task-id"
                placeholder="exact id…"
                value={state.taskId}
                onChange={(e) =>
                  setState((prev) => ({ ...prev, taskId: e.target.value }))
                }
                className="rounded border border-primary/30 bg-primary/5 px-2 py-0.5 font-mono text-label text-foreground placeholder-muted-foreground/40 focus:border-primary/60 focus:outline-none"
              />
            </div>

            {/* Origin ID exact match */}
            <div className="flex items-center gap-1">
              <span className="font-mono text-micro uppercase tracking-wide text-muted-foreground/60">
                Origin&nbsp;ID:
              </span>
              <input
                type="text"
                aria-label="Filter by origin ID"
                data-testid="events-origin-id"
                placeholder="exact id…"
                value={state.originId}
                onChange={(e) =>
                  setState((prev) => ({ ...prev, originId: e.target.value }))
                }
                className="rounded border border-primary/30 bg-primary/5 px-2 py-0.5 font-mono text-label text-foreground placeholder-muted-foreground/40 focus:border-primary/60 focus:outline-none"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Events display — flat virtualized list or grouped timeline */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
        data-testid="events-list"
      >
        {initial.isPending ? (
          <SkeletonList rows={8} rowClassName="h-8 w-full mb-1" label="Loading events" />
        ) : viewMode === 'timeline' ? (
          <TimelineView events={events} now={now} />
        ) : events.length === 0 ? (
          <div
            data-testid="events-empty"
            className="font-mono text-label text-primary"
          >
            No events match these filters.
          </div>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((vItem) => {
              const row = groupedRows[vItem.index]
              return (
                <div
                  key={vItem.key}
                  data-index={vItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vItem.start}px)`,
                    paddingBottom: '4px',
                  }}
                >
                  {row.type === 'tool-group' ? (
                    <ToolCallGroup
                      events={row.events}
                      groupId={row.events[0].id}
                      expanded={expandedGroupIds.has(row.events[0].id)}
                      onToggleGroup={toggleGroupExpanded}
                      now={now}
                      fieldsExpandedSet={fieldsExpandedSet}
                      onToggleFields={toggleFieldsExpanded}
                    />
                  ) : row.type === 'incident' ? (
                    <IncidentGroup
                      events={row.events}
                      groupId={row.events[0].id}
                      expanded={expandedGroupIds.has(row.events[0].id)}
                      onToggleGroup={toggleGroupExpanded}
                      now={now}
                      fieldsExpandedSet={fieldsExpandedSet}
                      onToggleFields={toggleFieldsExpanded}
                    />
                  ) : row.type === 'group' ? (
                    <GroupedRow
                      events={row.events}
                      groupId={row.events[0].id}
                      expanded={expandedGroupIds.has(row.events[0].id)}
                      onToggleGroup={toggleGroupExpanded}
                      now={now}
                      fieldsExpandedSet={fieldsExpandedSet}
                      onToggleFields={toggleFieldsExpanded}
                    />
                  ) : (
                    <EventRow
                      event={row.event}
                      now={now}
                      fieldsExpanded={fieldsExpandedSet.has(row.event.id)}
                      onToggleFields={toggleFieldsExpanded}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Pagination — inside the scroll container so it appears after all events */}
        {nextCursor !== null && events.length > 0 ? (
          <div className="pt-2">
            <button
              type="button"
              disabled={more.isPending}
              onClick={() => more.mutate(nextCursor)}
              data-testid="events-load-more"
              className="font-mono text-micro uppercase text-foreground underline disabled:opacity-50"
            >
              {more.isPending ? 'Loading…' : 'Load more'}
            </button>
          </div>
        ) : null}
      </div>
    </main>
  )
}

// Internal helpers exported for unit tests. Not part of the page's public API.
export const __test__ = {
  toWireFilter,
  applyLocalPhaseFilter,
  sinceFromRange,
  initialFilterState,
  ALL_SEVERITIES,
  ALL_KINDS,
  ALL_PHASES,
  KIND_OPTIONS,
  SEVERITY_OPTIONS,
  PHASE_OPTIONS,
  TIME_RANGE_MS,
  groupConsecutiveEvents,
  formatToolDuration,
}
