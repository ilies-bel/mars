import { memo, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { fetchEvents, type EventsFilter } from '@/shared/api'
import { FallbackSurface } from '@/components/FallbackSurface'
import { severityColor, severityRowClass, summarizeTraceEvent, marsToolTextClass } from '@/shared/actionQueueDetail'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import type { TraceEvent } from '@/shared/schemas'
import { relativeTime, formatRelativeAge } from '@/shared/time'
import { taskHash } from '@/shared/routing'
import { KpiVector } from '@/widgets/KpiVector'
import { SpendMeterTile } from '@/widgets/SpendMeterTile'

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
  'origin_created',
  'step_started',
  'step_ended',
  'tool_invoked',
  'task_blocked',
  'recovery_spawned',
  'task_failed',
  'log_line',
] as const
type Kind = (typeof KIND_OPTIONS)[number]

const SEVERITY_OPTIONS = ['info', 'warn', 'error'] as const
type Severity = (typeof SEVERITY_OPTIONS)[number]

/**
 * Phase options surface a synthetic `(n/a)` entry so the operator can
 * include events with no phase (e.g. `origin_created`) without having to
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

const initialFilterState = (): FilterState => ({
  range: 'all',
  severities: new Set(SEVERITY_OPTIONS),
  kinds: new Set(KIND_OPTIONS),
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
    'rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors',
    active
      ? 'border-iron/60 bg-iron/30 text-fg'
      : 'border-iron/30 bg-transparent text-iron hover:border-iron/50 hover:text-fg',
  ].join(' ')

interface MultiSelectProps<T extends string> {
  label: string
  options: readonly T[]
  selected: ReadonlySet<T>
  onToggle: (value: T) => void
  testId: string
}

const MultiSelect = <T extends string>({
  label,
  options,
  selected,
  onToggle,
  testId,
}: MultiSelectProps<T>) => (
  <div className="flex flex-wrap items-center gap-1" data-testid={testId}>
    <span className="self-center font-mono text-[10px] uppercase tracking-wide text-iron">
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
          {opt}
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
  const href = event.taskId
    ? taskHash(event.taskId, 'events', stepName)
    : undefined

  const logLineSource =
    event.kind === 'log_line' && typeof event.payload.source === 'string'
      ? event.payload.source
      : null
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
      {/* Single-line metadata + summary — flex so the summary can truncate
          instead of stretching the row and causing page-level horizontal scroll. */}
      <div className="flex min-w-0 items-baseline gap-x-1 overflow-hidden">
        <span className="shrink-0 text-muted">{relativeTime(event.timestamp, now)}</span>
        <span
          className={`shrink-0 font-mono text-[10px] uppercase ${event.severity !== 'info' ? 'font-semibold ' : ''}${severityColor(event.severity)}`}
        >
          [{event.severity}]
        </span>
        <span className="shrink-0 font-mono text-[10px] text-iron">{event.kind}</span>
        {logLineSource ? (
          <span
            className="shrink-0 rounded bg-iron/20 px-1 font-mono text-[9px] text-muted"
            data-testid={`event-row-source-${event.id}`}
          >
            {logLineSource}
          </span>
        ) : null}
        {event.phase ? (
          <span className="shrink-0 font-mono text-[10px] text-muted">
            · {event.phase}
          </span>
        ) : null}
        {event.taskId ? (
          <span className="shrink-0 font-mono text-[10px] text-muted">
            {truncateId(event.taskId)}
          </span>
        ) : null}
        <span className={`min-w-0 truncate ${marsToolTextClass(event)}`}>
          {summarizeTraceEvent(event)}
        </span>
        {hasFields ? (
          <button
            type="button"
            onClick={toggleFields}
            className="-my-1 inline-flex min-h-[24px] shrink-0 items-center px-2 py-1 font-mono text-[9px] text-muted underline hover:text-iron"
            data-testid={`event-row-fields-toggle-${event.id}`}
          >
            {fieldsExpanded ? 'hide fields' : 'fields'}
          </button>
        ) : null}
      </div>
      {fieldsExpanded && logLineFields ? (
        <pre
          className="mt-1 max-w-full overflow-x-auto font-mono text-[10px] text-muted"
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
        className={`block rounded border ${severityRowClass(event.severity)} px-3 py-1.5 font-mono text-[12px] text-fg`}
        data-testid={`event-row-${event.id}`}
      >
        {body}
      </div>
    )
  }
  return (
    <div>
      <a
        href={href}
        className={`block rounded border ${severityRowClass(event.severity)} px-3 py-1.5 font-mono text-[12px] text-fg hover:bg-iron/15`}
        data-testid={`event-row-${event.id}`}
      >
        {body}
      </a>
    </div>
  )
})

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const PAGE_LIMIT = 100

