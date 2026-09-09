/**
 * LiveTaskPanel — operator-facing briefing panel for a task parked at a manual step.
 *
 * Renders three sections mirroring the terminal briefing:
 *   1. Step guide — the runbook text for the current manual step (pre-formatted).
 *   2. Done criteria — checklist with distinct checked/unchecked states.
 *   3. Progress journal — notes ordered newest-first.
 *
 * When the live endpoint returns a worktreePath, renders an EnterSessionButton
 * above the Step guide so the operator can copy `mars enter <id>` to the clipboard.
 *
 * When the live endpoint indicates the task is parked at the `merge-gate` step,
 * renders two primary action buttons:
 *   • "Approve and merge" — calls POST /api/actions with op='approve-step'
 *   • "Abort without merging" — calls POST /api/actions with op='abort-release'
 *
 * Fetches GET /api/task/:taskId/live (proxied from the daemon's
 * GET /view/task/:id/live). Accepts a `fetchImpl` prop for testing.
 *
 * Query key — use `liveTaskQueryKey(taskId)` wherever the cache entry needs
 * to be targeted (e.g. `SseInvalidator` explicit invalidation).
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { EnterSessionButton } from './EnterSessionButton'

export interface LiveTaskCriterion {
  text: string
  checked: boolean
}

export interface LiveTaskNote {
  ts: number
  text: string
}

export interface LiveTaskData {
  stepGuide: string | null
  doneCriteria: LiveTaskCriterion[]
  notes: LiveTaskNote[]
  /**
   * Absolute path to the task's git worktree on the host.
   * When present, the panel renders an EnterSessionButton so the operator
   * can copy `mars enter <taskId>` to the clipboard without leaving the UI.
   * `null` or absent when the step has no associated worktree.
   */
  worktreePath?: string | null
  /**
   * Machine name of the step the task is currently parked at.
   * When `'merge-gate'`, the panel renders Approve/Abort buttons so the
   * operator can approve or abort the merge from the UI.
   * `null` or absent when the step name is not available.
   */
  stepName?: string | null
}

export interface LiveTaskPanelProps {
  taskId: string
  /**
   * Override the global fetch in tests. Production callers omit it; the
   * component hits `/api/task/:taskId/live` via the runtime `fetch`.
   */
  fetchImpl?: typeof fetch
  /**
   * Override the POST action call in tests. Production callers omit it; the
   * component posts to `/api/actions` via the runtime `fetch`.
   * Receives `(op, entityId)` and must return a resolved promise.
   */
  postActionImpl?: (op: string, entityId: string) => Promise<void>
}

/**
 * Stable query-key factory for the live-task endpoint.
 *
 * Use this wherever the cache entry must be targeted by key — e.g. in
 * `SseInvalidator` to invalidate on `tasks` view-stream pings, and in
 * tests to prime the cache.
 *
 * @example
 *   qc.invalidateQueries({ queryKey: liveTaskQueryKey(openId) })
 */
export const liveTaskQueryKey = (taskId: string) =>
  ['task', taskId, 'live'] as const

const SECTION_LABEL = 'eyebrow text-muted-foreground'

/**
 * LiveTaskPanel — renders the live briefing for an awaiting-human task.
 *
 * Shown above the existing drawer panes when task.status === 'awaiting-human'.
 * Hides itself entirely if the fetch returns 404 (task is no longer parked).
 */
