import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiErrorPanel } from '@/components/ApiErrorPanel'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { useActionQueueHistory } from '@/entities/actionQueue/useActionQueueHistory'
import { OriginTree } from '@/widgets/OriginTree'
import ArcChainRail from '@/widgets/ArcChainRail'
import { ArcTree } from '@/widgets/ArcTree'
import {
  fetchEvents,
  fetchProposalDetail,
  invokeAction,
} from '@/shared/api'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import {
  kindBadgeLabel,
  severityColor,
  severityRowClass,
  summarizeTraceEvent,
  marsToolTextClass,
} from '@/shared/actionQueueDetail'
import type {
  ActionDescriptor,
  ActionQueueItem,
  ActionQueueResolution,
  TraceEvent,
} from '@/shared/schemas'
import { relativeTime } from '@/shared/time'
import { taskHash, proposalHash } from '@/shared/routing'
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

export type KindFilter = 'all' | 'alerts' | 'drafts'

/** Pure helper: returns true when `item` should be shown for the given `filter`. */
export function matchesKindFilter(item: ActionQueueItem, filter: KindFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'alerts') return item.kind === 'failed-task' || item.kind === 'stale-worktree'
  return item.kind === 'draft-proposal'
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
        {item.kind !== 'failed-task' && (
          <span className="shrink-0 font-mono text-[9px] uppercase text-iron/80">
            {kindBadgeLabel(item.kind)}
          </span>
        )}
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

// ---- Resolution block (read-only; shown for resolved history rows) ----

interface ResolutionBlockProps {
  resolution: ActionQueueResolution
}

const ResolutionBlock = ({ resolution }: ResolutionBlockProps) => (
  <div data-testid="resolution-block">
    <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
      Resolution
    </dt>
    <dd className="flex flex-col gap-1">
      <span className="font-mono text-[11px] text-fg">
        {resolution.resolution ?? '(closed)'}
      </span>
      <span className="font-mono text-[10px] text-iron/70">
        {formatTime(resolution.resolvedAt)}
        {resolution.resolvedBy ? ` · ${resolution.resolvedBy}` : null}
      </span>
      {resolution.resolutionNote ? (
        <p className="whitespace-pre-wrap font-mono text-[11px] text-iron">
          {resolution.resolutionNote}
        </p>
      ) : null}
      {resolution.rootCause ? (
        <div className="mt-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-iron/70">
            Root cause:{' '}
          </span>
          <span className="font-mono text-[11px] text-iron">
            {resolution.rootCause}
          </span>
        </div>
      ) : null}
    </dd>
  </div>
)

// ---- Action bar ----

interface ActionBarProps {
  item: ActionQueueItem
}

// Op strings used in multiple places inside ActionBar; defined once to avoid drift.
const INVESTIGATE_OP = 'investigate'
const DIAGNOSE_OP = 'diagnose-failure'

/**
 * Ops that are process-level and carry no entity id when forwarded to the
 * daemon. The proxy builds `/actions/<op>` (no id segment) for these; any
 * other op gets `/actions/<op>/<entityId>`.
 */
export const PROCESS_LEVEL_OPS = new Set(['restart-daemon', 'restart-all-daemon-killed'])

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
  const projectId = useFocusedProjectId()
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
      // Process-level ops (restart-daemon, restart-all-daemon-killed) carry no entity id.
      const entityId = PROCESS_LEVEL_OPS.has(action.op) ? undefined : item.entityId
      return invokeAction(action.op, entityId)
    },
    onMutate: async () => {
      setErrorMsg(null)
      // Prevent an in-flight refetch from overwriting our optimistic removal.
      await qc.cancelQueries({ queryKey: ['action-queue'] })
      // Snapshot the current list so we can roll back on error.
      const snapshot = qc.getQueryData<ActionQueueItem[]>(['action-queue', projectId])
      // Optimistically remove this item so the row disappears immediately.
      if (snapshot) {
        qc.setQueryData(
          ['action-queue', projectId],
          snapshot.filter((i) => i.id !== item.id),
        )
      }
      return { snapshot }
    },
    onError: (err, _vars, context) => {
      setErrorMsg((err as Error).message)
      // Roll back the optimistic removal so the row reappears.
      if (context?.snapshot !== undefined) {
        qc.setQueryData(['action-queue', projectId], context.snapshot)
      }
    },
    onSettled: () => {
      // Always reconcile with the server after the mutation settles (success or
      // error).  If the server already superseded the row, the refetch drops it
      // and any transient error never sticks.
      void qc.invalidateQueries({ queryKey: ['action-queue'] })
      void qc.invalidateQueries({ queryKey: ['progress'] })
    },
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
              <li key={e.id} className={`rounded border ${severityRowClass(e.severity)} px-2 py-1 text-fg`}>
                <span className="text-iron/60">{relativeTime(e.timestamp)}</span>{' '}
                <span className={`font-mono text-[10px] uppercase ${e.severity !== 'info' ? 'font-semibold ' : ''}${severityColor(e.severity)}`}>
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
                <span className={marsToolTextClass(e)}>{summarizeTraceEvent(e)}</span>
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

