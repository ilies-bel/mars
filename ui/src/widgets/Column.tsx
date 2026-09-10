import type { UITask } from '@/shared/types'
import type { ProgressTask } from '@/shared/schemas'
import { isLiveStatus } from '@/shared/substep'
import type { Cluster } from '@/shared/schemas'
import { taskTitle } from '@/shared/promptTitle'
import { taskHash } from '@/shared/routing'

export interface BoardArc {
  /** The origin task id. Legacy tasks use their own id as the arc id. */
  id: string
  /** The single roll-up status used to place this arc on the board. */
  cluster: Cluster
  /** All tasks belonging to the arc (active + Done), ordered from origin to latest recovery. */
  tasks: UITask[]
  /**
   * Count of active (non-Done) members. Shown as "X of Y active" when fewer
   * than `tasks.length`, making the Done-task inclusion explicit on the card.
   */
  activeCount: number
  title: string
  updatedAt: string
  /**
   * When set, this arc's origin task is a compensation/cleanup task for the
   * force-purged arc with this origin_id. Used to render the lifecycle badge.
   */
  compensatesArcId?: string | null
  /**
   * True when the arc's origin task is not present in the board tasks (e.g.
   * it was dropped while a recovery task is still in flight). The arc shows
   * the recovery in a muted "abandoned origin" presentation.
   */
  hasOrphanedOrigin?: boolean
  failureSignature?: string | null
}

// ---------------------------------------------------------------------------
// Step-rail helpers — dense board cards
// ---------------------------------------------------------------------------

type StepState = 'done' | 'run' | 'upcoming' | 'failed'

/** The four rail segments, in pipeline order. */
const PHASES = ['setup', 'code', 'verify', 'merge'] as const

/**
 * Which segment a failure signature blames.
 *
 * Signatures are phase-prefixed — `setup:unhandled/unclassified`,
 * `verify:gate-failed` — but a recovery wraps them
 * (`recovery_exhausted:setup/unclassified`), so scan for the first known
 * phase word rather than reading segment zero.
 */
const failedPhaseIndex = (signature: string | null | undefined): number => {
  if (signature == null) return -1
  const words = signature.toLowerCase().split(/[^a-z]+/)
  for (const w of words) {
    const i = PHASES.indexOf(w as (typeof PHASES)[number])
    if (i !== -1) return i
  }
  return -1
}

/**
 * A failed card used to return ['done','done','done','upcoming'] — three
 * filled green segments and an empty fourth, which reads as "three quarters
 * done, still going". Both halves are false: the task is not progressing, and
 * it did not necessarily complete three steps. Measured on this repo, eleven
 * failed tasks died at `setup` — the FIRST step — while every one of their
 * cards showed three steps green.
 *
 * The signature says which phase died, so the rail marks that segment failed,
 * the ones before it done, and the rest genuinely upcoming. With no signature
 * to read, nothing is claimed.
 */
function getStepStates(
  status: string,
  failureSignature?: string | null,
): [StepState, StepState, StepState, StepState] {
  switch (status) {
    case 'queued':
      return ['done', 'upcoming', 'upcoming', 'upcoming']
    case 'running':
      return ['done', 'run', 'upcoming', 'upcoming']
    case 'verifying':
      return ['done', 'done', 'run', 'upcoming']
    case 'merging':
    case 'vega-reconciling':
      return ['done', 'done', 'done', 'run']
    case 'done':
      return ['done', 'done', 'done', 'done']
    case 'failed':
    case 'dropped': {
      const at = failedPhaseIndex(failureSignature)
      if (at === -1) return ['upcoming', 'upcoming', 'upcoming', 'upcoming']
      return PHASES.map((_, i) =>
        i < at ? 'done' : i === at ? 'failed' : 'upcoming',
      ) as [StepState, StepState, StepState, StepState]
    }
    case 'blocked':
    default:
      return ['upcoming', 'upcoming', 'upcoming', 'upcoming']
  }
}

// ---------------------------------------------------------------------------
// BoardCard — compact ~90px task card with step rail
// ---------------------------------------------------------------------------