export const LiveTaskPanel = ({ taskId, fetchImpl, postActionImpl }: LiveTaskPanelProps) => {
  const [actionPending, setActionPending] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const postAction = async (op: string): Promise<void> => {
    if (postActionImpl) {
      return postActionImpl(op, taskId)
    }
    const res = await fetch('/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, entityId: taskId }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>
      throw new Error(typeof body['error'] === 'string' ? body['error'] : `HTTP ${res.status}`)
    }
  }

  const handleAction = async (op: string): Promise<void> => {
    setActionPending(op)
    setActionError(null)
    try {
      await postAction(op)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionPending(null)
    }
  }

  const { data, isPending, isError } = useQuery<LiveTaskData | null>({
    queryKey: liveTaskQueryKey(taskId),
    queryFn: async () => {
      const f = fetchImpl ?? fetch
      const res = await f(`/api/task/${encodeURIComponent(taskId)}/live`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<LiveTaskData>
    },
    retry: false,
  })

  if (isPending) {
    return (
      <section
        data-testid="live-task-panel"
        className="border-b border-border px-4 py-3"
        aria-busy="true"
      >
        <p className="text-label text-muted-foreground">Loading live task…</p>
      </section>
    )
  }

  if (isError || data === null) {
    // 404 means the task is no longer parked — hide the panel silently.
    return null
  }

  // Newest-first for the journal
  const notesNewestFirst = data.notes.slice().reverse()

  return (
    <section
      data-testid="live-task-panel"
      className="border-b border-border px-4 py-3 flex flex-col gap-4"
    >
      {/* ── Enter session action ─────────────────────────────────────────── */}
      {data.worktreePath ? (
        <EnterSessionButton taskId={taskId} worktreePath={data.worktreePath} />
      ) : null}

      {/* ── Step guide ───────────────────────────────────────────────────── */}
      {data.stepGuide != null && data.stepGuide.length > 0 ? (
        <div data-testid="live-step-guide">
          <h3 className={`mb-1.5 ${SECTION_LABEL}`}>Step guide</h3>
          <pre className="whitespace-pre-wrap break-words font-mono text-label text-foreground leading-relaxed">
            {data.stepGuide}
          </pre>
        </div>
      ) : null}

      {/* ── Done criteria ────────────────────────────────────────────────── */}
      {data.doneCriteria.length > 0 ? (
        <div data-testid="live-done-criteria">
          <h3 className={`mb-1.5 ${SECTION_LABEL}`}>Done criteria</h3>
          <ul className="flex flex-col gap-1">
            {data.doneCriteria.map((c, i) => (
              <li
                key={i}
                data-testid="live-criterion"
                data-checked={c.checked}
                className="flex items-start gap-2"
              >
                {/* Checkbox — visual only; state is server-owned */}
                <span
                  aria-hidden="true"
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    c.checked
                      ? 'border-done/60 bg-done/15 text-done'
                      : 'border-border bg-transparent text-transparent'
                  }`}
                >
                  {c.checked ? (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                      <path
                        d="M2 5L4 7L8 3"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </span>
                <span
                  className={`font-mono text-label ${
                    c.checked ? 'text-muted-foreground line-through' : 'text-foreground'
                  }`}
                >
                  {c.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── Merge-gate approve / abort buttons ───────────────────────────── */}
      {data.stepName === 'merge-gate' ? (
        <div data-testid="merge-gate-actions" className="flex flex-col gap-2">
          <p className="font-mono text-label text-muted-foreground">
            {`This will merge branch task/${taskId} into main after the verify step passes.`}
          </p>
          {actionError ? (
            <p
              data-testid="merge-gate-action-error"
              className="text-label text-destructive"
            >
              {actionError}
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              data-testid="merge-gate-approve-btn"
              type="button"
              disabled={actionPending !== null}
              onClick={() => { void handleAction('approve-step') }}
              className="rounded px-3 py-1.5 font-mono text-label font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {actionPending === 'approve-step' ? 'Approving…' : 'Approve and merge'}
            </button>
            <button
              data-testid="merge-gate-abort-btn"
              type="button"
              disabled={actionPending !== null}
              onClick={() => { void handleAction('abort-release') }}
              className="rounded px-3 py-1.5 font-mono text-label font-medium border border-destructive text-destructive hover:bg-destructive/10 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {actionPending === 'abort-release' ? 'Aborting…' : 'Abort without merging'}
            </button>
          </div>
          {/* Enter session is a secondary affordance — "Open in terminal" */}
          {data.worktreePath ? (
            <div className="mt-1">
              <EnterSessionButton taskId={taskId} worktreePath={data.worktreePath} />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── Progress journal ─────────────────────────────────────────────── */}
      <div data-testid="live-notes">
        <h3 className={`mb-1.5 ${SECTION_LABEL}`}>Progress journal</h3>
        {notesNewestFirst.length === 0 ? (
          <p className="text-label text-muted-foreground">(none)</p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {notesNewestFirst.map((n, i) => (
              <li
                key={i}
                data-testid="live-note"
                className="font-mono text-label text-foreground"
              >
                {n.text}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  )
}
