import type { SessionOutcome, WorkerSession } from '@/shared/schemas'

interface SessionsListProps {
  sessions: WorkerSession[] | null
  error: string | null
}

/** Label + style for each session outcome. */
const OUTCOME_META: Record<
  SessionOutcome,
  { label: string; className: string }
> = {
  running: {
    label: 'running',
    className: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  },
  completed: {
    label: 'completed',
    className: 'bg-green-500/15 text-green-400 border-green-500/30',
  },
  failed: {
    label: 'failed',
    className: 'bg-red-500/15 text-red-400 border-red-500/30',
  },
  killed: {
    label: 'killed',
    className: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  },
}

const OutcomeBadge = ({ outcome }: { outcome: SessionOutcome }) => {
  const meta =
    OUTCOME_META[outcome] ?? OUTCOME_META.failed
  return (
    <span
      className={[
        'rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase',
        meta.className,
      ].join(' ')}
    >
      {meta.label}
    </span>
  )
}

const formatDuration = (ms: number | null): string => {
  if (ms === null) return '—'
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1_000)
  return `${mins}m${secs}s`
}

const formatTimestamp = (iso: string): string => {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return iso
  }
}

/** Shows at most this many sessions to keep the card compact. */
const MAX_DISPLAY = 10

export const SessionsList = ({ sessions, error }: SessionsListProps) => {
  if (error) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-[11px] text-red-400">
          Sessions unavailable: {error}
        </p>
      </div>
    )
  }

  if (sessions === null) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-[11px] text-muted">Loading sessions…</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div
        className="mb-3 font-mono text-[10px] uppercase text-muted"
        style={{ letterSpacing: '1.2px' }}
      >
        Recent Sessions{' '}
        <span className="text-iron">({sessions.length})</span>
      </div>

      {sessions.length === 0 ? (
        <p className="font-mono text-[12px] text-muted">
          No sessions recorded yet.
        </p>
      ) : (
        <ol className="flex flex-col gap-1.5" aria-label="Recent sessions">
          {sessions.slice(0, MAX_DISPLAY).map((s) => (
            <li
              key={s.id}
              className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-panel"
              aria-label={`Session ${s.outcome}`}
            >
              <OutcomeBadge outcome={s.outcome as SessionOutcome} />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">
                {s.stepName || s.workflowInstanceId}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted">
                {formatDuration(s.durationMs)}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-iron">
                {formatTimestamp(s.endedAt)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
