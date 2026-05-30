import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiErrorPanel } from '@/components/ApiErrorPanel'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { OriginTree } from '@/widgets/OriginTree'
import {
  fetchEvents,
  fetchFailureReasons,
  invokeAction,
} from '@/shared/api'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import {
  catalogActionsForDetail,
  resolveFailureReason,
  severityColor,
  summarizeTraceEvent,
  type CatalogActionDescriptor,
} from '@/shared/actionQueueDetail'
import type {
  ActionDescriptor,
  ActionQueueItem,
  DagNode,
  TraceEvent,
} from '@/shared/schemas'
import { relativeTime } from '@/shared/time'
import { taskHash } from '@/shared/routing'

// ---- Helpers ----

const formatTime = (iso: string): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

const priorityBadgeClass = (priority: string): string => {
  if (priority === 'high') return 'text-error'
  if (priority === 'normal') return 'text-warn'
  return 'text-iron/60'
}

const KIND_LABEL: Record<ActionQueueItem['kind'], string> = {
  'failed-task': 'failed',
  'stale-worktree': 'stale wt',
  'draft-proposal': 'draft',
}

const ACK_STATE_LABEL: Record<'ack' | 'resolved' | 'dismissed', string> = {
  ack: 'acknowledged',
  resolved: 'resolved',
  dismissed: 'dismissed',
}

// ---- Row ----

interface RowProps {
  item: ActionQueueItem
  active: boolean
  /** Called with the item's id when the row is clicked. */
  onSelect: (id: string) => void
  /** Non-null when the item has a restart action and the button should render. */
  onRestart: ((entityId: string) => void) | null
  /** True while the restart mutation is in-flight for this specific item. */
  restartPending: boolean
  /** Non-null when the last restart attempt for this item failed; shows inline error. */
  restartError: string | null
}

export const ActionQueueRow = memo(({
  item,
  active,
  onSelect,
  onRestart,
  restartPending,
  restartError,
}: RowProps) => {
  const baseClass = [
    'cursor-pointer px-3 py-2 transition-colors',
    active ? 'bg-iron/20' : 'hover:bg-iron/10',
  ].join(' ')

  return (
    <div className={baseClass} onClick={() => onSelect(item.id)}>
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-[9px] uppercase text-iron/80">
          {KIND_LABEL[item.kind]}
        </span>
        <span className="break-all font-mono text-[10px] text-iron">
          {item.entityId}
        </span>
        <span
          className={`ml-auto shrink-0 font-mono text-[9px] uppercase ${priorityBadgeClass(item.priority)}`}
        >
          {item.priority}
        </span>
      </div>
      <div className="mt-1 break-words font-mono text-[12px] text-fg">
        {item.title || '(no title)'}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-iron/70">
          {formatTime(item.at)}
          {item.ackState !== null ? ` · ${ACK_STATE_LABEL[item.ackState]}` : ''}
        </span>
        {onRestart !== null && (
          <button
            type="button"
            disabled={restartPending}
            onClick={(e) => {
              e.stopPropagation()
              onRestart(item.entityId)
            }}
            className="shrink-0 border border-fg/60 px-2 py-0.5 font-mono text-[10px] uppercase text-fg transition-colors hover:bg-iron/20 disabled:opacity-50"
          >
            {restartPending ? 'Restarting…' : 'Restart'}
          </button>
        )}
      </div>
      {restartError !== null && (
        <div className="mt-1 font-mono text-[10px] text-error">
          {restartError}
        </div>
      )}
    </div>
  )
})

// ---- DAG sub-panel ----

interface DagListProps {
  label: string
  nodes: DagNode[]
}

const DagList = ({ label, nodes }: DagListProps) => {
  if (nodes.length === 0) return null
  return (
    <div>
      <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
        {label}
      </dt>
      <dd>
        <ul className="flex flex-col gap-1">
          {nodes.map((n) => (
            <li key={n.id} className="text-fg">
              <span className="text-iron">{n.id}</span>{' '}
              <span className="text-iron/60">({n.status})</span> {n.summary}
            </li>
          ))}
        </ul>
      </dd>
    </div>
  )
}

// ---- Action bar ----

interface ActionBarProps {
  item: ActionQueueItem
}

// Op strings used in multiple places inside ActionBar; defined once to avoid drift.
const INVESTIGATE_OP = 'investigate'
const DIAGNOSE_OP = 'diagnose-failure'

