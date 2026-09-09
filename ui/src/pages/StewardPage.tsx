import { ArrowDown, ArrowUp, ChevronRight, Minus } from 'lucide-react'
/**
 * StewardPage — what the Steward is wired to do and what it has actually done.
 *
 * Four capability lanes, visual form encodes execution state:
 *   ─── solid connector   → lane executes
 *   ╌╌╌ dashed connector  → lane is built or declared but cannot execute
 *
 * NOTE on server.ts:1810: the comment "spawns the steward" is a misnomer.
 * investigateWorktree (server.ts:~2850) dispatches a fire-and-forget *Haiku*
 * run via runClaudeCode — not stewardAgent. The stewardAgent is registered in
 * the agent registry but has zero dispatch sites in production code.
 */

import { useState } from 'react'
import { FallbackSurface } from '@/components/FallbackSurface'
import { CollapsibleSection } from '@/components/CollapsibleSection'
import { useStewardView } from './useStewardView'
import type { StewardView } from './useStewardView'
import { PageBody, PageHeader, PageShell, SectionHeading } from '@/widgets/primitives/DensityPrimitives'
import { formatAbsoluteDateTime, formatShortDate } from '@/shared/time'
import { invokeAction } from '@/shared/api'

export type { StewardView }
export { useStewardView }

// ---------------------------------------------------------------------------
// Visual primitives
// ---------------------------------------------------------------------------

/** Connector SVG — solid for executing lanes, dashed for inert/unbuilt ones. */
const LaneConnector = ({ active }: { active: boolean }) => (
  <div
    aria-hidden="true"
    className={[
      'mx-auto my-2 h-6 w-0.5',
      active
        ? 'bg-success'
        : 'bg-muted-foreground/30 [background:repeating-linear-gradient(to_bottom,transparent_0,transparent_3px,rgb(var(--color-muted-foreground)/0.3)_3px,rgb(var(--color-muted-foreground)/0.3)_6px)]',
    ].join(' ')}
  />
)

const laneCardClass = (active: boolean): string =>
  [
    'rounded-lg border p-5',
    active
      ? 'border-success/40 bg-success/[0.04]'
      : 'border-border/50 bg-card opacity-80',
  ].join(' ')

const laneHeaderClass = (active: boolean): string =>
  [
    'flex items-center gap-2 eyebrow',
    active ? 'text-success' : 'text-muted-foreground',
  ].join(' ')

const StatusDot = ({ active, label }: { active: boolean; label?: string }) => (
  <span
    aria-label={label ?? (active ? 'executing' : 'not executing')}
    className={[
      'inline-block h-2 w-2 rounded-full',
      active ? 'bg-success' : 'bg-muted-foreground/40',
    ].join(' ')}
  />
)

/** Formats a timestamp as a short, unambiguous "last activity" label. */
const formatLastActivity = (timestamp: string | null): string =>
  timestamp === null
    ? 'no activity yet'
    : `last activity ${formatShortDate(timestamp)}`

// ---------------------------------------------------------------------------
// Runtime tuning lane
// ---------------------------------------------------------------------------

export interface CapEntry {
  from: number
  to: number
  timestamp: string
  text: string
}

