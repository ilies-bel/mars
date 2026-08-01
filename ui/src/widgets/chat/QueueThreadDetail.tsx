/**
 * QueueThreadDetail — the detail pane shown in the chat main area when a
 * projection Thread with no conversation is selected.
 *
 * Renders the plain-English body, kind-specific detail (diagnosis, stale
 * worktree, live-preview gate, arc chain, origin tree, traces, proposal
 * content), and the Decision bar (ActionBar) with its two-step needsConfirm
 * behaviour and copy-op affordance. Resolved history rows render a read-only
 * Resolution block instead of the ActionBar.
 */

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FallbackSurface } from '@/components/FallbackSurface'
import { CopyButton } from '@/components/CopyButton'
import { OriginTree } from '@/widgets/OriginTree'
import ArcChainRail from '@/widgets/ArcChainRail'
import { ArcTree } from '@/widgets/ArcTree'
import { fetchEvents, fetchLearnedRecipes, fetchProposalDetail, invokeAction, teachRecipe, unlearnRecipe } from '@/shared/api'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import {
  kindBadgeLabel,
  severityColor,
  severityRowClass,
  summarizeTraceEvent,
  marsToolTextClass,
} from '@/shared/actionQueueDetail'
import { isTaskFailureActionQueueKind } from '@/shared/schemas'
import type {
  ActionDescriptor,
  ActionQueueItem,
  ActionQueueResolution,
  TraceEvent,
} from '@/shared/schemas'
import { relativeTime } from '@/shared/time'
import { taskHash, proposalHash } from '@/shared/routing'
import { resolveFallback } from '@/shared/uiFallback'
import { formatTime, priorityBadgeClass } from './QueueThreadRow'

// ---- Resolution block (read-only; shown for resolved history rows) ----

interface ResolutionBlockProps {
  resolution: ActionQueueResolution
}

const ResolutionBlock = ({ resolution }: ResolutionBlockProps) => (
  <div data-testid="resolution-block">
    <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
      Resolution
    </dt>
    <dd className="flex flex-col gap-1">
      <span className="font-mono text-[11px] text-foreground">
        {resolution.resolution ?? '(closed)'}
      </span>
      <span className="font-mono text-[10px] text-muted-foreground" title={formatTime(resolution.resolvedAt)}>
        {relativeTime(resolution.resolvedAt)}
        {resolution.resolvedBy ? ` · ${resolution.resolvedBy}` : null}
      </span>
      {resolution.resolutionNote ? (
        <p className="whitespace-pre-wrap font-mono text-[11px] text-primary">
          {resolution.resolutionNote}
        </p>
      ) : null}
      {resolution.rootCause ? (
        <div className="mt-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Root cause:{' '}
          </span>
          <span className="font-mono text-[11px] text-primary">
            {resolution.rootCause}
          </span>
        </div>
      ) : null}
    </dd>
  </div>
)

// ---- Action bar (Decisions) ----

interface ActionBarProps {
  item: ActionQueueItem
}

// Op strings used in multiple places inside ActionBar; defined once to avoid drift.
const INVESTIGATE_OP = 'investigate'
const DIAGNOSE_OP = 'diagnose-failure'

/**
 * Ops the daemon can auto-run when a recipe is taught. Matches the
 * `executeLearnedOp` implementation in `learned-recipes.ts`.
 */
export const TEACHABLE_OPS = new Set(['restart', 'purge'])

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
 * Renders one Decision button per action on the row. Clicking proxies the
 * action's `op` to the daemon (via `/api/actions`). `needsConfirm` actions
 * use a two-step armed confirm (3 s revert); destructive ops are styled
 * accordingly. The `copy` op copies `action.hint` (or `action.label`) to the
 * clipboard and shows a transient 'Copied ✓' confirmation — it does NOT call
 * the daemon.
 *
 * For stale-worktree rows where `empty === true` the Investigate action is
 * suppressed (nothing to analyse in an empty worktree).
 */