/**
 * Renders one button per recovery action on the row. Clicking proxies the
 * action's `op` to the daemon (via `/api/actions`). `needsConfirm` actions
 * prompt first; destructive ops are styled accordingly. The `shape` op has no
 * daemon verb — it renders as a guidance chip showing the skill to run.
 *
 * For stale-worktree rows where `empty === true` the Investigate action is
 * suppressed (nothing to analyse in an empty worktree).
 */
const ActionBar = ({ item }: ActionBarProps) => {
  const qc = useQueryClient()
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: ({ action }: { action: ActionDescriptor }) => {
      // Process-level ops (restart-daemon) carry no entity id.
      const entityId = action.op === 'restart-daemon' ? undefined : item.entityId
      return invokeAction(action.op, entityId)
    },
    onMutate: () => setErrorMsg(null),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['action-queue'] })
      void qc.invalidateQueries({ queryKey: ['progress'] })
    },
    onError: (err) => setErrorMsg((err as Error).message),
  })

  // Gate Investigate out for empty stale worktrees — there is nothing to analyse.
  const visibleActions =
    item.kind === 'stale-worktree' && item.staleWorktreeDetail.empty === true
      ? item.actions.filter((a) => a.op !== INVESTIGATE_OP)
      : item.actions

  if (visibleActions.length === 0) return null

  // Show a specific label while the Investigate (Haiku) call is in-flight.
  const isInvestigating =
    mutation.isPending && mutation.variables?.action.op === INVESTIGATE_OP

  // Show a specific label while the diagnose-failure (Sonnet) call is in-flight.
  const isDiagnosing =
    mutation.isPending && mutation.variables?.action.op === DIAGNOSE_OP

  const run = (action: ActionDescriptor) => {
    if (mutation.isPending) return
    if (
      action.needsConfirm &&
      !window.confirm(`${action.label}: ${item.entityId}. Proceed?`)
    ) {
      return
    }
    mutation.mutate({ action })
  }

  return (
    <div>
      <dt className="mb-2 text-[10px] uppercase tracking-wider text-iron">
        Recovery
      </dt>
      <dd className="flex flex-wrap gap-2">
        {visibleActions.map((action) =>
          action.op === 'shape' ? (
            <span
              key={action.id}
              className="border border-iron/30 px-3 py-1.5 font-mono text-[11px] text-iron"
            >
              {action.label}
              {action.hint ? ` · ${action.hint}` : ''}
            </span>
          ) : (
            <button
              key={action.id}
              type="button"
              disabled={mutation.isPending}
              onClick={() => run(action)}
              className={[
                'border px-3 py-1.5 font-mono text-[11px] uppercase transition-colors disabled:opacity-50',
                action.needsConfirm
                  ? 'border-error/50 text-error hover:bg-error/10'
                  : 'border-iron/40 text-fg hover:bg-iron/20',
              ].join(' ')}
            >
              {action.op === INVESTIGATE_OP && isInvestigating
                ? 'Investigating…'
                : action.op === DIAGNOSE_OP && isDiagnosing
                  ? 'Diagnosing…'
                  : action.label}
            </button>
          ),
        )}
      </dd>
      {errorMsg ? (
        <p className="mt-2 font-mono text-[10px] text-error">{errorMsg}</p>
      ) : null}
    </div>
  )
}

// ---- Catalog-driven Reason + Available actions (failed rows only) ----

interface CatalogPanelProps {
  item: ActionQueueItem
}