export const EventsPage = () => {
  const [state, setState] = useState<FilterState>(initialFilterState)
  const [extraPages, setExtraPages] = useState<TraceEvent[][]>([])
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

  // Virtual list for the events stream (100+ items per page, multiple pages possible).
  // scrollRef and virtualizer are declared here — before the conditional early
  // return — to satisfy the rules of hooks.
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: events.length,
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
      <main className="flex min-h-0 flex-1 overflow-hidden bg-bg">
        <FallbackSurface error={initial.error} of="the events stream" variant="pane" />
      </main>
    )
  }

  return (
    <main className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden bg-bg p-4">
      {/* Header — fixed above the scrollable list */}
      <header className="flex items-center gap-3">
        <h1 className="font-mono text-[11px] uppercase tracking-wide text-iron">
          Events — {events.length} event{events.length === 1 ? '' : 's'}
        </h1>
        <button
          type="button"
          onClick={onRefresh}
          disabled={initial.isFetching}
          data-testid="events-refresh"
          className="ml-auto rounded border border-iron/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-fg hover:bg-iron/15 disabled:opacity-50"
        >
          {initial.isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
        {fetchedAt !== null ? (
          <span
            data-testid="events-fetched-at"
            className="font-mono text-[10px] text-muted"
          >
            {fetchedAt}
          </span>
        ) : null}
      </header>

      {/* KPI strip — four metric tiles at the top of the Events tab, with the
          spend-meter tile rendered adjacent (a separate concept, not a fifth KPI) */}
      <div className="flex flex-wrap items-start gap-3">
        <KpiVector />
        <SpendMeterTile />
      </div>

      {/* Filter row — fixed above the scrollable list */}
      <div className="flex flex-wrap items-start gap-4">
        {/* Time range */}
        <div className="flex items-center gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wide text-iron">
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
            className="rounded border border-iron/30 bg-iron/5 px-2 py-0.5 font-mono text-[11px] text-fg focus:border-iron/60 focus:outline-none"
          >
            {TIME_RANGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <MultiSelect
          label="Severity"
          options={SEVERITY_OPTIONS}
          selected={state.severities}
          onToggle={(v) => toggleIn<Severity>('severities', v)}
          testId="events-severity"
        />

        <MultiSelect
          label="Kind"
          options={KIND_OPTIONS}
          selected={state.kinds}
          onToggle={(v) => toggleIn<Kind>('kinds', v)}
          testId="events-kind"
        />

        <MultiSelect
          label="Phase"
          options={PHASE_OPTIONS}
          selected={state.phases}
          onToggle={(v) => toggleIn<Phase>('phases', v)}
          testId="events-phase"
        />

        {/* Task ID exact match */}
        <div className="flex items-center gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wide text-iron">
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
            className="rounded border border-iron/30 bg-iron/5 px-2 py-0.5 font-mono text-[11px] text-fg placeholder-iron focus:border-iron/60 focus:outline-none"
          />
        </div>

        {/* Origin ID exact match */}
        <div className="flex items-center gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wide text-iron">
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
            className="rounded border border-iron/30 bg-iron/5 px-2 py-0.5 font-mono text-[11px] text-fg placeholder-iron focus:border-iron/60 focus:outline-none"
          />
        </div>

        {/* Full-text */}
        <div className="flex flex-1 items-center gap-1 min-w-[180px]">
          <span className="font-mono text-[10px] uppercase tracking-wide text-iron">
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
            className="flex-1 rounded border border-iron/30 bg-iron/5 px-2 py-0.5 font-mono text-[11px] text-fg placeholder-iron focus:border-iron/60 focus:outline-none"
          />
        </div>
      </div>

      {/* Virtualized events list — dedicated scroll container keeps filters sticky.
          overflow-x-hidden prevents page-level horizontal scroll; individual
          expanded-fields <pre> elements scroll within themselves via overflow-x-auto. */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
        data-testid="events-list"
      >
        {initial.isPending ? (
          <div className="font-mono text-[11px] text-iron">Loading events…</div>
        ) : events.length === 0 ? (
          <div
            data-testid="events-empty"
            className="font-mono text-[11px] text-iron"
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
            {virtualizer.getVirtualItems().map((vItem) => (
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
                  // replicate original gap-1 (4px) between rows
                  paddingBottom: '4px',
                }}
              >
                <EventRow
                  event={events[vItem.index]}
                  now={now}
                  fieldsExpanded={fieldsExpandedSet.has(events[vItem.index].id)}
                  onToggleFields={toggleFieldsExpanded}
                />
              </div>
            ))}
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
              className="font-mono text-[10px] uppercase text-fg underline disabled:opacity-50"
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
}
