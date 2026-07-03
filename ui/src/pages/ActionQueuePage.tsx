import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readAqStateFromUrl, writeAqStateToUrl } from '@/shared/actionQueueUrlState'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FallbackSurface } from '@/components/FallbackSurface'
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
import { resolveFallback } from '@/shared/uiFallback'

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
  return 'text-muted'
}

export type KindFilter = 'all' | 'alerts' | 'drafts'

/** Pure helper: returns true when `item` should be shown for the given `filter`. */
export function matchesKindFilter(item: ActionQueueItem, filter: KindFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'alerts')
    return (
      item.kind === 'failed-task' ||
      item.kind === 'stale-worktree' ||
      item.kind === 'awaiting-validation'
    )
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
    <div
      className={baseClass}
      role="button"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      data-aq-row=""
      onClick={() => onSelect(item.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(item.id)
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const allRows = Array.from(
            document.querySelectorAll<HTMLElement>('[data-aq-row]'),
          )
          const idx = allRows.indexOf(e.currentTarget)
          const next = e.key === 'ArrowDown' ? allRows[idx + 1] : allRows[idx - 1]
          next?.focus()
        }
      }}
    >
      <div className="flex items-baseline gap-2">
        {item.kind !== 'failed-task' && (
          <span className="shrink-0 font-mono text-[9px] uppercase text-muted">
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
      <div className="mt-1 line-clamp-4 break-words font-mono text-[12px] text-fg">
        {item.title || '(no title)'}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-muted" title={formatTime(item.at)}>
          {relativeTime(item.at)}
        </span>
        {onRestart !== null && (
          <button
            type="button"
            aria-label={`Restart ${item.entityId}`}
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
      <span className="font-mono text-[10px] text-muted" title={formatTime(resolution.resolvedAt)}>
        {relativeTime(resolution.resolvedAt)}
        {resolution.resolvedBy ? ` · ${resolution.resolvedBy}` : null}
      </span>
      {resolution.resolutionNote ? (
        <p className="whitespace-pre-wrap font-mono text-[11px] text-iron">
          {resolution.resolutionNote}
        </p>
      ) : null}
      {resolution.rootCause ? (
        <div className="mt-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
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
 * Maps a mutation error to a human-readable message. Delegates to
 * `resolveFallback` — the single seam that reads `ApiError.kind` and owns the
 * remedy copy — so the daemon start/restart guidance stays in one place rather
 * than being re-derived here. Returns the headline joined with the remedy when
 * one is known, otherwise just the headline.
 *
 * Exported for unit-testing the mapping logic in isolation.
 */
export function actionErrorMessage(err: unknown): string {
  const fb = resolveFallback(err, 'action')
  return fb.remedy ? `${fb.headline} ${fb.remedy}` : fb.headline
}

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
  // Two-step confirm: tracks which needsConfirm action is awaiting a second click.
  const [pendingConfirmId, setPendingConfirmId] = useState<string | null>(null)
  const pendingConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear both transient timers on unmount to avoid setState-after-unmount.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
      if (pendingConfirmTimerRef.current !== null) clearTimeout(pendingConfirmTimerRef.current)
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
      setErrorMsg(actionErrorMessage(err))
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

  const clearPendingConfirm = () => {
    if (pendingConfirmTimerRef.current !== null) {
      clearTimeout(pendingConfirmTimerRef.current)
      pendingConfirmTimerRef.current = null
    }
    setPendingConfirmId(null)
  }

  const run = (action: ActionDescriptor) => {
    if (mutation.isPending) return
    if (action.needsConfirm) {
      if (pendingConfirmId === action.id) {
        // Second click — confirmed; fire the mutation.
        clearPendingConfirm()
        mutation.mutate({ action })
      } else {
        // First click — arm the confirm; revert after 3 s if not confirmed.
        if (pendingConfirmTimerRef.current !== null) clearTimeout(pendingConfirmTimerRef.current)
        setPendingConfirmId(action.id)
        pendingConfirmTimerRef.current = setTimeout(() => {
          setPendingConfirmId(null)
          pendingConfirmTimerRef.current = null
        }, 3000)
      }
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
    <div
      onKeyDown={(e) => {
        if (e.key === 'Escape' && pendingConfirmId !== null) {
          e.stopPropagation()
          clearPendingConfirm()
        }
      }}
    >
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
              data-testid={action.needsConfirm ? `confirm-step-${action.id}` : undefined}
              data-confirm-pending={pendingConfirmId === action.id ? 'true' : undefined}
              className={[
                'border px-3 py-1.5 font-mono text-[11px] uppercase transition active:scale-[0.97] disabled:opacity-50',
                pendingConfirmId === action.id
                  ? 'border-error bg-error/10 text-error'
                  : action.needsConfirm
                    ? 'border-error/50 text-error hover:bg-error/10'
                    : 'border-iron/40 text-fg hover:bg-iron/20',
              ].join(' ')}
            >
              {pendingConfirmId === action.id
                ? `Confirm ${action.label}?`
                : action.op === INVESTIGATE_OP && isInvestigating
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

  if (initial.isPending) {
    return (
      <div>
        <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
          Traces
        </dt>
        <dd className="text-muted">Loading…</dd>
      </div>
    )
  }
  if (initial.isError || !initial.data) {
    return (
      <div>
        <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
          Traces
        </dt>
        <FallbackSurface error={initial.error} of="trace events" variant="inline" />
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
        <dd className="text-muted">No trace events for this task yet.</dd>
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
                <span className="text-muted">{relativeTime(e.timestamp)}</span>{' '}
                <span className={`font-mono text-[10px] uppercase ${e.severity !== 'info' ? 'font-semibold ' : ''}${severityColor(e.severity)}`}>
                  [{e.severity}]
                </span>{' '}
                <span className="font-mono text-[10px] text-iron">{e.kind}</span>
                {e.phase ? (
                  <span className="font-mono text-[10px] text-muted">
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
            className="mt-1 inline-flex min-h-[24px] items-center px-2 py-1 font-mono text-[10px] uppercase text-fg underline disabled:opacity-50"
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
        <dd className="text-muted">Loading…</dd>
      </div>
    )
  }

  if (query.isError || !query.data) {
    return (
      <div>
        <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
          Proposal
        </dt>
        <dd className="text-muted">(could not load proposal)</dd>
      </div>
    )
  }

  const p = query.data

  return (
    <>
      {p.problem ? (
        <div>
          <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
            Problem
          </dt>
          <dd className="whitespace-pre-wrap text-fg">{p.problem}</dd>
        </div>
      ) : null}
      {p.solution ? (
        <div>
          <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
            Solution
          </dt>
          <dd className="whitespace-pre-wrap text-fg">{p.solution}</dd>
        </div>
      ) : null}
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
        <dd className="text-[10px] text-muted">
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
          <span className="shrink-0 font-mono text-[10px] uppercase text-muted">
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
            {(item.kind === 'failed-task' || item.kind === 'awaiting-validation') &&
            item.body ? (
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
        <dl className="flex flex-col gap-4 font-mono text-[12px] max-w-[75ch]">
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
                    <span className="text-muted">absent (no matching task)</span>
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
                      <p className="mb-1 text-[10px] text-muted" title={formatTime(item.staleWorktreeDetail.updatedAt)}>
                        {relativeTime(item.staleWorktreeDetail.updatedAt)}
                      </p>
                      <p className="whitespace-pre-wrap text-fg">
                        {item.staleWorktreeDetail.investigation}
                      </p>
                    </>
                  ) : item.staleWorktreeDetail.empty ? null : (
                    <span className="text-muted">
                      None yet — use Investigate to analyse this worktree.
                    </span>
                  )}
                </dd>
              </div>
            </>
          )}
          {/* Preview gate: clickable live dev-server URL the operator opens
              before clicking Validate / Reject in the action bar above. */}
          {item.kind === 'awaiting-validation' && item.devServerUrl ? (
            <div>
              <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
                Live preview
              </dt>
              <dd>
                <a
                  href={item.devServerUrl}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="aq-preview-url"
                  className="break-all font-mono text-[12px] text-fg underline decoration-iron/50 underline-offset-2 transition-colors hover:text-fg hover:decoration-fg"
                >
                  {item.devServerUrl}
                </a>
                <p className="mt-1 text-[10px] text-muted">
                  Opens in a new tab. Validate to merge, or Reject to stop the
                  merge and fail the task (its worktree is kept).
                </p>
              </dd>
            </div>
          ) : null}
          {/* Diagnosis before the origin chain so context is established first. */}
          {item.diagnosis ? (
            <div>
              <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
                Diagnosis
              </dt>
              <dd>
                <p className="mb-1 text-[10px] text-muted" title={formatTime(item.diagnosis.diagnosedAt)}>
                  {relativeTime(item.diagnosis.diagnosedAt)}
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
                  <span className="text-muted">(no details recorded)</span>
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
                onOpenTask={openTask}
              />
            </>
          )}
          {/* Traces — bounded scroll so they never push the rest of the card off-screen. */}
          {isRealFailedTask ? (
            <TracesSection taskId={item.entityId} />
          ) : null}
        </dl>
      </main>
      <footer className="border-t border-iron/30 px-6 py-3 font-mono text-[10px] text-muted">
        {isRealFailedTask ? 'Failed' : 'Last activity'}: {relativeTime(item.at)}
      </footer>
    </div>
  )
}

// ---- Page ----

export const ActionQueuePage = () => {
  const { items, error, projectsError, projectsEmpty } = useActionQueue()
  /** The first non-null error from either query — drives the ApiErrorPanel. */
  const activeError = error ?? projectsError
  const {
    items: historyItems,
    nextCursor: historyNextCursor,
    isLoadingMore: historyLoadingMore,
    loadMore: loadMoreHistory,
  } = useActionQueueHistory()

  // Initialise filter state from the URL hash so F5 restores selection + filters.
  const [query, setQuery] = useState<string>(() => readAqStateFromUrl().q)
  const [kindFilter, setKindFilter] = useState<KindFilter>(() => readAqStateFromUrl().kind)
  // Selected id — may be a live item or a history item.
  const [selectedId, setSelectedId] = useState<string | null>(() => readAqStateFromUrl().item)
  // History accordion: collapsed by default.
  const [historyOpen, setHistoryOpen] = useState(false)

  const qc = useQueryClient()
  const projectId = useFocusedProjectId()

  // Undo-toast state: when a restart is queued but not yet fired, the user has
  // 5 s to cancel. The snapshot is held in a ref so the rollback doesn't need
  // it in component state.
  const [restartToast, setRestartToast] = useState<{ entityId: string } | null>(null)
  const restartToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restartSnapshotRef = useRef<ActionQueueItem[] | null>(null)

  // Clear the undo-toast timer on unmount to avoid setState-after-unmount.
  useEffect(() => {
    return () => {
      if (restartToastTimerRef.current !== null) clearTimeout(restartToastTimerRef.current)
    }
  }, [])

  const restartMutation = useMutation({
    mutationFn: (entityId: string) => invokeAction('restart', entityId),
    onError: () => {
      // Roll back the optimistic removal using the snapshot held by the toast flow.
      if (restartSnapshotRef.current !== null) {
        qc.setQueryData(['action-queue', projectId], restartSnapshotRef.current)
      }
    },
    onSettled: () => {
      restartSnapshotRef.current = null
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
  const selectedHistory = historyItems.find((i) => i.id === selectedId) ?? null
  const selectedItem = selectedLive ?? selectedHistory

  // "Resolved" when selectedId is explicitly pinned but the item has vanished from
  // all live data (not just filtered out by the current search).  Guard with
  // items.length > 0 so we don't flash "resolved" during the initial empty-load frame.
  const isResolved =
    selectedId !== null &&
    selectedItem === null &&
    items.length > 0 &&
    items.find((i) => i.id === selectedId) == null

  // Show the found item when selectedId is set; fall back to the first filtered
  // item only when there is no explicit selection (selectedId === null).
  const selected = selectedItem ?? (selectedId === null ? (filtered[0] ?? null) : null)
  const empty = items.length === 0
  const noMatches = !empty && filtered.length === 0

  // On first data arrival, pin selection explicitly so SSE reorders don't silently
  // swap the detail pane mid-read.  Also re-pins after the user dismisses a
  // "resolved" pane (which sets selectedId back to null).
  useEffect(() => {
    if (selectedId === null && filtered.length > 0) {
      setSelectedId(filtered[0].id)
    }
  }, [filtered, selectedId])

  // Debounced URL write-back — mirrors selectedId, kindFilter, and search so F5
  // restores the exact view.  Uses replaceState (no hashchange event) to avoid
  // disturbing the app-level hash router.
  const urlWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (urlWriteTimerRef.current !== null) clearTimeout(urlWriteTimerRef.current)
    urlWriteTimerRef.current = setTimeout(() => {
      writeAqStateToUrl({ item: selectedId, kind: kindFilter, q: query })
    }, 300)
    return () => {
      if (urlWriteTimerRef.current !== null) clearTimeout(urlWriteTimerRef.current)
    }
  }, [selectedId, kindFilter, query])

  // Stable callbacks — prevent per-item lambda allocation on every render.
  const handleSelect = useCallback((id: string) => {
    setSelectedId(id)
  }, [])

  const handleRestart = useCallback(async (entityId: string) => {
    // Cancel in-flight refetches to prevent cache overwrites during the toast window.
    await qc.cancelQueries({ queryKey: ['action-queue'] })
    // Snapshot before optimistic removal so the undo can restore it.
    const snapshot = qc.getQueryData<ActionQueueItem[]>(['action-queue', projectId]) ?? null
    restartSnapshotRef.current = snapshot
    // Optimistically remove the row immediately so the UI feels instant.
    qc.setQueryData(
      ['action-queue', projectId],
      (snapshot ?? []).filter((i) => i.entityId !== entityId),
    )
    // Show the undo toast; fire the actual mutation after 5 s unless undone.
    setRestartToast({ entityId })
    if (restartToastTimerRef.current !== null) clearTimeout(restartToastTimerRef.current)
    restartToastTimerRef.current = setTimeout(() => {
      restartToastTimerRef.current = null
      setRestartToast(null)
      restartMutation.mutate(entityId)
    }, 5000)
  }, [qc, projectId, restartMutation])

  const handleRestartUndo = useCallback(() => {
    if (restartToastTimerRef.current !== null) {
      clearTimeout(restartToastTimerRef.current)
      restartToastTimerRef.current = null
    }
    if (restartSnapshotRef.current !== null) {
      qc.setQueryData(['action-queue', projectId], restartSnapshotRef.current)
      restartSnapshotRef.current = null
    }
    setRestartToast(null)
  }, [qc, projectId])

  // Per-section open/collapsed state; all sections start expanded.
  const [openSections, setOpenSections] = useState<Record<ActionQueueItem['kind'], boolean>>({
    'draft-proposal': true,
    'failed-task': true,
    'stale-worktree': true,
    'awaiting-validation': true,
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
    'awaiting-validation': filtered.filter((i) => i.kind === 'awaiting-validation'),
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
            className="mt-2 w-full border border-iron/30 bg-bg px-2 py-1 font-mono text-[12px] text-fg placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-iron/50"
          />
        </header>

        <div className="flex-1 overflow-auto">
          {filtered.length === 0 && (query.trim() || (!projectsEmpty && !projectsError)) ? (
            <p className="px-3 py-2 font-mono text-[11px] text-muted">
              {query.trim() ? 'No matches.' : 'No items.'}
            </p>
          ) : filtered.length > 0 ? (
            <div>
              {([
                ['awaiting-validation', 'Awaiting validation'],
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
                            active={item.id === selectedId}
                            onSelect={handleSelect}
                            onRestart={
                              item.actions.some((a) => a.op === 'restart')
                                ? handleRestart
                                : null
                            }
                            restartPending={
                              (restartToast !== null && restartToast.entityId === item.entityId) ||
                              (restartMutation.isPending &&
                                restartMutation.variables === item.entityId)
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
              className="flex w-full items-center justify-between border-b border-t border-iron/20 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-muted hover:bg-iron/5"
            >
              <span>History ({historyItems.length} loaded)</span>
              <span aria-hidden="true">{historyOpen ? '▾' : '▸'}</span>
            </button>
            {historyOpen && (
              <div id="section-body-history">
                {historyItems.length === 0 ? (
                  <p className="px-3 py-2 font-mono text-[11px] text-muted">
                    No resolved items.
                  </p>
                ) : (
                  historyItems.map((item) => (
                    <div
                      key={item.id}
                      data-testid="history-row"
                      data-aq-row=""
                      role="button"
                      tabIndex={0}
                      aria-current={item.id === selectedId ? 'true' : undefined}
                      className={[
                        'cursor-pointer px-3 py-2 transition-colors',
                        item.id === selectedId ? 'bg-iron/20' : 'hover:bg-iron/10',
                      ].join(' ')}
                      onClick={() => handleSelect(item.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          handleSelect(item.id)
                        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                          e.preventDefault()
                          const allRows = Array.from(
                            document.querySelectorAll<HTMLElement>('[data-aq-row]'),
                          )
                          const idx = allRows.indexOf(e.currentTarget)
                          const next = e.key === 'ArrowDown' ? allRows[idx + 1] : allRows[idx - 1]
                          next?.focus()
                        }
                      }}
                    >
                      <div className="flex items-baseline gap-2">
                        {item.kind !== 'failed-task' && (
                          <span className="shrink-0 font-mono text-[9px] uppercase text-muted">
                            {kindBadgeLabel(item.kind)}
                          </span>
                        )}
                        <span className="break-all font-mono text-[10px] text-muted">
                          {item.entityId}
                        </span>
                      </div>
                      <div className="mt-0.5 break-words font-mono text-[11px] text-muted">
                        {(item.resolution?.resolution ?? item.title) || '(no title)'}
                      </div>
                      <div className="mt-0.5 font-mono text-[10px] text-muted">
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
                    className="w-full border-t border-iron/20 px-3 py-1.5 font-mono text-[10px] uppercase text-muted hover:bg-iron/5 disabled:opacity-50"
                  >
                    {historyLoadingMore ? 'Loading…' : 'Load more'}
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </div>

        {activeError ? (
          <div className="border-t border-iron/40 bg-iron/10 px-4 py-1.5 font-mono text-[10px] text-iron">
            {activeError.message}
          </div>
        ) : null}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {empty && activeError ? (
          <FallbackSurface error={activeError} of="action queue" variant="pane" />
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
              <p className="mt-1 text-muted">
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
        ) : isResolved ? (
          <div
            data-testid="resolved-pane"
            className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
          >
            <p className="font-mono text-[13px] text-fg">This item has been resolved.</p>
            <p className="font-mono text-[11px] text-iron">
              It was removed from the action queue.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                className="border border-iron/40 px-3 py-1 font-mono text-[11px] text-iron hover:bg-iron/10"
                onClick={() => {
                  window.location.hash = taskHash(
                    selectedId!.includes(':') ? selectedId!.split(':').slice(1).join(':') : selectedId!,
                    'action-queue',
                  )
                }}
              >
                View task →
              </button>
              <button
                type="button"
                className="border border-iron/40 px-3 py-1 font-mono text-[11px] text-iron hover:bg-iron/10"
                onClick={() => setSelectedId(filtered.length > 0 ? filtered[0].id : null)}
              >
                ← Back to queue
              </button>
            </div>
          </div>
        ) : selected ? (
          <ActionQueueDetail
            key={selected.id}
            item={selected}
            onNavigateToTask={(taskId: string) => {
              const found = filtered.find((i) => i.entityId === taskId)
              if (found) {
                setSelectedId(found.id)
              } else {
                window.location.hash = taskHash(taskId, 'action-queue')
              }
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center font-mono text-[12px] text-iron">
            Select an item
          </div>
        )}
      </section>

      {/* Undo toast — shown for 5 s after a Restart click; lets operators cancel misclicks. */}
      {restartToast !== null && (
        <div
          data-testid="restart-undo-toast"
          role="status"
          aria-live="polite"
          className="fixed bottom-5 right-5 z-50 flex items-center gap-3 border border-iron/40 bg-bg px-4 py-2 font-mono text-[11px] text-fg shadow-lg"
        >
          <span>Restarting {restartToast.entityId}…</span>
          <button
            type="button"
            onClick={handleRestartUndo}
            className="border border-iron/40 px-2 py-0.5 font-mono text-[10px] uppercase text-iron transition hover:bg-iron/10 active:scale-[0.97]"
          >
            Undo
          </button>
        </div>
      )}
    </div>
  )
}
