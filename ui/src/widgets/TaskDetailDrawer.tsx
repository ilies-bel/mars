import { useEffect, useState } from 'react'

interface TaskDetailDrawerProps {
  /** Task id pulled from `#/task/<id>`. */
  taskId: string
  /** Clears the `#/task/<id>` hash so the drawer closes. */
  onClose: () => void
  /**
   * Override the fetcher in tests. Production callers omit it; the drawer
   * hits `/api/tasks/:id` via the runtime `fetch`.
   */
  fetchImpl?: typeof fetch
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; taskStatus: string }

/**
 * Slice 7 tracer-bullet implementation: only the not-found empty state is
 * fully wired. Once slice 1 lands the base drawer with skeleton + ready
 * sections, this component should grow them — the `ready` branch is a
 * deliberate placeholder until then.
 *
 * Acceptance criteria covered by this slice:
 *   - Opening the drawer on an unknown id shows an empty state with copy
 *     that mentions the task was not found and may have been purged.
 *   - The not-found drawer renders only a close control — no skeleton,
 *     no retry, no half-rendered sections.
 *   - Closing the drawer clears the hash via `onClose`.
 */
export const TaskDetailDrawer = ({
  taskId,
  onClose,
  fetchImpl,
}: TaskDetailDrawerProps) => {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    const f = fetchImpl ?? fetch
    f(`/api/tasks/${encodeURIComponent(taskId)}`)
      .then(async (res) => {
        if (cancelled) return
        if (res.status === 404) {
          setState({ kind: 'not-found' })
          return
        }
        if (!res.ok) {
          setState({ kind: 'error', message: `HTTP ${res.status}` })
          return
        }
        const data = (await res.json()) as { task: { status: string } }
        setState({ kind: 'ready', taskStatus: data.task.status })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : 'request failed'
        setState({ kind: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [taskId, fetchImpl])

  return (
    <aside
      role="dialog"
      aria-modal="true"
      aria-label="Task detail"
      data-testid="task-detail-drawer"
      data-state={state.kind}
      className="fixed inset-y-0 right-0 z-50 flex w-[min(560px,100vw)] flex-col border-l border-iron/40 bg-bg shadow-2xl"
    >
      <header className="flex items-center justify-between border-b border-iron/40 px-4 py-3">
        <h2 className="font-mono text-sm uppercase tracking-wide text-iron">
          Task {taskId}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close task detail"
          data-testid="task-detail-close"
          className="rounded border border-iron/40 px-2 py-0.5 font-mono text-xs text-iron hover:bg-iron/10"
        >
          Close
        </button>
      </header>

      {state.kind === 'not-found' ? (
        <div
          data-testid="task-detail-not-found"
          className="flex flex-1 items-center justify-center p-6"
        >
          <p className="max-w-[40ch] text-center font-mono text-sm text-iron">
            Task not found. It may have been purged.
          </p>
        </div>
      ) : null}

      {state.kind === 'ready' ? (
        <div
          data-testid="task-detail-body"
          className="flex-1 overflow-y-auto p-4"
        >
          <dl className="flex flex-col gap-3">
            <div>
              <dt className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
                Status
              </dt>
              <dd
                data-testid="task-detail-status"
                className="mt-1 font-mono text-sm text-fg"
              >
                {state.taskStatus}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
    </aside>
  )
}
