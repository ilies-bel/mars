import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiErrorPanel } from '@/components/ApiErrorPanel'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { OriginTree } from '@/widgets/OriginTree'
import {
  fetchEvents,
  invokeAction,
} from '@/shared/api'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import {
  severityColor,
  summarizeTraceEvent,
} from '@/shared/actionQueueDetail'
import type {
  ActionDescriptor,
  ActionQueueItem,
  DagNode,
  TraceEvent,
} from '@/shared/schemas'
import { relativeTime } from '@/shared/time'
import { taskHash } from '@/shared/routing'
import { getFallbackCopy, logFallbackError } from '@/shared/uiFallback'

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
        </span>
        {onRestart !== null && (
          <button
            type="button"
            disabled={restartPending}
            onClick={(e) => {
              e.stopPropagation()
              onRestart(item.entityId)
            }}
            className="shrink-0 border border-fg/60 px-2 py-0.5 font-mono text-[10px] uppercase text-fg transition hover:bg-iron/20 active:scale-[0.97] disabled:opacity-50"
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
  /** When provided, each node renders as a clickable link opening that task's detail. */
  onNodeClick?: (id: string) => void
}

const DagList = ({ label, nodes, onNodeClick }: DagListProps) => {
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
              {onNodeClick ? (
                <button
                  type="button"
                  onClick={() => onNodeClick(n.id)}
                  className="text-iron underline decoration-iron/40 hover:decoration-iron"
                >
                  {n.id}
                </button>
              ) : (
                <span className="text-iron">{n.id}</span>
              )}{' '}
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
 * Renders one button per action on the row. Clicking proxies the action's
 * `op` to the daemon (via `/api/actions`). `needsConfirm` actions prompt
 * first; destructive ops are styled accordingly. The `copy` op copies
 * `action.hint` (or `action.label`) to the clipboard and shows a transient
 * 'Copied ✓' confirmation — it does NOT call the daemon.
 *
 * For stale-worktree rows where `empty === true` the Investigate action is
 * suppressed (nothing to analyse in an empty worktree).
 */
const ActionBar = ({ item }: ActionBarProps) => {
  const qc = useQueryClient()
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [copiedActionId, setCopiedActionId] = useState<string | null>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear the transient 'Copied' timer on unmount to avoid a setState-after-unmount.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    }
  }, [])

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

  const handleCopy = (action: ActionDescriptor) => {
    const text = action.hint ?? action.label
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setErrorMsg('Clipboard unavailable')
      return
    }
    navigator.clipboard.writeText(text).then(
      () => {
        if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
        setCopiedActionId(action.id)
        copyTimerRef.current = setTimeout(() => {
          setCopiedActionId(null)
          copyTimerRef.current = null
        }, 1500)
      },
      (err: unknown) => {
        setErrorMsg((err instanceof Error ? err.message : null) ?? 'Copy failed')
      },
    )
  }

  return (
    <div>
      <dt className="mb-2 text-[10px] uppercase tracking-wider text-iron">
        Move forward
      </dt>
      <dd className="flex flex-wrap gap-2">
        {visibleActions.map((action) =>
          action.op === 'copy' ? (
            <button
              key={action.id}
              type="button"
              onClick={() => handleCopy(action)}
              className="border border-iron/30 px-3 py-1.5 font-mono text-[11px] text-iron transition hover:bg-iron/10 active:scale-[0.97]"
            >
              {copiedActionId === action.id ? 'Copied ✓' : action.label}
            </button>
          ) : (
            <button
              key={action.id}
              type="button"
              disabled={mutation.isPending}
              onClick={() => run(action)}
              className={[
                'border px-3 py-1.5 font-mono text-[11px] uppercase transition active:scale-[0.97] disabled:opacity-50',
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

  useEffect(() => {
    if (initial.isError) {
      logFallbackError(initial.error)
    }
  }, [initial.isError, initial.error])

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
    const { headline, detail } = getFallbackCopy('trace events', initial.error)
    return (
      <div>
        <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
          Traces
        </dt>
        <dd className="text-error">
          {headline}{detail !== null ? ` ${detail}` : null}
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
        <dd className="text-iron/60">No trace events for this task yet.</dd>
      </div>
    )
  }

  return (
    <div>
      <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
        Traces
      </dt>
      <dd>
        <div className="max-h-64 overflow-y-auto pr-1">
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
        </div>
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
  /** When provided, origin-tree nodes become navigable buttons that call this with the node id. */
  onNavigateToTask?: (taskId: string) => void
}

const ActionQueueDetail = ({ item, onNavigateToTask }: DetailProps) => {
  // A real failed task (not the daemon-killed-batch sentinel) can open the
  // shared TaskDetailDrawer. The `from=action-queue` tag keeps the Action queue
  // list mounted behind the drawer and returns here on close.
  const isRealFailedTask =
    item.kind === 'failed-task' && item.entityId !== '__daemon-killed-batch__'

  const openTask = (id: string) => {
    window.location.hash = taskHash(id, 'action-queue')
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      <header className="border-b border-iron/30 px-6 py-4">
        {/* Headline: original task id, kind badge, priority */}
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
        {/* Warm title — the original task + failure reason are the headline. */}
        <h2 className="mt-2 break-all font-mono text-[15px] text-fg">
          {item.title || '(no title)'}
        </h2>
        {/* Plain-English failure reason shown prominently below the title for failed-task rows. */}
        {item.kind === 'failed-task' && item.body ? (
          <p className="mt-2 whitespace-pre-wrap font-mono text-[12px] text-fg/80">
            {item.body}
          </p>
        ) : null}
        {isRealFailedTask ? (
          <button
            type="button"
            data-testid="aq-open-task-detail"
            onClick={() => openTask(item.entityId)}
            className="mt-3 border border-iron/40 px-3 py-1.5 font-mono text-[10px] uppercase text-fg transition-colors hover:bg-iron/20"
          >
            Open task detail
          </button>
        ) : null}
      </header>

      <main className="flex-1 px-6 py-4">
        <dl className="flex flex-col gap-4 font-mono text-[12px]">
          {/* Recovery actions — always at the top of the main body. */}
          <ActionBar item={item} />
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
          {/* Diagnosis before the origin chain so context is established first. */}
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
          {/* Origin / recovery chain — navigable links between origin and fix tasks. */}
          {isRealFailedTask ? (
            <OriginTree
              taskId={item.entityId}
              onNavigate={onNavigateToTask}
            />
          ) : null}
          {/* Details — shown only for non-failed rows; failed rows surface body in the header. */}
          {item.kind !== 'failed-task' ? (
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
          ) : null}
          {/* DAG context — below the fold. */}
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
              {/* Recovery descendants: clickable so operator can drill into the fix task */}
              <DagList
                label="Recovery descendants"
                nodes={item.dag.descendants}
                onNodeClick={isRealFailedTask ? openTask : undefined}
              />
            </>
          )}
          {/* Traces — bounded scroll so they never push the rest of the card off-screen. */}
          {isRealFailedTask ? (
            <TracesSection taskId={item.entityId} />
          ) : null}
        </dl>
      </main>
      <footer className="border-t border-iron/30 px-6 py-3 font-mono text-[10px] text-iron/60">
        {isRealFailedTask ? 'Failed' : 'Last activity'}: {relativeTime(item.at)}
      </footer>
    </div>
  )
}

// ---- Page ----

export const ActionQueuePage = () => {
  const { items, error, projectsError, projectsEmpty } = useActionQueue()
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

  // Per-section open/collapsed state; all sections start expanded.
  const [openSections, setOpenSections] = useState<Record<ActionQueueItem['kind'], boolean>>({
    'draft-proposal': true,
    'failed-task': true,
    'stale-worktree': true,
  })

  const toggleSection = useCallback((kind: ActionQueueItem['kind']) => {
    setOpenSections((prev) => ({ ...prev, [kind]: !prev[kind] }))
  }, [])

  // Group filtered items by kind while preserving within-group server order.
  const grouped = useMemo(() => ({
    'draft-proposal': filtered.filter((i) => i.kind === 'draft-proposal'),
    'failed-task': filtered.filter((i) => i.kind === 'failed-task'),
    'stale-worktree': filtered.filter((i) => i.kind === 'stale-worktree'),
  }), [filtered])

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

        <div className="flex-1 overflow-auto">
          {filtered.length === 0 && (query.trim() || (!projectsEmpty && !projectsError)) ? (
            <p className="px-3 py-2 font-mono text-[11px] text-iron/50">
              {query.trim() ? 'No matches.' : 'No items.'}
            </p>
          ) : filtered.length > 0 ? (
            <div>
              {([
                ['draft-proposal', 'Drafts'],
                ['failed-task', 'Failed tasks'],
                ['stale-worktree', 'Stale worktrees'],
              ] as const).map(([kind, title]) => {
                const bucket = grouped[kind]
                if (bucket.length === 0) return null
                const isOpen = openSections[kind]
                const sectionBodyId = `section-body-${kind}`
                return (
                  <div key={kind}>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={sectionBodyId}
                      onClick={() => toggleSection(kind)}
                      className="flex w-full items-center justify-between border-b border-iron/20 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-iron hover:bg-iron/5"
                    >
                      <span>{title} {bucket.length}</span>
                      <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                    </button>
                    {isOpen && (
                      <div id={sectionBodyId}>
                        {bucket.map((item) => (
                          <ActionQueueRow
                            key={item.id}
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
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>

        {(error || projectsError) ? (
          <div className="border-t border-iron/40 bg-iron/10 px-4 py-1.5 font-mono text-[10px] text-iron">
            {(error ?? projectsError)!.message}
          </div>
        ) : null}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {empty && (error || projectsError) ? (
          <ApiErrorPanel error={(error ?? projectsError)!.message} />
        ) : empty && projectsEmpty ? (
          <div
            className="flex h-full items-center justify-center px-6 text-center"
            data-testid="no-projects-registered"
          >
            <div className="font-mono text-[12px] text-iron">
              <p className="text-[13px] text-fg">No projects registered.</p>
              <p className="mt-2">
                Run{' '}
                <code className="rounded bg-iron/20 px-1">mars init</code>{' '}
                inside your repo — it registers the project automatically.
              </p>
              <p className="mt-1 text-iron/60">
                Or register an existing repo:{' '}
                <code className="rounded bg-iron/20 px-1">mars project add &lt;repo&gt;</code>
              </p>
            </div>
          </div>
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
          <ActionQueueDetail
            key={selected.id}
            item={selected}
            onNavigateToTask={(taskId: string) => {
              const found = filtered.find((i) => i.entityId === taskId)
              if (found) setSelectedId(found.id)
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center font-mono text-[12px] text-iron">
            Select an item
          </div>
        )}
      </section>
    </div>
  )
}