export const CapRatchet = ({
  entries,
  baseline,
  ceiling,
  liveCap,
}: {
  entries: CapEntry[]
  baseline: number
  ceiling: number
  liveCap: number
}) => {
  // Bar scale helpers
  const allValues = [baseline, ...entries.map((e) => e.to)]
  const min = Math.min(...allValues)
  const max = Math.max(ceiling, liveCap, ...allValues)
  const range = max - min || 1
  const toPercent = (v: number) => `${Math.round(((v - min) / range) * 100)}%`

  // Step chart geometry (hand-rolled SVG, no charting library)
  const SVG_W = 400
  const SVG_H = 56
  const PAD_X = 8
  const PAD_TOP = 6
  const PAD_BOTTOM = 14
  const chartH = SVG_H - PAD_TOP - PAD_BOTTOM
  const xLeft = PAD_X
  const xRight = SVG_W - PAD_X
  const yRange = max - min || 1
  const toY = (v: number) => PAD_TOP + chartH - ((v - min) / yRange) * chartH

  // Build step-chart polyline: flat segments (holds) separated by vertical jumps
  const stepPolyline = (() => {
    if (entries.length === 0) {
      const y = toY(baseline).toFixed(1)
      return `${xLeft},${y} ${xRight},${y}`
    }
    const times = entries.map((e) => new Date(e.timestamp).getTime())
    const tFirst = Math.min(...times)
    const tLast = Math.max(...times)
    // Add 10 % right-padding so the final level has a visible hold segment
    const tRange = (tLast - tFirst) * 1.1 || 1
    const toX = (t: number) => xLeft + ((t - tFirst) / tRange) * (xRight - xLeft)

    const pts: string[] = []
    let v = baseline
    pts.push(`${xLeft.toFixed(1)},${toY(v).toFixed(1)}`)
    for (const e of entries) {
      const x = toX(new Date(e.timestamp).getTime()).toFixed(1)
      pts.push(`${x},${toY(v).toFixed(1)}`)   // hold at current level until bump
      v = e.to
      pts.push(`${x},${toY(v).toFixed(1)}`)   // vertical step to new level
    }
    pts.push(`${xRight.toFixed(1)},${toY(v).toFixed(1)}`) // extend to right edge
    return pts.join(' ')
  })()

  const firstEntry = entries[0]
  const lastEntry = entries[entries.length - 1]

  return (
    <div className="mb-4">
      <div className="mb-1 flex items-center justify-between font-mono text-micro text-muted-foreground">
        <span>baseline {baseline}</span>
        <span>ceiling {ceiling}</span>
      </div>
      {/* Bar — shows where the live cap sits relative to baseline/ceiling */}
      <div className="relative h-7 w-full rounded bg-muted/30">
        <div
          className="absolute top-0 h-full w-px bg-warn/60"
          style={{ left: toPercent(ceiling) }}
          title={`ceiling: ${ceiling}`}
        />
        <div
          className="absolute top-0 h-full w-px bg-foreground/35"
          style={{ left: toPercent(baseline) }}
          title={`baseline: ${baseline}`}
        />
        <div
          className="absolute top-0 left-0 h-full rounded bg-success/30 transition-[width]"
          style={{ width: toPercent(liveCap) }}
          title={`live cap: ${liveCap}`}
        />
        {entries.map((e) => (
          <div
            key={e.timestamp}
            className="absolute top-0 h-full w-px bg-success/70"
            style={{ left: toPercent(e.to) }}
            title={`bumped to ${e.to}`}
          />
        ))}
        <span
          className="absolute top-0 flex h-full items-center pl-1 font-mono text-micro font-semibold text-success"
          style={{ left: toPercent(liveCap) }}
        >
          {liveCap}
        </span>
      </div>

      {/* Step chart — cap level over time with baseline/ceiling reference lines */}
      <svg
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        width="100%"
        aria-label="Worker cap history"
        data-testid="cap-step-chart"
        className="mt-2 overflow-visible"
        preserveAspectRatio="none"
      >
        {/* Ceiling reference line */}
        <line
          x1={xLeft} y1={toY(ceiling).toFixed(1)}
          x2={xRight} y2={toY(ceiling).toFixed(1)}
          stroke="currentColor"
          strokeWidth={1}
          strokeOpacity={0.3}
          strokeDasharray="3 2"
          className="text-warn"
        />
        {/* Baseline reference line */}
        <line
          x1={xLeft} y1={toY(baseline).toFixed(1)}
          x2={xRight} y2={toY(baseline).toFixed(1)}
          stroke="currentColor"
          strokeWidth={1}
          strokeOpacity={0.3}
          strokeDasharray="3 2"
          className="text-muted-foreground"
        />
        {/* Step polyline — the cap level over time */}
        <polyline
          points={stepPolyline}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="miter"
          strokeLinecap="square"
          className="text-success"
        />
      </svg>
      {/* Axis labels as HTML: the chart is width=100% over a fixed 400x56
          viewBox with preserveAspectRatio=none, so it stretches ~4.5x and
          fontSize=7 text inside it RENDERED at ~32px, smeared and unhinted. */}
      {(firstEntry !== undefined || lastEntry !== undefined) && (
        <div className="mt-0.5 flex items-baseline justify-between text-micro text-muted-foreground">
          <span>{firstEntry !== undefined ? formatShortDate(firstEntry.timestamp) : ''}</span>
          <span>
            {lastEntry !== undefined && lastEntry !== firstEntry
              ? formatShortDate(lastEntry.timestamp)
              : ''}
          </span>
        </div>
      )}

      {/* Raw transitions — collapsed by default, available for exact sequence inspection */}
      {entries.length > 0 && (
        <details className="group mt-1">
          {/* `flex list-none` is not cosmetic here. Tailwind's preflight sets
              `svg { display: block }`, so inside a plain block <summary> the
              Lucide chevron became a block and pushed "raw transitions" onto a
              second line, with the UA's own disclosure marker left stranded
              beside it. Every other <summary> in this file already uses this
              shape; this one was the exception. min-h-6 keeps the control at a
              24px target once it collapses back to one line. */}
          <summary className="flex min-h-6 cursor-pointer list-none items-center gap-1 text-micro text-muted-foreground select-none hover:text-foreground">
            <ChevronRight
              size={11}
              strokeWidth={2}
              aria-hidden="true"
              className="shrink-0 transition-transform group-open:rotate-90"
            />
            raw transitions
          </summary>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-label text-muted-foreground">
            <span className="text-muted-foreground">{baseline}</span>
            {entries.map((e) => (
              <span key={e.timestamp} className="flex items-center gap-1">
                <span className="text-muted-foreground">→</span>
                <span className="text-success">{e.to}</span>
              </span>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

/** How many acknowledgments stay expanded before the rest fold away. */
const ACK_PREVIEW = 6

type Ack = StewardView['runtimeTuning']['acks'][number]

/**
 * One acknowledgment, as a row rather than a card.
 *
 * Every acknowledgment used to render in the same tinted success box with the
 * sentence on one line and the timestamp on a second — so a raise and a cut
 * were typographically indistinguishable, and reading a run of six meant
 * reading six near-identical sentences word by word to find the two that went
 * the other way. The Steward's whole job is oscillation; the one thing the log
 * has to make scannable is direction.
 *
 * The arrow, the tone and the screen-reader word all come from `ack.pair`
 * ({from, to}) — never from the sentence. The prose is the Steward's to word
 * and a regex over it would quietly stop classifying the day that wording
 * changed. `pair === null` means the daemon sent no levels, so the row shows a
 * neutral dash rather than guessing a direction.
 *
 * Direction is never carried by colour alone (WCAG 1.4.1): the arrow is a
 * distinct shape per direction and an `sr-only` verb states it outright.
 */
const AckCard = ({ ack, testid }: { ack: Ack; testid?: string }) => {
  const pair = ack.pair
  const dir = pair === null ? 'flat' : pair.to > pair.from ? 'up' : pair.to < pair.from ? 'down' : 'flat'
  const Icon = dir === 'up' ? ArrowUp : dir === 'down' ? ArrowDown : Minus
  const tone =
    dir === 'up' ? 'text-success' : dir === 'down' ? 'text-warn' : 'text-muted-foreground'
  const spoken = dir === 'up' ? 'raised' : dir === 'down' ? 'lowered' : 'unchanged'

  return (
    <div
      className="flex items-baseline gap-2 border-b border-border/50 py-1.5 last:border-b-0"
      data-testid={testid}
      data-direction={dir}
    >
      <Icon
        size={12}
        strokeWidth={2.5}
        aria-hidden="true"
        className={`relative top-px shrink-0 ${tone}`}
      />
      <span className="sr-only">{spoken}:</span>
      <p className="flex-1 text-label text-foreground">{ack.text}</p>
      <time className="shrink-0 text-micro tabular-nums text-muted-foreground">
        {formatAbsoluteDateTime(ack.timestamp)}
      </time>
    </div>
  )
}

/**
 * Summarises the whole acknowledgment set in one line, then shows the most
 * recent few in full with the remainder behind a disclosure.
 *
 * Direction comes from `ack.pair` ({from, to}), never from the sentence: the
 * prose is the Steward's to word, and a regex over it would quietly stop
 * counting the day that wording changed.
 */
const AckLog = ({ acks }: { acks: Ack[] }) => {
  const paired = acks.filter((a) => a.pair !== null)
  const bumps = paired.filter((a) => a.pair!.to > a.pair!.from).length
  const sheds = paired.filter((a) => a.pair!.to < a.pair!.from).length
  const levels = paired.flatMap((a) => [a.pair!.from, a.pair!.to])
  const lo = levels.length > 0 ? Math.min(...levels) : null
  const hi = levels.length > 0 ? Math.max(...levels) : null

  const recent = acks.slice(0, ACK_PREVIEW)
  const earlier = acks.slice(ACK_PREVIEW)

  return (
    <div className="space-y-2">
      {/* The header states what the log adds up to instead of naming a noun and
          a total. "Steward acknowledgments (200)" made the reader scroll two
          hundred rows to learn the only thing the section is for: whether the
          cap is oscillating, in which direction, and between what bounds. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="eyebrow text-muted-foreground">Steward acknowledgments</span>
        {paired.length > 0 && (
          <span className="text-micro text-muted-foreground" data-testid="steward-ack-summary">
            {`${bumps} bump${bumps === 1 ? '' : 's'}, ${sheds} shed${sheds === 1 ? '' : 's'}`}
            {lo !== null && hi !== null && lo !== hi
              ? `, holding between ${lo} and ${hi} workers.`
              : '.'}
          </span>
        )}
      </div>

      {acks.length === 0 ? (
        <p className="text-micro text-muted-foreground">No acknowledgments yet.</p>
      ) : (
        <>
          {/* No gap between rows: each carries its own hairline rule, and an
              8px gap on top of a rule reads as a list of boxes again. */}
          <div>
            {recent.map((ack, i) => (
              <AckCard
                key={ack.timestamp}
                ack={ack}
                testid={i === 0 ? 'steward-ack-latest' : undefined}
              />
            ))}
          </div>

          {earlier.length > 0 && (
            <details className="group">
              <summary className="flex min-h-6 cursor-pointer list-none items-center gap-1 text-micro text-muted-foreground select-none hover:text-foreground">
                <ChevronRight
                  size={11}
                  strokeWidth={2}
                  aria-hidden="true"
                  className="shrink-0 transition-transform group-open:rotate-90"
                />
                {`${earlier.length} earlier`}
              </summary>
              <div className="mt-1">
                {earlier.map((ack) => (
                  <AckCard key={ack.timestamp} ack={ack} />
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  )
}

const RuntimeTuningLane = ({ data }: { data: StewardView['runtimeTuning'] }) => {
  const { acks, liveCap, baselineCap, ceiling, bumpFactor, thresholdFactor, sustainMs, checkMs } = data

  const ratchetEntries: CapEntry[] = acks
    .filter((a) => a.pair !== null)
    .map((a) => ({
      from: a.pair!.from,
      to: a.pair!.to,
      timestamp: a.timestamp,
      text: a.text,
    }))

  // Acks are newest-first (see the ack list below and `steward-ack-latest`),
  // so acks[0] is the most recent activity. This lane runs for real, but it
  // is not the Steward — the page-level banner says the Steward isn't wired
  // up, so this indicator must never claim "executing" or render green;
  // showing the data's actual age is the honest alternative.
  const lastActivity = acks.length > 0 ? acks[0]!.timestamp : null

  return (
    <article className={laneCardClass(true)} data-testid="lane-runtime-tuning">
      <header className="mb-4">
        <div className={laneHeaderClass(true)}>
          <StatusDot active={false} label="not Steward-driven" />
          <span>Runtime tuning</span>
          <span
            className="ml-auto rounded bg-muted/30 px-1.5 py-0.5 text-muted-foreground"
            data-testid="runtime-tuning-status-chip"
          >
            {formatLastActivity(lastActivity)}
          </span>
        </div>
        <p className="mt-1 text-micro text-muted-foreground">
          Trigger: backlog sustained {'>'} {Math.floor(liveCap * thresholdFactor)} tasks for {sustainMs / 1000}s —
          bump cap by ×{bumpFactor} up to ceiling {ceiling}. Checked every {checkMs / 1000}s.
        </p>
      </header>

      {/* Cap ratchet visualisation */}
      <CapRatchet
        entries={ratchetEntries.slice().reverse()} // oldest-first for the ratchet
        baseline={baselineCap}
        ceiling={ceiling}
        liveCap={liveCap}
      />

      {/* Acks — Steward's own first-person voice, newest first.
       *
       * This rendered all 200 as equal cards: roughly twelve thousand pixels
       * of scroll in which "I bumped implement workers from 5 to 6 because the
       * backlog was sustained." appeared verbatim dozens of times. Every row
       * was individually readable and the list as a whole said nothing — you
       * could not learn from it how often the Steward acts, which way, or
       * within what range, without scrolling all of it and counting.
       *
       * Two readings, so two treatments. The shape of the whole set is one
       * computed line (classified from `pair`, not by parsing the prose, so it
       * cannot drift from the copy). Recent behaviour is the newest few, in
       * full. Everything else is kept, in order, one disclosure away — nothing
       * is dropped, it just stops competing with the answer.
       */}
      <AckLog acks={acks} />
    </article>
  )
}

// ---------------------------------------------------------------------------
// Signature storm lane
// ---------------------------------------------------------------------------

const SignatureStormLane = ({ data }: { data: StewardView['signatureStorm'] }) => {
  const {
    current_signature,
    streak_count,
    tripped,
    updated_at,
    signatureStormAqCount,
    tripThreshold,
    isPaused,
    last_task_id,
  } = data

  // Two states can disagree: `tripped` persists in Postgres,
  // `isPaused` is in-memory. A daemon restart clears isPaused while tripped stays.
  const disagree = tripped !== isPaused

  return (
    <article className={laneCardClass(true)} data-testid="lane-signature-storm">
      <header className="mb-4">
        <div className={laneHeaderClass(true)}>
          <StatusDot active={true} />
          <span>Signature storm</span>
          {tripped ? (
            <span className="ml-auto rounded bg-error/20 px-1.5 py-0.5 text-micro text-error">
              breaker tripped
            </span>
          ) : (
            <span className="ml-auto rounded bg-success/20 px-1.5 py-0.5 text-success">
              breaker clear
            </span>
          )}
        </div>
        <p className="mt-1 font-mono text-micro text-muted-foreground">
          Trigger: {tripThreshold} consecutive tasks with the same failure signature. Pauses dispatch.
        </p>
      </header>

      {/* Disagreement banner — operationally critical */}
      {disagree && (
        <div
          className="mb-3 rounded border border-warn/40 bg-warn/10 px-3 py-2"
          role="alert"
          data-testid="storm-disagree-banner"
        >
          <p className="text-label font-semibold text-warn">
            State disagreement detected
          </p>
          <p className="mt-0.5 text-micro text-warn/80">
            Breaker is {tripped ? 'tripped' : 'clear'} in Postgres, but dispatch is{' '}
            {isPaused ? 'paused' : 'running'} in memory. The daemon was likely restarted while the
            breaker was {tripped ? 'tripped' : 'clear'}. Run{' '}
            <code className="rounded bg-warn/20 px-1">mars operator</code> to re-align.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded border border-border/50 bg-muted/20 p-3">
          <div className="eyebrow text-muted-foreground">
            Breaker (Postgres)
          </div>
          <div
            className={`mt-1 font-mono text-body font-semibold ${tripped ? 'text-error' : 'text-success'}`}
            data-testid="storm-tripped"
          >
            {tripped ? 'Tripped' : 'Clear'}
          </div>
          {updated_at && (
            <time className="text-micro text-muted-foreground">
              {formatAbsoluteDateTime(updated_at)}
            </time>
          )}
        </div>
        <div className="rounded border border-border/50 bg-muted/20 p-3">
          <div className="eyebrow text-muted-foreground">
            Dispatch (in-memory)
          </div>
          <div
            className={`mt-1 font-mono text-body font-semibold ${isPaused ? 'text-error' : 'text-success'}`}
            data-testid="storm-is-paused"
          >
            {isPaused ? 'Paused' : 'Running'}
          </div>
          <p className="text-micro text-muted-foreground">resets on daemon restart</p>
        </div>
      </div>

      <div className="mt-3 space-y-1">
        <div className="flex items-baseline gap-2">
          <span className="eyebrow text-muted-foreground w-28">
            Streak count
          </span>
          <span className="font-mono text-body font-semibold text-foreground" data-testid="storm-streak">
            {streak_count}
          </span>
          <span className="font-mono text-micro text-muted-foreground">/ {tripThreshold} to trip</span>
        </div>
        {current_signature !== null && (
          <div className="flex items-baseline gap-2">
            <span className="eyebrow text-muted-foreground w-28">
              Signature
            </span>
            <code
              className="font-mono text-micro text-foreground break-all"
              data-testid="storm-signature"
            >
              {current_signature}
            </code>
          </div>
        )}
        {last_task_id !== null && (
          <div className="flex items-baseline gap-2">
            <span className="eyebrow text-muted-foreground w-28">
              Last task
            </span>
            <code className="font-mono text-micro text-muted-foreground">{last_task_id}</code>
          </div>
        )}
        {signatureStormAqCount > 0 && (
          <div className="flex items-baseline gap-2">
            <span className="eyebrow text-muted-foreground w-28">
              AQ items
            </span>
            <span className="font-mono text-label text-error" data-testid="storm-aq-count">
              {signatureStormAqCount} signature-storm item{signatureStormAqCount !== 1 ? 's' : ''}
            </span>
          </div>
        )}
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Workflow patches lane
// ---------------------------------------------------------------------------

const WorkflowPatchesLane = ({ data }: { data: StewardView['workflowPatches'] }) => {
  const { rows, hasCallers } = data

  if (!hasCallers) {
    // Inert variant: the patch functions are implemented but have no call sites.
    return (
      <article className={laneCardClass(false)} data-testid="lane-workflow-patches">
        <header className="mb-4">
          <div className={laneHeaderClass(false)}>
            <StatusDot active={false} />
            <span>Workflow patches</span>
            <span className="ml-auto rounded bg-muted/30 px-1.5 py-0.5 text-muted-foreground">
              built — no callers
            </span>
          </div>
          <p className="mt-1 text-micro text-muted-foreground">
            stewardProposeWorkflowPatch, applyWorkflowPatch, and rejectWorkflowPatch are implemented
            but have no call sites outside their own module and tests. This lane cannot execute.
          </p>
        </header>
        <p
          className="text-micro text-muted-foreground"
          data-testid="patches-empty-state"
        >
          No proposals
        </p>
      </article>
    )
  }

  // Active variant: arc-verifier calls stewardProposeWorkflowPatch after N consecutive
  // tooling-missing outcomes, proposing removal of the behaviour-verify step.
  return (
    <article className={laneCardClass(true)} data-testid="lane-workflow-patches">
      <header className="mb-4">
        <div className={laneHeaderClass(true)}>
          <StatusDot active={true} />
          <span>Workflow patches</span>
          <span className="ml-auto rounded bg-success/20 px-1.5 py-0.5 text-success">
            arc-verifier
          </span>
        </div>
        <p className="mt-1 text-micro text-muted-foreground">
          Trigger: N consecutive arc E2E passes end CAN'T-VERIFY because E2E tooling is missing.
          The arc-verifier proposes removing the behaviour-verify step so the operator can decide
          whether to fix the environment or drop the step.
        </p>
      </header>
      {rows.length === 0 ? (
        <p
          className="text-micro text-muted-foreground"
          data-testid="patches-empty-state"
        >
          No pending workflow-patch proposals.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="rounded border border-border/40 px-3 py-2 font-mono text-micro"
            >
              <div className="flex items-center justify-between">
                <span className="text-foreground">{row.workflow_path}</span>
                <span className="text-muted-foreground">{row.status}</span>
              </div>
              <p className="mt-0.5 text-muted-foreground">{row.rationale}</p>
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

// ---------------------------------------------------------------------------
// Verify gate health lane
// ---------------------------------------------------------------------------

const GateHealthLane = ({
  data,
  isLoading = false,
  error = null,
}: {
  data: StewardView['gateHealth'] | undefined
  isLoading?: boolean
  error?: Error | null
}) => {
  const [restoringGateIds, setRestoringGateIds] = useState<Set<string>>(new Set())

  const handleRestore = async (gateId: string): Promise<void> => {
    setRestoringGateIds((prev) => new Set(prev).add(gateId))
    try {
      await invokeAction('gate-restore', gateId)
    } finally {
      setRestoringGateIds((prev) => {
        const next = new Set(prev)
        next.delete(gateId)
        return next
      })
    }
  }

  return (
    <article className={laneCardClass(true)} data-testid="lane-gate-health">
      <header className="mb-4">
        <div className={laneHeaderClass(true)}>
          <StatusDot active={true} />
          <span>Verify gates</span>
          <span className="ml-auto rounded bg-success/20 px-1.5 py-0.5 text-success">
            standing registry
          </span>
        </div>
        <p className="mt-1 text-micro text-muted-foreground">
          Health of the registered verification gates. Quarantined gates can be restored from this page.
        </p>
      </header>

      {isLoading ? (
        <p className="text-micro text-muted-foreground" role="status">
          Loading verify gates…
        </p>
      ) : error !== null ? (
        <div role="alert">
          <p className="text-micro text-error">Daemon error while loading verify gates.</p>
          <FallbackSurface error={error} of="verify gates" variant="pane" />
        </div>
      ) : data === undefined || data.scopes.length === 0 ? (
        <p className="text-micro text-muted-foreground" data-testid="gate-health-empty-state">
          No verify gates are registered.
        </p>
      ) : (
        <div className="space-y-4">
          {data.scopes.map((scope) => (
            <section key={scope.scope} aria-label={`Verify gates for ${scope.scope}`}>
              <SectionHeading>Scope: {scope.scope}</SectionHeading>
              <ul className="space-y-2">
                {scope.gates.map((gate) => (
                  <li key={gate.id} className="rounded border border-border/40 bg-muted/10 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-mono text-label font-semibold text-foreground">{gate.name}</span>
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono text-micro ${gate.state === 'active' ? 'bg-success/20 text-success' : 'bg-error/20 text-error'}`}
                        aria-label={`Gate status: ${gate.state === 'active' ? 'Active' : 'Quarantined'}`}
                      >
                        {gate.state === 'active' ? 'Active' : 'Quarantined'}
                      </span>
                      <span className="font-mono text-micro text-muted-foreground">
                        {gate.tier} · {gate.required ? 'required' : 'optional'}
                      </span>
                    </div>
                    <code className="mt-1 block break-all font-mono text-micro text-foreground">
                      {gate.command.cmd}{gate.command.args.length > 0 ? ` ${gate.command.args.join(' ')}` : ''}
                    </code>
                    <div className="mt-1 font-mono text-micro text-muted-foreground">
                      <p>Source: {gate.source}</p>
                      {gate.evidence !== null && <p>Evidence: {gate.evidence}</p>}
                    </div>
                    {gate.state === 'quarantined' && (
                      <div className="mt-2 space-y-1 text-micro text-error">
                        <p>
                          This check was temporarily disabled
                          {gate.quarantinedAt !== null
                            ? ` on ${formatAbsoluteDateTime(gate.quarantinedAt)}`
                            : ''}{' '}
                          after failing repeatedly.
                        </p>
                        <CollapsibleSection
                          label="Technical details"
                          srLabel={`Technical details of the quarantine for ${gate.scope !== '.' ? `${gate.scope}: ` : ''}${gate.name}`}
                        >
                          <p>Signature: {gate.quarantineSignature ?? 'Unavailable'}</p>
                        </CollapsibleSection>
                        <button
                          type="button"
                          disabled={restoringGateIds.has(gate.id)}
                          onClick={() => { void handleRestore(gate.id) }}
                          className="mt-1 flex items-center gap-1 rounded border border-error/40 bg-error/10 px-2 py-1 font-mono text-micro text-error hover:bg-error/20 disabled:cursor-not-allowed disabled:opacity-50"
                          data-testid={`gate-restore-${gate.id}`}
                        >
                          {restoringGateIds.has(gate.id) && (
                            <span
                              aria-hidden="true"
                              className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent"
                            />
                          )}
                          Restore
                        </button>
                      </div>
                    )}
                    {(gate.lastFailureSignature !== null || gate.lastFailureOriginId !== null || gate.lastFailureAt !== null) && (
                      <div className="mt-2 border-t border-border/30 pt-2 text-label text-muted-foreground">
                        <p>
                          Last failed
                          {gate.lastFailureAt !== null ? ` on ${formatAbsoluteDateTime(gate.lastFailureAt)}` : ''}.
                        </p>
                        <CollapsibleSection
                          label="Technical details"
                          srLabel={`Technical details of the last failure of ${gate.scope !== '.' ? `${gate.scope}: ` : ''}${gate.name}`}
                        >
                          {gate.lastFailureSignature !== null && <p>Signature: {gate.lastFailureSignature}</p>}
                          {gate.lastFailureOriginId !== null && <p>Origin task: {gate.lastFailureOriginId}</p>}
                        </CollapsibleSection>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </article>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const StewardSkeleton = () => (
  <PageShell testId="steward-page">
    <PageHeader title="Steward" />
    <PageBody className="gap-6">
    <GateHealthLane data={undefined} isLoading />
    {[0, 1, 2].map((i) => (
      <div
        key={i}
        className="h-32 w-full animate-pulse rounded-lg border border-border/50 bg-muted/10"
        aria-hidden="true"
      />
    ))}
    </PageBody>
  </PageShell>
)

export const StewardPage = () => {
  const { data, isLoading, error } = useStewardView()

  if (isLoading && data === undefined) return <StewardSkeleton />

  if (error !== null && data === undefined) {
    return (
      <div className="flex min-h-0 flex-1 overflow-hidden bg-background px-6 py-4" data-testid="steward-page">
        <GateHealthLane data={undefined} error={error} />
      </div>
    )
  }

  if (data === undefined) return <StewardSkeleton />

  return (
    <PageShell testId="steward-page">
      <PageHeader
        title="Steward"
        subtitle="What the Steward is wired to do and what it has actually done."
        actions={
          <div className="flex items-center gap-3 font-mono text-micro text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block h-1.5 w-6 rounded bg-success" />
              executing
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-1.5 w-6 rounded"
                style={{
                  background: 'repeating-linear-gradient(to right,transparent 0,transparent 3px,rgb(var(--color-muted-foreground)/0.4) 3px,rgb(var(--color-muted-foreground)/0.4) 6px)',
                }}
              />
              inert / unbuilt
            </span>
          </div>
        }
      />
      <PageBody className="gap-6">

      <div className="flex flex-col gap-4">
        {/* Lane 1: Runtime tuning — the only lane that actually executes */}
        <RuntimeTuningLane data={data.runtimeTuning} />

        <LaneConnector active={true} />

        {/* Lane 2: Signature storm — live, currently tripped */}
        <SignatureStormLane data={data.signatureStorm} />

        <LaneConnector active={data.workflowPatches.hasCallers} />

        {/* Lane 3: Workflow patches */}
        <WorkflowPatchesLane data={data.workflowPatches} />

        <LaneConnector active={data.workflowPatches.hasCallers} />

        {/* Lane 4: Verify gate registry health */}
        <GateHealthLane data={data.gateHealth} />
      </div>

      {/* Agent spec footer */}
      <footer className="mt-2 rounded border border-border/30 bg-muted/10 px-4 py-3">
        <div className="eyebrow mb-1 text-muted-foreground">
          Agent spec — {data.agentSpec.name} ({data.agentSpec.dispatchSites} dispatch site{data.agentSpec.dispatchSites !== 1 ? 's' : ''})
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-micro text-muted-foreground">
          <span>model: <span className="text-foreground">{data.agentSpec.model}</span></span>
          <span>tools: <span className="text-foreground">{data.agentSpec.allowedTools.join(', ')}</span></span>
          <span>events: <span className="text-foreground">{data.agentSpec.eventVariants.join(', ')}</span></span>
        </div>
      </footer>
      </PageBody>
    </PageShell>
  )
}
