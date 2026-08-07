import { memo } from 'react'
import type { UITask } from '@/shared/types'
import { relativeTime } from '@/shared/time'
import { isLiveStatus, substepLabel } from '@/shared/substep'
import { humanizeFailureCode } from '@/shared/actionQueueDetail'
import { RoleTag } from './RoleTag'
import { StatusChip } from './StatusChip'

/** Maps raw activityDetail phase strings to friendly single-line labels. */
const ACTIVITY_DETAIL_LABEL: Record<string, string> = {
  'merge:acquire-lock': 'merging · waiting for lock',
  'merge:rebase': 'merging · rebasing',
  'merge:fast-forward': 'merging · fast-forward',
  'merge:integration-gate': 'merging · integration tests',
  'merge:vega': 'merging · resolving conflicts',
  verify: 'verifying',
}

interface Props {
  task: UITask
  index: number
}

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s

export const TaskCard = memo(({ task, index }: Props) => {
  const accent =
    task.status === 'failed'
      ? 'bg-primary/10'
      : task.status === 'dropped'
        ? 'opacity-70'
        : ''
  // Live-activity indicator: visually signals the task is actively running.
  // Pulse is scoped to a small status dot so text stays legible throughout.
  const isLive = isLiveStatus(task.status)
  // Fine-grained substep the card is on ("coding", "merging", …), shown beside
  // the live dot so the user reads WHAT step it is on, not just that it's alive.
  // When activityDetail is set, use a friendly label derived from it so the
  // operator can see e.g. "merging · fast-forward" instead of just "merging".
  const substep = isLive
    ? task.activityDetail != null
      ? (ACTIVITY_DETAIL_LABEL[task.activityDetail] ?? task.activityDetail)
      : substepLabel(task.status)
    : null
  const showChip =
    task.status === 'blocked' ||
    task.status === 'dropped' ||
    task.status === 'failed'

  const spec = task.spec
  const failureLabel = task.failed && task.failureSignature
    ? humanizeFailureCode(task.failureSignature)
    : null

  const openDrawer = () => {
    window.location.hash = `#/task/${encodeURIComponent(task.id)}`
  }

  return (
    // `relative` contains the stretched-link ::before pseudo-element.
    // `has-[button:focus-visible]` scopes the focus ring to the card boundary
    // so the ring appears around the whole card, not just the button text.
    // No role=button here — nesting interactive descendants inside role=button
    // violates the ARIA spec (axe: nested-interactive).
    <article
      data-task-index={index}
      data-task-status={task.status}
      title={failureLabel ?? undefined}
      className={`mars-card relative flex flex-col gap-2 rounded-lg bg-card p-3 cursor-pointer transition-[transform,background-color] duration-150 ease-out hover:bg-secondary active:scale-[0.99] motion-reduce:transform-none has-[button:focus-visible]:outline-none has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-ring${isLive ? ' mars-card-live' : ''} ${accent}`.trimEnd()}
    >
      {/* Row 1: id link + status badges — raised above the stretched button via z-10
          so the anchor receives its own pointer events independently. */}
      <div className="relative z-10 flex min-w-0 items-start justify-between gap-2">
        <a
          href={`#/task/${encodeURIComponent(task.id)}`}
          className="block min-w-0 truncate font-mono text-meta text-muted-foreground hover:text-foreground hover:underline"
        >
          {task.id}
        </a>
        <div className="flex shrink-0 items-center gap-1.5">
          {isLive ? (
            <span className="inline-flex items-center gap-1 font-mono text-micro font-semibold uppercase tracking-wide text-status-running">
              <span
                aria-hidden="true"
                className="inline-block h-1.5 w-1.5 rounded-full bg-status-running motion-safe:animate-mars-pulse"
              />
              {substep}
            </span>
          ) : null}
          {task.recoverySpawnedCount > 0 ? (
            <span
              className="rounded bg-muted-foreground/10 px-1.5 py-0.5 font-mono text-micro font-semibold tracking-wide text-muted-foreground"
              title={`recovered ×${task.recoverySpawnedCount}`}
            >
              ↻ recovered
            </span>
          ) : null}
          {showChip ? <StatusChip status={task.status} /> : null}
        </div>
      </div>

      {/* Stretched-link button: carries the card's accessible name (task title) and
          opens the drawer on click/Enter/Space.  The `::before` pseudo-element
          (before:absolute before:inset-0) covers the full card so clicking any
          non-interactive area triggers openDrawer().  Elements with relative z-10
          sit above the pseudo-element and handle their own pointer events. */}
      <button
        type="button"
        aria-label={task.title}
        onClick={openDrawer}
        className={`w-full text-left line-clamp-3 text-body font-medium leading-snug text-foreground focus-visible:outline-none before:absolute before:inset-0 before:content-['']${task.status === 'dropped' ? ' line-through' : ''}`}
      >
        {task.title}
      </button>

      {failureLabel ? (
        <div className="font-mono text-meta text-error/80">
          {failureLabel}
        </div>
      ) : null}

      {task.status === 'dropped' && task.dropReason ? (
        <div className="font-mono text-meta text-muted-foreground">
          {truncate(task.dropReason, 120)}
        </div>
      ) : null}

      {/* Blocked section: raised above the stretched button so the anchor link
          receives its own pointer events. */}
      {task.status === 'blocked' ? (
        <div className="relative z-10 font-mono text-meta text-status-blocked">
          {task.blockerTaskId ? (
            <a
              href={`#/task/${task.blockerTaskId}`}
              className="break-all underline decoration-dotted underline-offset-2"
            >
              Blocked by · {task.blockerTaskId}
            </a>
          ) : (
            'Blocked'
          )}
        </div>
      ) : null}

      {/* Spec toggle: raised above the stretched button so the <details> widget
          receives its own pointer events.  No stopPropagation needed — the article
          no longer has an onClick handler. */}
      {spec !== null ? (
        <details
          className="relative z-10 border-t border-border/50 pt-2"
        >
          <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 py-0.5 font-mono text-micro font-semibold text-muted-foreground/80 hover:text-foreground">
            <span className="text-foreground/60">spec</span>
            <span className="opacity-40 text-[9px]">▾</span>
          </summary>
          <div className="flex flex-col gap-1 pt-1 font-mono text-micro text-muted-foreground">
            {spec.files.length > 0 ? (
              <div>
                <span className="font-semibold text-foreground/60">files</span>
                <ul className="mt-0.5 space-y-0.5">
                  {spec.files.map((f) => (
                    <li key={f} className="truncate pl-2">
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {(spec.readFirst ?? []).length > 0 ? (
              <div>
                <span className="font-semibold text-foreground/60">read first</span>
                <ol className="mt-0.5 list-decimal space-y-0.5 pl-4">
                  {(spec.readFirst ?? []).map((f) => (
                    <li key={f} className="truncate">
                      {f}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            {spec.prescriptiveAction ? (
              <div>
                <span className="font-semibold text-foreground/60">action</span>
                <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap pl-2">
                  {spec.prescriptiveAction}
                </p>
              </div>
            ) : null}
            {spec.verifyCmd ? (
              <div>
                <span className="font-semibold text-foreground/60">verify</span>
                <code className="mt-0.5 block truncate pl-2">{spec.verifyCmd}</code>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <RoleTag role={task.role} />
        <span className="font-mono text-meta text-muted-foreground">
          upd {relativeTime(task.updatedAt)}
        </span>
      </div>
    </article>
  )
})
