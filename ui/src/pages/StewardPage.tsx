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

import { FallbackSurface } from '@/components/FallbackSurface'
import { useStewardView } from './useStewardView'
import type { StewardView } from './useStewardView'

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
    'flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-wider',
    active ? 'text-success' : 'text-muted-foreground',
  ].join(' ')

const StatusDot = ({ active }: { active: boolean }) => (
  <span
    aria-label={active ? 'executing' : 'not executing'}
    className={[
      'inline-block h-2 w-2 rounded-full',
      active ? 'bg-success' : 'bg-muted-foreground/40',
    ].join(' ')}
  />
)

// ---------------------------------------------------------------------------
// Runtime tuning lane
// ---------------------------------------------------------------------------

interface CapEntry {
  from: number
  to: number
  timestamp: string
  text: string
}

const CapRatchet = ({
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
  // Derive the full ratchet sequence: baseline → each bump
  const allValues = [baseline, ...entries.map((e) => e.to)]
  const min = Math.min(...allValues)
  const max = Math.max(ceiling, liveCap, ...allValues)
  const range = max - min || 1

  const toPercent = (v: number) => `${Math.round(((v - min) / range) * 100)}%`

  return (
    <div className="mb-4">
      <div className="mb-1 flex items-center justify-between font-mono text-[9px] text-muted-foreground">
        <span>baseline {baseline}</span>
        <span>ceiling {ceiling}</span>
      </div>
      {/* Bar */}
      <div className="relative h-7 w-full rounded bg-muted/30">
        {/* Ceiling marker */}
        <div
          className="absolute top-0 h-full w-px bg-warn/60"
          style={{ left: toPercent(ceiling) }}
          title={`ceiling: ${ceiling}`}
        />
        {/* Baseline marker */}
        <div
          className="absolute top-0 h-full w-px bg-primary/40"
          style={{ left: toPercent(baseline) }}
          title={`baseline: ${baseline}`}
        />
        {/* Live cap fill */}
        <div
          className="absolute top-0 left-0 h-full rounded bg-success/30 transition-[width]"
          style={{ width: toPercent(liveCap) }}
          title={`live cap: ${liveCap}`}
        />
        {/* Step markers */}
        {entries.map((e) => (
          <div
            key={e.timestamp}
            className="absolute top-0 h-full w-px bg-success/70"
            style={{ left: toPercent(e.to) }}
            title={`bumped to ${e.to}`}
          />
        ))}
        {/* Live cap label */}
        <span
          className="absolute top-0 flex h-full items-center pl-1 font-mono text-[10px] font-semibold text-success"
          style={{ left: toPercent(liveCap) }}
        >
          {liveCap}
        </span>
      </div>
      {/* Ratchet sequence */}
      {entries.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 font-mono text-[10px] text-muted-foreground">
          <span className="text-primary">{baseline}</span>
          {entries.map((e) => (
            <span key={e.timestamp} className="flex items-center gap-1">
              <span className="text-muted-foreground/50">→</span>
              <span className="text-success">{e.to}</span>
            </span>
          ))}
        </div>
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

  return (
    <article className={laneCardClass(true)} data-testid="lane-runtime-tuning">
      <header className="mb-4">
        <div className={laneHeaderClass(true)}>
          <StatusDot active={true} />
          <span>Runtime tuning</span>
          <span className="ml-auto rounded bg-success/20 px-1.5 py-0.5 text-[9px] text-success">executing</span>
        </div>
        <p className="mt-1 font-mono text-[10px] text-muted-foreground">
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

      {/* Acks — Steward's own first-person voice, newest first */}
      <div className="space-y-2">
        <div className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground/70">
          Steward acknowledgments ({acks.length})
        </div>
        {acks.length === 0 ? (
          <p className="font-mono text-[10px] text-muted-foreground">No acknowledgments yet.</p>
        ) : (
          acks.map((ack, i) => (
            <div
              key={ack.timestamp}
              className="rounded border border-success/20 bg-success/[0.03] px-3 py-2"
              data-testid={i === 0 ? 'steward-ack-latest' : undefined}
            >
              <p className="font-mono text-[11px] text-foreground">{ack.text}</p>
              <time className="font-mono text-[9px] text-muted-foreground">
                {new Date(ack.timestamp).toLocaleString()}
              </time>
            </div>
          ))
        )}
      </div>
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
            <span className="ml-auto rounded bg-error/20 px-1.5 py-0.5 text-[9px] text-error">
              breaker tripped
            </span>
          ) : (
            <span className="ml-auto rounded bg-success/20 px-1.5 py-0.5 text-[9px] text-success">
              breaker clear
            </span>
          )}
        </div>
        <p className="mt-1 font-mono text-[10px] text-muted-foreground">
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
          <p className="font-mono text-[11px] font-semibold text-warn">
            State disagreement detected
          </p>
          <p className="mt-0.5 font-mono text-[10px] text-warn/80">
            Breaker is {tripped ? 'tripped' : 'clear'} in Postgres, but dispatch is{' '}
            {isPaused ? 'paused' : 'running'} in memory. The daemon was likely restarted while the
            breaker was {tripped ? 'tripped' : 'clear'}. Run{' '}
            <code className="rounded bg-warn/20 px-1">mars operator</code> to re-align.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded border border-border/50 bg-muted/20 p-3">
          <div className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground/70">
            Breaker (Postgres)
          </div>
          <div
            className={`mt-1 font-mono text-[13px] font-semibold ${tripped ? 'text-error' : 'text-success'}`}
            data-testid="storm-tripped"
          >
            {tripped ? 'Tripped' : 'Clear'}
          </div>
          {updated_at && (
            <time className="font-mono text-[9px] text-muted-foreground">
              {new Date(updated_at).toLocaleString()}
            </time>
          )}
        </div>
        <div className="rounded border border-border/50 bg-muted/20 p-3">
          <div className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground/70">
            Dispatch (in-memory)
          </div>
          <div
            className={`mt-1 font-mono text-[13px] font-semibold ${isPaused ? 'text-error' : 'text-success'}`}
            data-testid="storm-is-paused"
          >
            {isPaused ? 'Paused' : 'Running'}
          </div>
          <p className="font-mono text-[9px] text-muted-foreground">resets on daemon restart</p>
        </div>
      </div>

      <div className="mt-3 space-y-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[9px] text-muted-foreground/70 uppercase tracking-wide w-28">
            Streak count
          </span>
          <span className="font-mono text-[12px] font-semibold text-foreground" data-testid="storm-streak">
            {streak_count}
          </span>
          <span className="font-mono text-[9px] text-muted-foreground">/ {tripThreshold} to trip</span>
        </div>
        {current_signature !== null && (
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[9px] text-muted-foreground/70 uppercase tracking-wide w-28">
              Signature
            </span>
            <code
              className="font-mono text-[10px] text-foreground break-all"
              data-testid="storm-signature"
            >
              {current_signature}
            </code>
          </div>
        )}
        {last_task_id !== null && (
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[9px] text-muted-foreground/70 uppercase tracking-wide w-28">
              Last task
            </span>
            <code className="font-mono text-[10px] text-muted-foreground">{last_task_id}</code>
          </div>
        )}
        {signatureStormAqCount > 0 && (
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[9px] text-muted-foreground/70 uppercase tracking-wide w-28">
              AQ items
            </span>
            <span className="font-mono text-[11px] text-error" data-testid="storm-aq-count">
              {signatureStormAqCount} signature-storm item{signatureStormAqCount !== 1 ? 's' : ''}
            </span>
          </div>
        )}
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Workflow patches lane — built, never invoked (inert)
// ---------------------------------------------------------------------------

const WorkflowPatchesLane = ({ data }: { data: StewardView['workflowPatches'] }) => {
  const { rows, hasCallers } = data

  return (
    <article className={laneCardClass(false)} data-testid="lane-workflow-patches">
      <header className="mb-4">
        <div className={laneHeaderClass(false)}>
          <StatusDot active={false} />
          <span>Workflow patches</span>
          <span className="ml-auto rounded bg-muted/30 px-1.5 py-0.5 text-[9px] text-muted-foreground">
            built — no callers
          </span>
        </div>
        <p className="mt-1 font-mono text-[10px] text-muted-foreground">
          stewardProposeWorkflowPatch, applyWorkflowPatch, and rejectWorkflowPatch are implemented
          but have no call sites outside their own module and tests.
          {hasCallers
            ? ' (callers detected — update this page)'
            : ' This lane cannot execute.'}
        </p>
      </header>
      {rows.length === 0 ? (
        <p
          className="font-mono text-[10px] text-muted-foreground"
          data-testid="patches-empty-state"
        >
          No proposals in workflow_patch_proposals. This lane has no callers — it is inert, not
          waiting.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="rounded border border-border/40 px-3 py-2 font-mono text-[10px]"
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
// Gate quarantine lane — declared in ADR-0081, not implemented
// ---------------------------------------------------------------------------

const GateQuarantineLane = () => (
  <article className={laneCardClass(false)} data-testid="lane-gate-quarantine">
    <header className="mb-4">
      <div className={laneHeaderClass(false)}>
        <StatusDot active={false} />
        <span>Gate quarantine</span>
        <span className="ml-auto rounded bg-muted/30 px-1.5 py-0.5 text-[9px] text-muted-foreground">
          decided — not built
        </span>
      </div>
      <p className="mt-1 font-mono text-[10px] text-muted-foreground">
        Declared in ADR-0081. No implementation exists — zero <code>quarantin*</code> matches in
        non-test source.
      </p>
    </header>
    <div
      className="rounded border border-dashed border-border/40 px-4 py-3 text-center"
      data-testid="quarantine-unbuilt"
    >
      <p className="font-mono text-[10px] text-muted-foreground/70">
        Architecture decided. Implementation not started.
      </p>
    </div>
  </article>
)

// ---------------------------------------------------------------------------
// Misnomer callout
// ---------------------------------------------------------------------------

const MisnomerCallout = () => (
  <aside
    className="rounded border border-warn/30 bg-warn/5 px-4 py-3"
    role="note"
    data-testid="misnomer-callout"
  >
    <p className="font-mono text-[10px] text-warn/90">
      <strong>Note — server.ts:1810 misnomer:</strong> The comment says it "spawns the steward",
      but <code>investigateWorktree</code> (server.ts:~2850) actually dispatches a fire-and-forget{' '}
      <strong>Haiku</strong> run via <code>runClaudeCode</code> — not <code>stewardAgent</code>.
      The stewardAgent is declared and registered but has zero production dispatch sites.
    </p>
  </aside>
)

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const StewardSkeleton = () => (
  <main className="flex h-full min-h-0 flex-1 flex-col gap-6 overflow-y-auto bg-background p-6">
    <header>
      <h1 className="font-mono text-[13px] uppercase tracking-wider text-primary">Steward</h1>
    </header>
    {[0, 1, 2, 3].map((i) => (
      <div
        key={i}
        className="h-32 w-full animate-pulse rounded-lg border border-border/50 bg-muted/10"
        aria-hidden="true"
      />
    ))}
  </main>
)

export const StewardPage = () => {
  const { data, isLoading, error } = useStewardView()

  if (isLoading && data === undefined) return <StewardSkeleton />

  if (error !== null && data === undefined) {
    return (
      <main className="flex min-h-0 flex-1 overflow-hidden bg-background">
        <FallbackSurface error={error} of="steward" variant="pane" />
      </main>
    )
  }

  if (data === undefined) return <StewardSkeleton />

  return (
    <main
      className="flex h-full min-h-0 flex-1 flex-col gap-6 overflow-y-auto bg-background p-6"
      data-testid="steward-page"
    >
      <header className="flex items-center gap-3">
        <h1 className="font-mono text-[13px] uppercase tracking-wider text-primary">Steward</h1>
        <p className="font-mono text-[10px] text-muted-foreground">
          What the Steward is wired to do and what it has actually done.
        </p>
        <div className="ml-auto flex items-center gap-3 font-mono text-[9px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-6 bg-success rounded" />
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
      </header>

      <MisnomerCallout />

      <div className="flex flex-col gap-4">
        {/* Lane 1: Runtime tuning — the only lane that actually executes */}
        <RuntimeTuningLane data={data.runtimeTuning} />

        <LaneConnector active={true} />

        {/* Lane 2: Signature storm — live, currently tripped */}
        <SignatureStormLane data={data.signatureStorm} />

        <LaneConnector active={false} />

        {/* Lane 3: Workflow patches — built, never invoked */}
        <WorkflowPatchesLane data={data.workflowPatches} />

        <LaneConnector active={false} />

        {/* Lane 4: Gate quarantine — decided, not built */}
        <GateQuarantineLane />
      </div>

      {/* Agent spec footer */}
      <footer className="mt-2 rounded border border-border/30 bg-muted/10 px-4 py-3">
        <div className="mb-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground/70">
          Agent spec — {data.agentSpec.name} ({data.agentSpec.dispatchSites} dispatch site{data.agentSpec.dispatchSites !== 1 ? 's' : ''})
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
          <span>model: <span className="text-foreground">{data.agentSpec.model}</span></span>
          <span>tools: <span className="text-foreground">{data.agentSpec.allowedTools.join(', ')}</span></span>
          <span>events: <span className="text-foreground">{data.agentSpec.eventVariants.join(', ')}</span></span>
        </div>
      </footer>
    </main>
  )
}