const CatalogReasonAndActions = ({ item }: CatalogPanelProps) => {
  const qc = useQueryClient()
  const projectId = useFocusedProjectId()
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // The catalog is small (a few dozen entries) and rarely changes. One
  // fetch on panel open is plenty; React Query's default staleTime keeps
  // it cached across detail-panel re-mounts.
  const catalogQuery = useQuery({
    queryKey: ['failure-reasons', projectId],
    queryFn: () => fetchFailureReasons(projectId ?? undefined),
    enabled: projectId !== null,
  })

  const mutation = useMutation({
    mutationFn: (op: string) => invokeAction(op, item.entityId),
    onMutate: () => setErrorMsg(null),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['action-queue'] })
      void qc.invalidateQueries({ queryKey: ['progress'] })
    },
    onError: (err) => setErrorMsg((err as Error).message),
  })

  if (catalogQuery.isPending) {
    return (
      <div>
        <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
          Reason
        </dt>
        <dd className="text-iron/60">Loading catalog…</dd>
      </div>
    )
  }
  if (catalogQuery.isError || !catalogQuery.data) {
    return (
      <div>
        <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
          Reason
        </dt>
        <dd className="text-error">
          Failed to load failure-reason catalog
          {catalogQuery.error ? `: ${(catalogQuery.error as Error).message}` : ''}
        </dd>
      </div>
    )
  }

  const entry = resolveFailureReason(item.failureReasonCode, catalogQuery.data)
  if (!entry) {
    return null
  }
  const actions = catalogActionsForDetail(entry.availableActions, item.entityId)

  const run = (action: CatalogActionDescriptor) => {
    if (mutation.isPending || action.disabled) return
    if (
      action.id === 'purge' &&
      !window.confirm(`${action.raw.label}: ${item.entityId}. Proceed?`)
    ) {
      return
    }
    mutation.mutate(action.op)
  }

  return (
    <>
      <div>
        <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
          Reason
        </dt>
        <dd className="text-fg">{entry.userMessage}</dd>
      </div>
      <div>
        <dt className="mb-2 text-[10px] uppercase tracking-wider text-iron">
          Available actions
        </dt>
        <dd className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={mutation.isPending || action.disabled}
              onClick={() => run(action)}
              className={[
                'border px-3 py-1.5 font-mono text-[11px] uppercase transition-colors disabled:opacity-50',
                action.id === 'purge'
                  ? 'border-error/50 text-error hover:bg-error/10'
                  : 'border-iron/40 text-fg hover:bg-iron/20',
              ].join(' ')}
            >
              {action.label}
            </button>
          ))}
        </dd>
        {errorMsg ? (
          <p className="mt-2 font-mono text-[10px] text-error">{errorMsg}</p>
        ) : null}
      </div>
    </>
  )
}

// ---- Traces section ----

interface TracesProps {
  taskId: string
}

const TracesSection = ({ taskId }: TracesProps) => {
  // Hold the appended pages from `Load more`; the first page comes from the
  // React Query cache so a pre-warmed test sees it on initial render.
  const [extraPages, setExtraPages] = useState<TraceEvent[][]>([])
  const [overrideCursor, setOverrideCursor] = useState<string | null | undefined>(
    undefined,
  )
  const projectId = useFocusedProjectId()

  const initial = useQuery({
    queryKey: ['events', projectId, taskId],
    queryFn: () => fetchEvents({ taskId, limit: 50 }, projectId ?? undefined),
    enabled: projectId !== null,
  })

  const more = useMutation({
    mutationFn: async (cursor: string) =>
      fetchEvents({ taskId, cursor, limit: 50 }, projectId ?? undefined),
    onSuccess: (res) => {
      setExtraPages((p) => [...p, res.events])
      setOverrideCursor(res.nextCursor)
    },
  })

  if (initial.isPending) {
    return (
      <div>
        <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
          Traces
        </dt>
        <dd className="text-iron/60">Loading…</dd>
      </div>
    )
  }
  if (initial.isError || !initial.data) {
    return (
      <div>
        <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
          Traces
        </dt>
        <dd className="text-error">
          Failed to load traces
          {initial.error ? `: ${(initial.error as Error).message}` : ''}
        </dd>
      </div>
    )
  }

  const events = [initial.data.events, ...extraPages].flat()
  const nextCursor =
    overrideCursor === undefined ? initial.data.nextCursor : overrideCursor

  if (events.length === 0) {
    return (
      <div>
        <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
          Traces
        </dt>
        <dd className="text-iron/60">No trace events recorded for this task.</dd>
      </div>
    )
  }

  return (
    <div>
      <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
        Traces
      </dt>
      <dd>
        <ul className="flex flex-col gap-1">
          {events.map((e) => (
            <li key={e.id} className="text-fg">
              <span className="text-iron/60">{relativeTime(e.timestamp)}</span>{' '}
              <span className={`font-mono text-[10px] uppercase ${severityColor(e.severity)}`}>
                [{e.severity}]
              </span>{' '}
              <span className="font-mono text-[10px] text-iron">{e.kind}</span>
              {e.phase ? (
                <span className="font-mono text-[10px] text-iron/60">
                  {' '}
                  ·{' '}
                  {e.phase}
                </span>
              ) : null}{' '}
              <span>{summarizeTraceEvent(e)}</span>
            </li>
          ))}
        </ul>
        {nextCursor !== null ? (
          <button
            type="button"
            disabled={more.isPending}
            onClick={() => more.mutate(nextCursor)}
            className="mt-2 font-mono text-[10px] uppercase text-fg underline disabled:opacity-50"
          >
            {more.isPending ? 'Loading…' : 'Load more'}
          </button>
        ) : null}
      </dd>
    </div>
  )
}