// ---- Proposal detail section ----

/** Lazy-fetches the full proposal by id and renders Problem / Solution / User stories / etc. */
const ProposalDetailSection = ({ proposalId }: { proposalId: string }) => {
  const projectId = useFocusedProjectId()

  const query = useQuery({
    queryKey: ['proposal-detail', projectId, proposalId],
    queryFn: () => fetchProposalDetail(proposalId, projectId ?? undefined),
    enabled: projectId !== null,
  })

  if (query.isPending) {
    return (
      <div>
        <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
          Proposal
        </dt>
        <dd className="text-iron/60">Loading…</dd>
      </div>
    )
  }

  if (query.isError || !query.data) {
    return (
      <div>
        <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
          Proposal
        </dt>
        <dd className="text-iron/60">(could not load proposal)</dd>
      </div>
    )
  }

  const p = query.data

  return (
    <>
      <div>
        <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
          Problem
        </dt>
        <dd className="whitespace-pre-wrap text-fg">{p.problem || <span className="text-iron/70">(none)</span>}</dd>
      </div>
      <div>
        <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
          Solution
        </dt>
        <dd className="whitespace-pre-wrap text-fg">{p.solution || <span className="text-iron/70">(none)</span>}</dd>
      </div>
      {p.userStories.length > 0 ? (
        <div>
          <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
            User stories
          </dt>
          <dd>
            <ol className="list-decimal pl-4 text-fg">
              {p.userStories.map((story, i) => (
                <li key={i} className="mb-0.5 text-[12px]">{story}</li>
              ))}
            </ol>
          </dd>
        </div>
      ) : null}
      {p.outOfScope ? (
        <div>
          <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
            Out of scope
          </dt>
          <dd className="whitespace-pre-wrap text-fg">{p.outOfScope}</dd>
        </div>
      ) : null}
      {p.notes ? (
        <div>
          <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
            Notes
          </dt>
          <dd className="whitespace-pre-wrap text-fg">{p.notes}</dd>
        </div>
      ) : null}
      <div>
        <dd className="text-[10px] text-iron/60">
          Status: {p.status} · from {p.source} · {new Date(p.createdAt).toLocaleDateString()}
        </dd>
      </div>
    </>
  )
}

// ---- Detail panel ----

interface DetailProps {
  item: ActionQueueItem
  /** When provided, origin-tree nodes become navigable buttons that call this with the node id. */
  onNavigateToTask?: (taskId: string) => void
}