export const BoardCard = ({ task }: { task: ProgressTask }) => {
  const title = taskTitle(task)
  const steps = getStepStates(task.status, task.failureSignature)
  const failureSig = task.failureSignature ?? null
  // The chip was the raw signature squeezed into 80px, so it arrived as
  // "setup:unh…" — a truncated machine string that names nothing. The phase
  // is the part a reader can act on and it fits; the rest is on hover.
  const failedAt = failedPhaseIndex(task.failureSignature)
  const isLive = isLiveStatus(task.status)

  const dotClass =
    isLive
      ? 'bg-status-running motion-safe:animate-mars-pulse'
      : task.status === 'blocked'
        ? 'bg-status-blocked'
        : task.status === 'failed' || task.status === 'dropped'
          ? 'bg-status-failed'
          : task.status === 'done'
            ? 'bg-status-done'
            : 'bg-muted-foreground/40'

  return (
    <article
      data-board-card={task.id}
      data-task-status={task.status}
      className={`mars-card rounded-lg bg-card p-2.5 flex flex-col gap-1.5 cursor-pointer hover:bg-secondary${isLive ? ' mars-card-live' : ''}`}
      onClick={() => {
        window.location.hash = taskHash(task.id)
      }}
    >
      {/* Row 1: id + live dot */}
      <div className="flex items-center justify-between gap-1 min-w-0">
        <a
          href={taskHash(task.id)}
          onClick={(e) => e.stopPropagation()}
          className="card-id block truncate font-mono text-label text-muted-foreground hover:text-foreground hover:underline"
        >
          {task.id}
        </a>
        <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
      </div>
      {/* Row 2: title */}
      <p className="line-clamp-2 text-body font-medium leading-snug text-foreground">{title}</p>
      {/* Row 3: step rail + optional failure chip */}
      <div className="card-foot flex items-center justify-between gap-1.5">
        <div className="step-rail flex items-center gap-0.5" aria-label="Pipeline steps">
          {steps.map((state, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: static 4-bar rail, index is stable
              key={i}
              className={`step h-1 w-5 rounded-sm ${
                state === 'done'
                  ? 's-done bg-status-done'
                  : state === 'run'
                    ? 's-run bg-status-running motion-safe:animate-mars-pulse'
                    : state === 'failed'
                      ? 's-failed bg-status-failed'
                      : 'upcoming border border-border bg-transparent'
              }`}
            />
          ))}
        </div>
        {failureSig ? (
          <span
            title={failureSig}
            className="chip-fail shrink-0 rounded bg-status-failed/15 px-1 py-0.5 text-micro font-semibold text-status-failed"
          >
            {failedAt === -1 ? 'failed' : `failed in ${PHASES[failedAt]}`}
          </span>
        ) : null}
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------
// DenseColumn — column wrapper for the dense 4-column progress board
// ---------------------------------------------------------------------------

interface DenseColumnProps {
  /** Stable column identity. Drives the `data-board-column` /
   *  `data-column-count` test hooks, so it must NOT change when the visible
   *  heading is reworded — use `qualifier` for that. */
  label: string
  /**
   * Optional parenthetical appended to the visible heading only (e.g. "all"
   * renders "PROPOSALS (ALL)"). Exists so a column can name the population it
   * counts — the Proposals column counts every proposal with an in-scope task,
   * while the Proposals page counts only drafts awaiting review, and showing
   * both under a bare "PROPOSALS" made one concept report two numbers.
   */
  qualifier?: string
  count: number
  children: React.ReactNode
  /**
   * What to say when the column holds nothing. Every column rendered the bare
   * lowercase word "empty" in a monospace face — the one empty state in the
   * app that did not try, and the only place a reader meets a raw programmer
   * word. Copy belongs to the caller because grammar does not survive being
   * derived from the heading ("No in progress tasks").
   */
  emptyLabel?: string
  /** Optional hover tooltip explaining the column's semantics (e.g. "waiting
   *  for another task to finish"). Shown as a native title on the header row. */
  tooltip?: string
}

export const DenseColumn = ({ label, qualifier, count, children, tooltip, emptyLabel = 'Nothing here' }: DenseColumnProps) => (
  <section
    data-board-column={label}
    className="flex flex-col gap-2 min-w-0 min-h-0"
  >
    <header className="flex items-center justify-between border-b border-border pb-2" title={tooltip}>
      <span className="eyebrow text-muted-foreground">
        {qualifier === undefined ? label.toUpperCase() : `${label.toUpperCase()} (${qualifier.toUpperCase()})`}
      </span>
      <span
        data-column-count={label}
        className="font-mono text-micro font-semibold tabular-nums text-muted-foreground"
      >
        {count}
      </span>
    </header>
    <div className="flex flex-col gap-2 overflow-y-auto">
      {count === 0 ? (
        <p className="px-1 py-2 text-label text-muted-foreground">{emptyLabel}</p>
      ) : (
        children
      )}
    </div>
  </section>
)