// ---- Detail panel ----

interface DetailProps {
  item: ActionQueueItem
}

const ActionQueueDetail = ({ item }: DetailProps) => {
  // A real failed task (not the daemon-killed-batch sentinel) can open the
  // shared TaskDetailDrawer. The `from=action-queue` tag keeps the Action queue
  // list mounted behind the drawer and returns here on close.
  const canOpenTaskDetail =
    item.kind === 'failed-task' && item.entityId !== '__daemon-killed-batch__'

  return (
    <div className="flex h-full flex-col overflow-auto">
      <header className="border-b border-iron/30 px-6 py-4">
        <div className="flex items-baseline gap-3">
          <span className="break-all font-mono text-[11px] uppercase text-iron">
            {item.entityId}
          </span>
          <span className="shrink-0 font-mono text-[10px] uppercase text-iron/80">
            {KIND_LABEL[item.kind]}
          </span>
          <span
            className={`ml-auto font-mono text-[10px] uppercase ${priorityBadgeClass(item.priority)}`}
          >
            {item.priority}
          </span>
        </div>
        <h2 className="mt-2 break-all font-mono text-[15px] text-fg">
          {item.title || '(no title)'}
        </h2>
        {canOpenTaskDetail ? (
          <button
            type="button"
            data-testid="aq-open-task-detail"
            onClick={() => {
              window.location.hash = taskHash(item.entityId, 'action-queue')
            }}
            className="mt-3 border border-iron/40 px-3 py-1.5 font-mono text-[10px] uppercase text-fg transition-colors hover:bg-iron/20"
          >
            Open task detail
          </button>
        ) : null}
      </header>

      <main className="flex-1 px-6 py-4">
        <dl className="flex flex-col gap-4 font-mono text-[12px]">
          {item.kind === 'failed-task' ? (
            <CatalogReasonAndActions item={item} />
          ) : (
            <ActionBar item={item} />
          )}
          {item.kind === 'stale-worktree' && (
            <>
              <div>
                <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
                  Task prompt
                </dt>
                <dd className="whitespace-pre-wrap text-fg">
                  {item.staleWorktreeDetail.prompt ?? (
                    <span className="text-iron/70">absent (no matching task)</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
                  Status · Age · Branch
                </dt>
                <dd className="text-fg">
                  <span>{item.staleWorktreeDetail.status}</span>
                  {' · '}
                  <span>{item.staleWorktreeDetail.ageHours.toFixed(1)}h</span>
                  {' · '}
                  <span>{item.staleWorktreeDetail.branch ?? '—'}</span>
                </dd>
              </div>
              <div>
                <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
                  Investigation
                </dt>
                <dd>
                  {item.staleWorktreeDetail.investigation ? (
                    <>
                      <p className="mb-1 text-[10px] text-iron/60">
                        {formatTime(item.staleWorktreeDetail.updatedAt)}
                      </p>
                      <p className="whitespace-pre-wrap text-fg">
                        {item.staleWorktreeDetail.investigation}
                      </p>
                    </>
                  ) : item.staleWorktreeDetail.empty ? null : (
                    <span className="text-iron/70">
                      None yet — use Investigate to analyse this worktree.
                    </span>
                  )}
                </dd>
              </div>
            </>
          )}
          <div>
            <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
              Details
            </dt>
            <dd className="whitespace-pre-wrap text-fg">
              {item.body.trim() || (
                <span className="text-iron/70">(no details recorded)</span>
              )}
            </dd>
          </div>
          {item.diagnosis ? (
            <div>
              <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
                Diagnosis
              </dt>
              <dd>
                <p className="mb-1 text-[10px] text-iron/60">
                  {formatTime(item.diagnosis.diagnosedAt)}
                </p>
                <p className="whitespace-pre-wrap text-fg">
                  {item.diagnosis.text}
                </p>
              </dd>
            </div>
          ) : null}
          {item.dag && (
            <>
              {item.dag.proposalId && (
                <div>
                  <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
                    From proposal
                  </dt>
                  <dd className="text-fg">{item.dag.proposalId}</dd>
                </div>
              )}
              <DagList label="Waits on (blockers)" nodes={item.dag.blockers} />
              <DagList
                label="Waited on by (blocking)"
                nodes={item.dag.blocking}
              />
              <DagList
                label="Recovery descendants"
                nodes={item.dag.descendants}
              />
            </>
          )}
          {item.kind === 'failed-task' && item.entityId !== '__daemon-killed-batch__' ? (
            <>
              <TracesSection taskId={item.entityId} />
              <OriginTree taskId={item.entityId} />
            </>
          ) : null}
          <div>
            <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
              Last updated
            </dt>
            <dd className="text-fg">{formatTime(item.at)}</dd>
          </div>
        </dl>
      </main>
    </div>
  )
}

// ---- Page ----

export const ActionQueuePage = () => {
  const { items, error } = useActionQueue()
  const [query, setQuery] = useState<string>('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const qc = useQueryClient()
  const restartMutation = useMutation({
    mutationFn: (entityId: string) => invokeAction('restart', entityId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['action-queue'] })
      void qc.invalidateQueries({ queryKey: ['progress'] })
    },
  })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (i) =>
        i.id.toLowerCase().includes(q) ||
        i.title.toLowerCase().includes(q) ||
        i.body.toLowerCase().includes(q) ||
        i.kind.toLowerCase().includes(q),
    )
  }, [items, query])

  const selected =
    filtered.find((i) => i.id === selectedId) ?? filtered[0] ?? null
  const empty = items.length === 0
  const noMatches = !empty && filtered.length === 0

  // Stable callbacks — prevent per-item lambda allocation on every render.
  const handleSelect = useCallback((id: string) => {
    setSelectedId(id)
  }, [])

  const handleRestart = useCallback((entityId: string) => {
    restartMutation.mutate(entityId)
  }, [restartMutation])

  // Virtual list for the action-queue sidebar (can reach 300+ items).
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 5,
    // initialRect ensures items render during SSR (renderToStaticMarkup in tests)
    // where scrollRef.current is null and no ResizeObserver fires.
    initialRect: { width: 0, height: 4000 },
  })

  return (
    <div className="flex flex-col sm:flex-row h-full w-full overflow-hidden bg-bg">
      <aside className="flex w-full shrink-0 flex-col border-b border-iron/30 sm:w-80 sm:border-b-0 sm:border-r max-h-[40vh] sm:max-h-none">
        <header className="border-b border-iron/30 px-4 py-3">
          <h1 className="font-mono text-sm uppercase tracking-wide text-fg">
            Action queue
          </h1>
          <p className="mt-1 font-mono text-[10px] text-iron">
            {items.length} item{items.length === 1 ? '' : 's'}
          </p>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            aria-label="Search action queue"
            data-testid="action-queue-search"
            className="mt-2 w-full border border-iron/30 bg-bg px-2 py-1 font-mono text-[12px] text-fg placeholder:text-iron/40 focus:outline-none focus:ring-1 focus:ring-iron/50"
          />
        </header>

        <div ref={scrollRef} className="flex-1 overflow-auto">
          {filtered.length === 0 ? (
            <p className="px-3 py-2 font-mono text-[11px] text-iron/50">
              {query.trim() ? 'No matches.' : 'No items.'}
            </p>
          ) : (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((vItem) => {
                const item = filtered[vItem.index]
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
                    }}
                  >
                    <ActionQueueRow
                      item={item}
                      active={item.id === (selected?.id ?? null)}
                      onSelect={handleSelect}
                      onRestart={
                        item.actions.some((a) => a.op === 'restart')
                          ? handleRestart
                          : null
                      }
                      restartPending={
                        restartMutation.isPending &&
                        restartMutation.variables === item.entityId
                      }
                      restartError={
                        restartMutation.isError &&
                        restartMutation.variables === item.entityId
                          ? (restartMutation.error as Error).message
                          : null
                      }
                    />
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {error ? (
          <div className="border-t border-iron/40 bg-iron/10 px-4 py-1.5 font-mono text-[10px] text-iron">
            {error.message}
          </div>
        ) : null}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {empty && error ? (
          <ApiErrorPanel error={error} />
        ) : empty ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="font-mono text-[12px] text-iron">
              No items. Action queue alerts appear here when tasks need operator attention.
            </div>
          </div>
        ) : noMatches ? (
          <div className="flex h-full items-center justify-center font-mono text-[12px] text-iron">
            No matches.
          </div>
        ) : selected ? (
          <ActionQueueDetail key={selected.id} item={selected} />
        ) : (
          <div className="flex h-full items-center justify-center font-mono text-[12px] text-iron">
            Select an item
          </div>
        )}
      </section>
    </div>
  )
}