export const ActionQueueDetail = ({ item, onNavigateToTask }: DetailProps) => {
  // A real failed task (not the daemon-killed-batch sentinel, and carrying a
  // non-empty entity id) can open the shared TaskDetailDrawer and render the
  // OriginTree. An empty entityId would make OriginTree fetch
  // `/api/origins/?project=…` and 400; treat such a row as non-openable. The
  // `from=action-queue` tag keeps the Action queue list mounted behind the
  // drawer and returns here on close.
  const isRealFailedTask =
    item.kind === 'failed-task' &&
    item.entityId !== '__daemon-killed-batch__' &&
    item.entityId !== ''

  const openTask = (id: string) => {
    window.location.hash = taskHash(id, 'action-queue')
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-auto">
      <header className="min-w-0 border-b border-iron/30 px-6 py-4">
        {/* Headline: original task id, kind badge, priority */}
        <div className="flex items-baseline gap-3">
          <span className="break-all font-mono text-[11px] uppercase text-iron">
            {item.entityId}
          </span>
          <span className="shrink-0 font-mono text-[10px] uppercase text-iron/80">
            {kindBadgeLabel(item.kind)}
          </span>
          <span
            className={`ml-auto font-mono text-[10px] uppercase ${priorityBadgeClass(item.priority)}`}
          >
            {item.priority}
          </span>
        </div>
        {/* For arc-failed: goal is the headline, reason is the subordinate line. */}
        {/* For all other kinds: title is the headline, body shown for failed-task. */}
        {item.kind === 'arc-failed' ? (
          <>
            <h2 className="mt-2 break-all font-mono text-[15px] text-fg">
              {item.goal || '(no goal)'}
            </h2>
            <p className="mt-1 whitespace-pre-wrap font-mono text-[12px] text-fg/80">
              {item.reason}
            </p>
          </>
        ) : (
          <>
            <h2 className="mt-2 break-all font-mono text-[15px] text-fg">
              {item.title || '(no title)'}
            </h2>
            {item.kind === 'failed-task' && item.body ? (
              <p className="mt-2 whitespace-pre-wrap font-mono text-[12px] text-fg/80">
                {item.body}
              </p>
            ) : null}
          </>
        )}
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
          {/* Resolution block — shown for resolved history rows; suppresses ActionBar. */}
          {item.resolution ? (
            <ResolutionBlock resolution={item.resolution} />
          ) : (
            /* Recovery actions — shown only for live (open) rows. */
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
          {/* Arc chain rail — navigable Proposal-to-Attempt chain for arc-failed alerts. */}
          {item.kind === 'arc-failed' ? (
            <ArcChainRail
              chain={item.chain}
              onSelectTask={openTask}
              onOpenProposal={(id) => { window.location.hash = proposalHash(id) }}
            />
          ) : null}
          {/* Origin / recovery chain — navigable links between origin and fix tasks. */}
          {isRealFailedTask ? (
            <OriginTree
              taskId={item.entityId}
              onNavigate={onNavigateToTask}
            />
          ) : null}
          {/* Draft-proposal: rich proposal content lazy-fetched from the daemon. */}
          {item.kind === 'draft-proposal' ? (
            <ProposalDetailSection proposalId={item.entityId} />
          ) : null}
          {/* Details — shown for stale-worktree rows (body text). */}
          {item.kind === 'stale-worktree' ? (
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
              {/* Arc tree — DOM-based indented rail */}
              <ArcTree
                dag={item.dag}
                entityId={item.entityId}
                entityStatus={isRealFailedTask ? 'failed' : 'running'}
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
  const {
    items: historyItems,
    nextCursor: historyNextCursor,
    isLoadingMore: historyLoadingMore,
    loadMore: loadMoreHistory,
  } = useActionQueueHistory()

  const [query, setQuery] = useState<string>('')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  // Selected id — may be a live item or a history item.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // History accordion: collapsed by default.
  const [historyOpen, setHistoryOpen] = useState(false)

  const qc = useQueryClient()
  const projectId = useFocusedProjectId()
  const restartMutation = useMutation({
    mutationFn: (entityId: string) => invokeAction('restart', entityId),
    onMutate: async (entityId) => {
      // Prevent an in-flight refetch from overwriting our optimistic removal.
      await qc.cancelQueries({ queryKey: ['action-queue'] })
      // Snapshot for rollback.
      const snapshot = qc.getQueryData<ActionQueueItem[]>(['action-queue', projectId])
      // Optimistically remove the row that triggered the restart.
      if (snapshot) {
        qc.setQueryData(
          ['action-queue', projectId],
          snapshot.filter((i) => i.entityId !== entityId),
        )
      }
      return { snapshot }
    },
    onError: (_err, _entityId, context) => {
      // Roll back the optimistic removal.
      if (context?.snapshot !== undefined) {
        qc.setQueryData(['action-queue', projectId], context.snapshot)
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['action-queue'] })
      void qc.invalidateQueries({ queryKey: ['progress'] })
    },
  })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter(
      (i) =>
        matchesKindFilter(i, kindFilter) &&
        (!q ||
          i.id.toLowerCase().includes(q) ||
          i.title.toLowerCase().includes(q) ||
          i.body.toLowerCase().includes(q) ||
          i.kind.toLowerCase().includes(q)),
    )
  }, [items, query, kindFilter])

  // Resolve selected item from live rows first, then from history rows.
  const selectedLive = filtered.find((i) => i.id === selectedId) ?? null
  const selectedHistory = !selectedLive
    ? historyItems.find((i) => i.id === selectedId) ?? null
    : null
  const selected = selectedLive ?? selectedHistory ?? filtered[0] ?? null
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
    'arc-failed': true,
  })

  const toggleSection = useCallback((kind: ActionQueueItem['kind']) => {
    setOpenSections((prev) => ({ ...prev, [kind]: !prev[kind] }))
  }, [])

  // Group filtered items by kind while preserving within-group server order.
  const grouped = useMemo(() => ({
    'draft-proposal': filtered.filter((i) => i.kind === 'draft-proposal'),
    'failed-task': filtered.filter((i) => i.kind === 'failed-task'),
    'stale-worktree': filtered.filter((i) => i.kind === 'stale-worktree'),
    'arc-failed': filtered.filter((i) => i.kind === 'arc-failed'),
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
          <div
            role="group"
            aria-label="Filter action queue by kind"
            className="mt-2 flex border border-iron/30"
          >
            {(['all', 'alerts', 'drafts'] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={kindFilter === f}
                data-testid={`action-queue-filter-${f}`}
                onClick={() => setKindFilter(f)}
                className={[
                  'flex-1 border-r border-iron/30 px-2 py-0.5 font-mono text-[10px] last:border-r-0 focus:outline-none focus:ring-1 focus:ring-iron/50',
                  kindFilter === f ? 'bg-iron/20 text-fg' : 'bg-bg text-iron',
                ].join(' ')}
              >
                {f === 'all' ? 'All' : f === 'alerts' ? 'Alerts' : 'Drafts'}
              </button>
            ))}
          </div>
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
                ['failed-task', 'Failed tasks'],
                ['draft-proposal', 'Drafts'],
                ['arc-failed', 'Failed arcs'],
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

          {/* History accordion — collapsed by default, at the bottom of the sidebar */}
          <div data-testid="history-accordion">
            <button
              type="button"
              aria-expanded={historyOpen}
              aria-controls="section-body-history"
              onClick={() => setHistoryOpen((v) => !v)}
              className="flex w-full items-center justify-between border-b border-t border-iron/20 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-iron/60 hover:bg-iron/5"
            >
              <span>History ({historyItems.length} loaded)</span>
              <span aria-hidden="true">{historyOpen ? '▾' : '▸'}</span>
            </button>
            {historyOpen && (
              <div id="section-body-history">
                {historyItems.length === 0 ? (
                  <p className="px-3 py-2 font-mono text-[11px] text-iron/40">
                    No resolved items.
                  </p>
                ) : (
                  historyItems.map((item) => (
                    <div
                      key={item.id}
                      data-testid="history-row"
                      className={[
                        'cursor-pointer px-3 py-2 transition-colors',
                        item.id === (selected?.id ?? null) ? 'bg-iron/20' : 'hover:bg-iron/10',
                      ].join(' ')}
                      onClick={() => handleSelect(item.id)}
                    >
                      <div className="flex items-baseline gap-2">
                        {item.kind !== 'failed-task' && (
                          <span className="shrink-0 font-mono text-[9px] uppercase text-iron/60">
                            {kindBadgeLabel(item.kind)}
                          </span>
                        )}
                        <span className="break-all font-mono text-[10px] text-iron/70">
                          {item.entityId}
                        </span>
                      </div>
                      <div className="mt-0.5 break-words font-mono text-[11px] text-iron/70">
                        {(item.resolution?.resolution ?? item.title) || '(no title)'}
                      </div>
                      <div className="mt-0.5 font-mono text-[10px] text-iron/40">
                        {item.resolution
                          ? relativeTime(item.resolution.resolvedAt)
                          : relativeTime(item.at)}
                      </div>
                    </div>
                  ))
                )}
                {historyNextCursor !== null ? (
                  <button
                    type="button"
                    data-testid="history-load-more"
                    disabled={historyLoadingMore}
                    onClick={loadMoreHistory}
                    className="w-full border-t border-iron/20 px-3 py-1.5 font-mono text-[10px] uppercase text-iron/60 hover:bg-iron/5 disabled:opacity-50"
                  >
                    {historyLoadingMore ? 'Loading…' : 'Load more'}
                  </button>
                ) : null}
              </div>
            )}
          </div>
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
        ) : empty && !selected ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="font-mono text-[12px] text-iron">
              No items. Action queue alerts appear here when tasks need operator attention.
            </div>
          </div>
        ) : noMatches && !selected ? (
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