export const ActionBar = ({ item }: ActionBarProps) => {
  const qc = useQueryClient()
  const projectId = useFocusedProjectId()
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // Two-step confirm: tracks which needsConfirm action is awaiting a second click.
  const [pendingConfirmId, setPendingConfirmId] = useState<string | null>(null)
  const pendingConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Teach prompt: shown after a successful teachable-op mutation.
  const [teachPromptOp, setTeachPromptOp] = useState<string | null>(null)
  const [teachStatus, setTeachStatus] = useState<'idle' | 'saving' | 'saved'>('idle')

  // Clear the confirm timer on unmount to avoid setState-after-unmount.
  useEffect(() => {
    return () => {
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
      setTeachPromptOp(null)
      setTeachStatus('idle')
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
    onSuccess: (_data, vars) => {
      const op = vars.action.op
      const sig = item.failureReasonCode
      // Show the teach prompt for teachable ops on failed-task rows with a
      // failure signature. This gives the operator a one-click path to persist
      // this recovery choice for future occurrences.
      if (sig && TEACHABLE_OPS.has(op)) {
        setTeachPromptOp(op)
      }
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

  const handleTeachYes = async () => {
    const sig = item.failureReasonCode
    if (!sig || !teachPromptOp) return
    setTeachStatus('saving')
    try {
      await teachRecipe(sig, teachPromptOp)
      setTeachStatus('saved')
      void qc.invalidateQueries({ queryKey: ['learned-recipes'] })
    } catch {
      // Silently swallow — teaching failure is not critical; the operator can
      // try again from the failure-kind detail pane.
      setTeachStatus('idle')
    }
    setTeachPromptOp(null)
  }

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

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === 'Escape' && pendingConfirmId !== null) {
          e.stopPropagation()
          clearPendingConfirm()
        }
      }}
    >
      <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
        Move forward
      </dt>
      <dd className="flex flex-wrap gap-2">
        {visibleActions.map((action) =>
          action.op === 'copy' ? (
            <CopyButton
              key={action.id}
              text={action.hint ?? action.label}
              label={action.label}
              className="rounded-md border border-primary/30 px-3 py-1.5 font-mono text-[11px] text-primary transition hover:bg-primary/10 active:scale-[0.97]"
            />
          ) : (
            <button
              key={action.id}
              type="button"
              disabled={mutation.isPending}
              onClick={() => run(action)}
              data-testid={action.needsConfirm ? `confirm-step-${action.id}` : undefined}
              data-confirm-pending={pendingConfirmId === action.id ? 'true' : undefined}
              className={[
                'rounded-md border px-3 py-1.5 font-mono text-[11px] uppercase transition active:scale-[0.97] disabled:opacity-50',
                pendingConfirmId === action.id
                  ? 'border-error bg-error/10 text-error'
                  : action.needsConfirm
                    ? 'border-error/50 text-error hover:bg-error/10'
                    : 'border-primary/40 text-foreground hover:bg-primary/20',
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
      {teachPromptOp && item.failureReasonCode ? (
        <div
          className="mt-3 rounded-md border border-primary/30 bg-card px-3 py-2"
          data-testid="teach-prompt"
        >
          <p className="font-mono text-[11px] text-foreground">
            Apply <span className="uppercase">{teachPromptOp}</span> automatically next time?
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={teachStatus === 'saving'}
              onClick={() => { void handleTeachYes() }}
              data-testid="teach-yes"
              className="rounded-md border border-primary/40 px-3 py-1 font-mono text-[10px] uppercase text-foreground transition hover:bg-primary/20 disabled:opacity-50"
            >
              {teachStatus === 'saving' ? 'Saving…' : 'Yes'}
            </button>
            <button
              type="button"
              onClick={() => setTeachPromptOp(null)}
              data-testid="teach-dismiss"
              className="font-mono text-[10px] uppercase text-muted-foreground transition hover:text-foreground"
            >
              No thanks
            </button>
          </div>
        </div>
      ) : null}
      {teachStatus === 'saved' && !teachPromptOp ? (
        <p
          className="mt-2 font-mono text-[10px] text-foreground"
          data-testid="teach-saved"
        >
          ✓ Mars will auto-apply this next time.
        </p>
      ) : null}
    </div>
  )
}

// ---- Learned-recipe un-teach affordance ----

/**
 * Shown on `failed-task` detail panes when a failure signature is present.
 * Fetches the stored learned recipe for the signature and lets the operator
 * un-teach it (remove the auto-run rule) with one click.
 */
const LearnedRecipeSection = ({ failureSignature }: { failureSignature: string }) => {
  const qc = useQueryClient()
  const { data: recipes } = useQuery({
    queryKey: ['learned-recipes'],
    queryFn: fetchLearnedRecipes,
    staleTime: 30_000,
  })

  const stored = recipes?.find((r) => r.failureSignature === failureSignature) ?? null

  const unlearnMutation = useMutation({
    mutationFn: () => unlearnRecipe(failureSignature),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['learned-recipes'] })
    },
  })

  if (!stored) return null

  return (
    <div data-testid="learned-recipe-section">
      <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
        Auto-run rule
      </dt>
      <dd className="flex items-center gap-3">
        <span className="font-mono text-[11px] text-foreground">
          Mars will auto-<span className="uppercase">{stored.actionOp}</span> on next occurrence
        </span>
        <button
          type="button"
          disabled={unlearnMutation.isPending}
          onClick={() => unlearnMutation.mutate()}
          data-testid="unlearn-recipe"
          className="border border-primary/40 px-2 py-0.5 font-mono text-[10px] uppercase text-muted-foreground transition hover:border-error/50 hover:text-error disabled:opacity-50"
        >
          {unlearnMutation.isPending ? 'Removing…' : 'Un-teach'}
        </button>
      </dd>
    </div>
  )
}

// ---- Workflow step section ----

/**
 * Fetches the run timeline for a task and renders the current (or last)
 * workflow step as a compact one-liner: step name · how long since it started.
 * Returns null while data is loading or absent so it doesn't reserve space.
 */
const TaskWorkflowStepSection = ({ taskId }: { taskId: string }) => {
  const { data } = useQuery<import('@/widgets/TaskDetailDrawer').RunTimeline>({
    queryKey: ['task', taskId, 'runs'],
    queryFn: async () => {
      const res = await fetch(`/api/runs/${encodeURIComponent(taskId)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as import('@/widgets/TaskDetailDrawer').RunTimeline
    },
    retry: false,
  })

  if (data == null || data.runs.length === 0) return null

  const allSteps = data.runs.flatMap((r) => r.steps)
  const running = allSteps.filter((s) => s.status === 'running').at(-1)
  const step = running ?? allSteps.at(-1)
  if (step == null) return null

  return (
    <div>
      <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
        Step
      </dt>
      <dd data-testid="task-workflow-step" className="font-mono text-[11px] text-foreground">
        <span>{step.stepName}</span>
        <span className="text-muted-foreground"> · {relativeTime(step.startedAt)}</span>
      </dd>
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
        <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
          Traces
        </dt>
        <dd className="text-muted-foreground">Loading…</dd>
      </div>
    )
  }
  if (initial.isError || !initial.data) {
    return (
      <div>
        <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
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
        <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
          Traces
        </dt>
        <dd className="text-muted-foreground">No trace events for this task yet.</dd>
      </div>
    )
  }

  return (
    <div>
      <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
        Traces
      </dt>
      <dd>
        <div className="max-h-64 overflow-y-auto pr-1">
          <ul className="flex flex-col gap-1">
            {events.map((e) => (
              <li key={e.id} className={`rounded border ${severityRowClass(e.severity)} px-2 py-1 text-foreground`}>
                <span className="text-muted-foreground">{relativeTime(e.timestamp)}</span>{' '}
                <span className={`font-mono text-[10px] uppercase ${e.severity !== 'info' ? 'font-semibold ' : ''}${severityColor(e.severity)}`}>
                  [{e.severity}]
                </span>{' '}
                <span className="font-mono text-[10px] text-primary">{e.kind}</span>
                {e.phase ? (
                  <span className="font-mono text-[10px] text-muted-foreground">
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
            className="mt-1 inline-flex min-h-[24px] items-center px-2 py-1 font-mono text-[10px] uppercase text-foreground underline disabled:opacity-50"
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
        <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
          Proposal
        </dt>
        <dd className="text-muted-foreground">Loading…</dd>
      </div>
    )
  }

  if (query.isError || !query.data) {
    return (
      <div>
        <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
          Proposal
        </dt>
        <dd className="text-muted-foreground">(could not load proposal)</dd>
      </div>
    )
  }

  const p = query.data

  return (
    <>
      {p.problem ? (
        <div>
          <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
            Problem
          </dt>
          <dd className="whitespace-pre-wrap text-foreground">{p.problem}</dd>
        </div>
      ) : null}
      {p.solution ? (
        <div>
          <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
            Solution
          </dt>
          <dd className="whitespace-pre-wrap text-foreground">{p.solution}</dd>
        </div>
      ) : null}
      {p.userStories.length > 0 ? (
        <div>
          <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
            User stories
          </dt>
          <dd>
            <ol className="list-decimal pl-4 text-foreground">
              {p.userStories.map((story, i) => (
                <li key={i} className="mb-0.5 text-[12px]">{story}</li>
              ))}
            </ol>
          </dd>
        </div>
      ) : null}
      {p.outOfScope ? (
        <div>
          <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
            Out of scope
          </dt>
          <dd className="whitespace-pre-wrap text-foreground">{p.outOfScope}</dd>
        </div>
      ) : null}
      {p.notes ? (
        <div>
          <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
            Notes
          </dt>
          <dd className="whitespace-pre-wrap text-foreground">{p.notes}</dd>
        </div>
      ) : null}
      <div>
        <dd className="text-[10px] text-muted-foreground">
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

export const QueueThreadDetail = ({ item, onNavigateToTask }: DetailProps) => {
  // A real failed task (not the daemon-killed-batch sentinel, carrying a
  // non-empty entity id, AND backed by a real task in the store — dag !== null)
  // can open the shared TaskDetailDrawer and render the OriginTree. Rows whose
  // entityId is a signature slug (e.g. "daemon-code-drift") rather than a task
  // id would 404 on /api/tasks/:id, trigger the purge handler, and immediately
  // close the drawer. The `from=chat` tag keeps the chat page mounted behind
  // the drawer and returns here on close.
  const isRealFailedTask =
    isTaskFailureActionQueueKind(item.kind) &&
    item.entityId !== '__daemon-killed-batch__' &&
    item.entityId !== '' &&
    item.dag !== null

  const openTask = (id: string) => {
    window.location.hash = taskHash(id, 'chat')
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-auto">
      <div className="px-4 pt-4">
        <header
          className="min-w-0 rounded-lg border border-primary/25 bg-card px-4 py-3 shadow-sm"
          data-testid="queue-opening-message"
          aria-label="Opening alert message from Mars"
        >
          <div className="mb-3 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
            <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[11px] text-primary">M</span>
            <span className="text-foreground">Mars</span>
            <span aria-hidden="true">·</span>
            <span>{relativeTime(item.at)}</span>
            <span className="ml-auto uppercase">Action needed</span>
          </div>
          {/* Headline: original task id, kind badge, priority */}
          <div className="flex items-baseline gap-3">
            <span className="break-all font-mono text-[11px] uppercase text-primary">
              {item.entityId}
            </span>
            <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">
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
            <h2 className="mt-2 break-all font-mono text-[15px] text-foreground">
              {item.goal || '(no goal)'}
            </h2>
            <p className="mt-1 whitespace-pre-wrap font-mono text-[12px] text-foreground/80">
              {item.reason}
            </p>
          </>
          ) : (
          <>
            <h2 className="mt-2 break-all font-mono text-[15px] text-foreground">
              {item.title || '(no title)'}
            </h2>
            {(isTaskFailureActionQueueKind(item.kind) || item.kind === 'awaiting-validation') &&
            item.body ? (
              <p className="mt-2 whitespace-pre-wrap font-mono text-[12px] text-foreground/80">
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
            className="mt-3 border border-primary/40 px-3 py-1.5 font-mono text-[10px] uppercase text-foreground transition-colors hover:bg-primary/20"
          >
            Open task detail
          </button>
          ) : null}
        </header>
      </div>

      <main className="flex-1 px-6 py-4">
        <dl className="flex flex-col gap-4 font-mono text-[12px] max-w-[75ch]">
          {/* Resolution block — shown for resolved history rows; suppresses ActionBar. */}
          {item.resolution ? (
            <ResolutionBlock resolution={item.resolution} />
          ) : (
            /* Decisions — shown only for live (open) rows. */
            <ActionBar item={item} />
          )}
          {/* Un-teach affordance: shown for failed-task rows with a failure signature
              that has a learned recipe. Lets the operator remove the auto-run rule. */}
          {isTaskFailureActionQueueKind(item.kind) && item.failureReasonCode ? (
            <LearnedRecipeSection failureSignature={item.failureReasonCode} />
          ) : null}
          {item.kind === 'stale-worktree' && (
            <>
              <div>
                <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
                  Task prompt
                </dt>
                <dd className="whitespace-pre-wrap text-foreground">
                  {item.staleWorktreeDetail.prompt ?? (
                    <span className="text-muted-foreground">absent (no matching task)</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
                  Status · Age · Branch
                </dt>
                <dd className="text-foreground">
                  <span>{item.staleWorktreeDetail.status}</span>
                  {' · '}
                  <span>{item.staleWorktreeDetail.ageHours.toFixed(1)}h</span>
                  {' · '}
                  <span>{item.staleWorktreeDetail.branch ?? '—'}</span>
                </dd>
              </div>
              <div>
                <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
                  Investigation
                </dt>
                <dd>
                  {item.staleWorktreeDetail.investigation ? (
                    <>
                      <p className="mb-1 text-[10px] text-muted-foreground" title={formatTime(item.staleWorktreeDetail.updatedAt)}>
                        {relativeTime(item.staleWorktreeDetail.updatedAt)}
                      </p>
                      <p className="whitespace-pre-wrap text-foreground">
                        {item.staleWorktreeDetail.investigation}
                      </p>
                    </>
                  ) : item.staleWorktreeDetail.empty ? null : (
                    <span className="text-muted-foreground">
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
              <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
                Live preview
              </dt>
              <dd>
                <a
                  href={item.devServerUrl}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="aq-preview-url"
                  className="break-all font-mono text-[12px] text-foreground underline decoration-primary/50 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground"
                >
                  {item.devServerUrl}
                </a>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Opens in a new tab. Validate to merge, or Reject to stop the
                  merge and fail the task (its worktree is kept).
                </p>
              </dd>
            </div>
          ) : null}
          {/* Diagnosis before the origin chain so context is established first. */}
          {item.diagnosis ? (
            <div>
              <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
                Diagnosis
              </dt>
              <dd>
                <p className="mb-1 text-[10px] text-muted-foreground" title={formatTime(item.diagnosis.diagnosedAt)}>
                  {relativeTime(item.diagnosis.diagnosedAt)}
                </p>
                <p className="whitespace-pre-wrap text-foreground">
                  {item.diagnosis.text}
                </p>
              </dd>
            </div>
          ) : null}
          {/* Workflow step — one-line indicator showing where in the workflow the task is/was. */}
          {isRealFailedTask ? (
            <TaskWorkflowStepSection taskId={item.entityId} />
          ) : null}
          {/* Arc chain rail — navigable Proposal-to-Attempt chain for arc-failed alerts. */}
          {item.kind === 'arc-failed' ? (
            <ArcChainRail
              chain={item.chain}
              onSelectTask={openTask}
              onOpenProposal={(id) => { window.location.hash = proposalHash(id, 'chat') }}
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
              <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
                Details
              </dt>
              <dd className="whitespace-pre-wrap text-foreground">
                {item.body.trim() || (
                  <span className="text-muted-foreground">(no details recorded)</span>
                )}
              </dd>
            </div>
          ) : null}
          {/* DAG context — below the fold. */}
          {item.dag && (
            <>
              {item.dag.proposalId && (
                <div>
                  <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
                    From proposal
                  </dt>
                  <dd className="text-foreground">{item.dag.proposalId}</dd>
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
      <footer className="border-t border-primary/30 px-6 py-3 font-mono text-[10px] text-muted-foreground">
        {isRealFailedTask ? 'Failed' : 'Last activity'}: {relativeTime(item.at)}
      </footer>
    </div>
  )
}
