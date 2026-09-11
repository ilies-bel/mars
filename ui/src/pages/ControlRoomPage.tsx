import { ArrowRight, Check, ChevronDown, Circle, TriangleAlert, X } from 'lucide-react'
import { ConnectionStatus } from '@/components/ConnectionStatus'
import { ActionButton, ActionLink } from '@/components/ActionButton'
import { Chip } from '@/components/Chip'
/**
 * ControlRoomPage — operator levers first, reference data below.
 *
 * Sections (top → bottom):
 *   1. Levers — dispatch pause/resume, recovery kill-switch, and concurrency
 *      caps. All controls show a confirm dialog before firing.
 *   2. Gates — verify-gate registry: name, tier, command, last failure, and a
 *      Restore button for quarantined gates. Empty state links to detect command.
 *   3. Now — SSE liveness dot + task counts by lifecycle cluster.
 *   4. Advisories — collapsed advisory action-queue items.
 *   5. Rules & Language — glossary chips and ADR list, collapsed by default
 *      behind a search/filter input so the heavy list doesn't scroll-block
 *      the controls above.
 *
 * Reachable at #/control.
 */

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchGlossary,
  fetchAdrs,
  fetchOperatorState,
  fetchVerifyGates,
  invokeAction,
  postOperatorDispatch,
  postOperatorRecovery,
  postRestoreVerifyGate,
  deleteVerifyGate,
  type OperatorState,
  type VerifyGate,
} from '@/shared/api'
import { useProgress } from '@/hooks/useProgress'
import { useStatusCounts } from '@/hooks/useStatusCounts'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { useDispatchState, pauseReasonLabel } from '@/entities/operator/useDispatchState'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { ActionQueueItem } from '@/shared/schemas'
import { PageHeader, SectionHeading, SectionLabel } from '@/widgets/primitives/DensityPrimitives'
import { relativeTime, formatAbsoluteDateTime } from '@/shared/time'
import { ErrorState } from '@/components/ErrorState'
import { SkeletonList } from '@/components/Skeleton'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog'
import { useStewardView } from './useStewardView'

// ---------------------------------------------------------------------------
// Advisory kinds shown in the digest (not in the main alert queue)
// ---------------------------------------------------------------------------

const ADVISORY_KINDS = new Set(['reflect-recommended', 'scorer-suggested', 'gate-enrichment'])

const isAdvisory = (item: ActionQueueItem): boolean => ADVISORY_KINDS.has(item.kind)

// ---------------------------------------------------------------------------
// Section 1 — Operator Levers
// ---------------------------------------------------------------------------

type ConfirmAction =
  | { kind: 'dispatch-off' }
  | { kind: 'dispatch-on' }
  | { kind: 'recovery-off' }
  | { kind: 'recovery-on' }

/**
 * These are asked BEFORE the lever moves, so every body is in the future
 * tense. "Dispatch paused. In-flight tasks unaffected." read as a report of
 * something already done, in a dialog whose whole purpose was to ask whether
 * to do it — the reader could not tell whether their click had landed.
 */
const CONFIRM_COPY: Record<ConfirmAction['kind'], { title: string; body: string; button: string }> =
  {
    'dispatch-off': {
      title: 'Pause dispatch?',
      body: 'No new task will be dispatched until you resume. Tasks already running finish normally, and the pause survives a daemon restart.',
      button: 'Pause dispatch',
    },
    'dispatch-on': {
      title: 'Resume dispatch?',
      body: 'Queued tasks start dispatching again, and the storm-breaker flag is cleared so a restart will not re-pause the queue.',
      button: 'Resume dispatch',
    },
    'recovery-off': {
      title: 'Disable recovery?',
      body: 'Mars stops spawning a fix task when a worker fails. Failures will pile up in Needs You until you turn recovery back on.',
      button: 'Disable recovery',
    },
    'recovery-on': {
      title: 'Enable recovery?',
      body: 'Mars resumes spawning one fix task per failure. Failures already waiting in Needs You are not retried retroactively.',
      button: 'Enable recovery',
    },
  }

const LeversSection = () => {
  const queryClient = useQueryClient()
  const { data: state, isLoading, isError, error: queryError } = useQuery<OperatorState>({
    queryKey: ['operator-state'],
    queryFn: fetchOperatorState,
    refetchInterval: 5_000,
  })

  const [pending, setPending] = useState<ConfirmAction | null>(null)
  const [acting, setActing] = useState(false)
  const [actError, setActError] = useState<string | null>(null)

  const openConfirm = (action: ConfirmAction) => {
    setActError(null)
    setPending(action)
  }

  const confirm = async () => {
    if (!pending) return
    setActing(true)
    setActError(null)
    try {
      if (pending.kind === 'dispatch-off') await postOperatorDispatch('off')
      else if (pending.kind === 'dispatch-on') await postOperatorDispatch('on')
      else if (pending.kind === 'recovery-off') await postOperatorRecovery('off')
      else if (pending.kind === 'recovery-on') await postOperatorRecovery('on')
      setPending(null)
      void queryClient.invalidateQueries({ queryKey: ['operator-state'] })
    } catch (err) {
      setActError(err instanceof Error ? err.message : String(err))
    } finally {
      setActing(false)
    }
  }

  const copy = pending ? CONFIRM_COPY[pending.kind] : null

  if (isLoading) {
    return (
      <section>
        <SectionHeading>Levers</SectionHeading>
        <SkeletonList rows={2} rowClassName="h-16 w-full mb-3" label="Loading levers" />
      </section>
    )
  }

  if (isError || !state) {
    return (
      <section>
        <SectionHeading>Levers</SectionHeading>
        <ErrorState
          error={queryError ?? new Error('Operator state unavailable')}
          of="levers"
          variant="inline"
        />
      </section>
    )
  }

  const { dispatch, controlLevers, caps } = state
  const isDispatchPaused = dispatch.paused

  return (
    <>
      <section>
        <SectionHeading>Levers</SectionHeading>

        <div className="space-y-3">
          {/* Dispatch lever */}
          <div className="mars-card flex items-start justify-between gap-4 rounded bg-surface px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className={[
                    'h-2 w-2 shrink-0 rounded-full',
                    isDispatchPaused ? 'bg-warn' : 'bg-success',
                  ].join(' ')}
                  aria-hidden="true"
                />
                <span className="text-title font-semibold text-foreground">Dispatch</span>
                <Chip tone={isDispatchPaused ? 'warn' : 'success'}>
                  {isDispatchPaused ? 'paused' : 'running'}
                </Chip>
              </div>
              {isDispatchPaused && dispatch.reason && (
                <p className="mt-1 text-label text-muted-foreground">
                  Reason: {pauseReasonLabel(dispatch)}
                  {dispatch.since ? ` · since ${relativeTime(dispatch.since)}` : ''}
                </p>
              )}
              {isDispatchPaused && dispatch.reason === 'baseline' && (
                <p className="mt-0.5 text-micro text-muted-foreground" data-testid="dispatch-baseline-note">
                  Resuming will not help — the check is re-run and the pause comes
                  straight back. Fix the failing gate; dispatch resumes on its own.
                </p>
              )}
            </div>
            {/* A baseline pause is the one pause Resume cannot lift.
                CLAUDE.md is explicit: the command clears the latch, the
                baseline health checker re-asserts it on its next run because
                the branch still fails a required gate, and in the window
                between, work is dispatched into a red integration branch.
                Offering Resume here is offering the one action the docs single
                out as harmful — and the Progress banner for the same condition
                already says the opposite ("Fix the gate to resume"). Three
                surfaces, one condition, one answer. */}
            {isDispatchPaused && dispatch.reason === 'baseline' ? (
              <ActionButton
                variant="secondary"
                onClick={() =>
                  document
                    .querySelector('[data-testid="gates-section"]')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
                data-testid="dispatch-view-gates"
              >
                View failing gates
              </ActionButton>
            ) : (
              <ActionButton
                variant="secondary"
                onClick={() =>
                  openConfirm(isDispatchPaused ? { kind: 'dispatch-on' } : { kind: 'dispatch-off' })
                }
              >
                {isDispatchPaused ? 'Resume' : 'Pause'}
              </ActionButton>
            )}
          </div>

          {/* Recovery lever */}
          <div className="mars-card flex items-start justify-between gap-4 rounded bg-surface px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className={[
                    'h-2 w-2 shrink-0 rounded-full',
                    controlLevers.recovery === 'off' ? 'bg-error' : 'bg-success',
                  ].join(' ')}
                  aria-hidden="true"
                />
                <span className="text-title font-semibold text-foreground">Recovery</span>
                <Chip tone={controlLevers.recovery === 'off' ? 'error' : 'success'}>
                  {controlLevers.recovery}
                </Chip>
              </div>
              <p className="mt-1 text-label text-muted-foreground">
                {controlLevers.recovery === 'off'
                  ? 'Fix-task spawning disabled — failures will accumulate.'
                  : 'Fix tasks spawn automatically on worker failure.'}
              </p>
            </div>
            <ActionButton
              variant="secondary"
              onClick={() =>
                openConfirm(
                  controlLevers.recovery === 'off'
                    ? { kind: 'recovery-on' }
                    : { kind: 'recovery-off' },
                )
              }
              >
                {controlLevers.recovery === 'off' ? 'Enable' : 'Disable'}
              </ActionButton>
          </div>

          {/* Caps — read-only.
           *
           * These were five 32px numerals: the largest type anywhere in the
           * application, spent on five configuration constants that change
           * about never, directly above a gate list where seven of twelve were
           * red at 13px. Size should track how much a number can change and
           * how much it costs you when it does; by that measure these rank
           * last on the page. One line now. */}
          <div className="mars-card flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded bg-surface px-4 py-3">
            <span className="eyebrow text-muted-foreground">Concurrency caps</span>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <CapStat label="implement" value={caps.implement} />
              <CapStat label="triage" value={caps.triage} />
              <CapStat label="refine" value={caps.refine} />
              <CapStat label="verify" value={caps.verify} />
              <CapStat label="setup-install" value={caps.setupInstall} />
            </div>
          </div>
        </div>
      </section>

      {/* Confirm dialog */}
      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null) }}>
        <DialogContent>
          {copy && (
            <>
              <DialogHeader>
                <DialogTitle className="text-title">{copy.title}</DialogTitle>
                <DialogDescription className="text-body text-foreground">
                  {copy.body}
                </DialogDescription>
              </DialogHeader>
              {actError && (
                <p className="text-label text-error">{actError}</p>
              )}
              {/* Cancel wore a full border and the committing button a 10%
                  wash, so the dialog's own recommendation read as "don't".
                  One filled primary per row, and it is the verb you opened the
                  dialog to run. */}
              <DialogFooter>
                <DialogClose asChild>
                  <ActionButton variant="ghost">Cancel</ActionButton>
                </DialogClose>
                <ActionButton
                  variant="primary"
                  onClick={() => { void confirm() }}
                  disabled={acting}
                  pending={acting}
                >
                  {copy.button}
                </ActionButton>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

const CapStat = ({ label, value }: { label: string; value: number }) => (
  <span className="whitespace-nowrap text-label text-muted-foreground">
    {label}{' '}
    <span className="font-semibold tabular-nums text-foreground">{value}</span>
  </span>
)

// ---------------------------------------------------------------------------
// Section 2 — Gates (verify-gate registry)
// ---------------------------------------------------------------------------

type GateActionKind = 'quarantine' | 'restore' | 'retire'

const GATE_ACTION_COPY: Record<GateActionKind, { title: string; body: string; button: string }> = {
  quarantine: {
    title: 'Quarantine this gate?',
    body: 'Tasks will merge without running this check until the gate is restored.',
    button: 'Quarantine gate',
  },
  restore: {
    title: 'Restore this gate?',
    body: 'Gate re-activates for future verifications.',
    button: 'Restore gate',
  },
  retire: {
    title: 'Retire this gate?',
    body: 'This gate will be permanently removed. This cannot be undone.',
    button: 'Retire gate',
  },
}

const GatesSection = () => {
  const queryClient = useQueryClient()
  const { data: gatesData, isLoading, isError, error: queryError } = useQuery<VerifyGate[]>({
    queryKey: ['verify-gates'],
    queryFn: () => fetchVerifyGates(),
    refetchInterval: 30_000,
  })

  const [pending, setPending] = useState<{ kind: GateActionKind; gate: VerifyGate } | null>(null)
  const [acting, setActing] = useState(false)
  const [actError, setActError] = useState<string | null>(null)

  const openDialog = (kind: GateActionKind, gate: VerifyGate) => {
    setActError(null)
    setPending({ kind, gate })
  }

  const handleConfirm = async () => {
    if (!pending) return
    setActing(true)
    setActError(null)
    try {
      if (pending.kind === 'restore') {
        await postRestoreVerifyGate(pending.gate.id)
      } else {
        // quarantine and retire both call DELETE — the daemon distinguishes
        // them by whether the gate is currently active or quarantined
        await deleteVerifyGate(pending.gate.id)
      }
      setPending(null)
      void queryClient.invalidateQueries({ queryKey: ['verify-gates'] })
    } catch (err) {
      setActError(err instanceof Error ? err.message : String(err))
    } finally {
      setActing(false)
    }
  }

  if (isLoading) {
    return (
      <section data-testid="gates-section">
        <SectionHeading>Gates</SectionHeading>
        <SkeletonList rows={2} rowClassName="h-10 w-full mb-2" label="Loading gates" />
      </section>
    )
  }

  if (isError || !gatesData) {
    return (
      <section data-testid="gates-section">
        <SectionHeading>Gates</SectionHeading>
        <ErrorState
          error={queryError ?? new Error('Verify gates unavailable')}
          of="gates"
          variant="inline"
        />
      </section>
    )
  }

  // A gate is currently failing when it has a failure timestamp and either
  // has never passed or its last failure is more recent than its last pass.
  const isCurrentlyFailing = (gate: VerifyGate): boolean => {
    if (gate.lastFailureAt === null) return false
    if (gate.lastPassAt === null) return true
    return gate.lastFailureAt > gate.lastPassAt
  }

  // A failing gate is "stale" when the most recent run (pass OR fail) happened
  // more than 24 hours ago. "Failed 6d ago" is ambiguous — it could mean the
  // gate is still broken, or just that nothing has run it since. Stale gates
  // are distinguished from fresh failures so the reader knows whether the
  // signal is current.
  const STALE_CUTOFF_MS = 24 * 60 * 60 * 1000
  const isStale = (gate: VerifyGate): boolean => {
    if (!isCurrentlyFailing(gate)) return false
    const lastRunAt = Math.max(gate.lastPassAt ?? 0, gate.lastFailureAt ?? 0)
    return lastRunAt > 0 && Date.now() - lastRunAt > STALE_CUTOFF_MS
  }

  // Required gates that are quarantined — merges are proceeding without them.
  const quarantinedRequired = gatesData.filter(
    (g) => g.state === 'quarantined' && g.required,
  )

  const failingGates = gatesData.filter(isCurrentlyFailing)
  const staleGates = failingGates.filter(isStale)
  const freshFailingGates = failingGates.filter((g) => !isStale(g))
  const neverRunGates = gatesData.filter(
    (g) => g.lastPassAt === null && g.lastFailureAt === null,
  )
  // Oldest still-unfixed breakage. A gate red for two weeks is a different
  // story from one that broke this morning, and the list sorts by neither.
  const oldestFailureAt = failingGates.reduce<number | null>(
    (acc, g) =>
      g.lastFailureAt === null ? acc : acc === null ? g.lastFailureAt : Math.min(acc, g.lastFailureAt),
    null,
  )

  // "9 of 12 failing" says the other three pass. Three of them had never been
  // run, so the sentence invented three passing gates out of three unknowns —
  // and "0 passing" is exactly the fact it was hiding. State the partition
  // whenever it does not divide cleanly into failing and passing.
  // The gates that actually hold the baseline: required, currently failing,
  // not quarantined. "Fix the required gate to resume" is unanswerable without
  // this number — nine red rows and no way to tell which ones matter.
  const blockingGates = failingGates.filter(
    (g) => g.required && g.state !== 'quarantined',
  )
  const passingGateCount = gatesData.length - failingGates.length - neverRunGates.length
  // Distinguish failing (fresh) · stale (old failure, no recent check) · never run · passing.
  const failingVerdict = (() => {
    const parts: string[] = []
    if (freshFailingGates.length > 0) parts.push(`${freshFailingGates.length} failing`)
    if (staleGates.length > 0) parts.push(`${staleGates.length} stale`)
    if (neverRunGates.length > 0) parts.push(`${neverRunGates.length} never run`)
    parts.push(`${passingGateCount} passing`)
    return parts.join(' · ')
  })()

  const copy = pending ? GATE_ACTION_COPY[pending.kind] : null

  // Most recent run across all gates. Null when no gate has ever run.
  // Shown in the header so the reader knows whether the current panel state
  // is fresh or stale at a glance.
  const mostRecentRunAt = gatesData.reduce<number | null>((acc, g) => {
    const ts = Math.max(g.lastPassAt ?? 0, g.lastFailureAt ?? 0)
    if (ts === 0) return acc
    return acc === null ? ts : Math.max(acc, ts)
  }, null)

  return (
    <>
      <section data-testid="gates-section">
        {/* The heading states the answer, not the noun. "Gates 12" made the
            reader scan twelve rows to learn that seven were red — a count the
            page had already computed. The oldest breakage is included because
            "failing" and "failing since a fortnight ago" are different
            problems, and only one of them is news. */}
        <SectionHeading
          count={gatesData.length}
          verdict={
            failingGates.length > 0 ? (
              <span className="font-medium text-error" data-testid="gates-verdict">
                {failingVerdict}
                {blockingGates.length > 0 && ` · ${blockingGates.length} blocking merges`}
                {oldestFailureAt !== null && ` · oldest ${relativeTime(oldestFailureAt)}`}
              </span>
            ) : (
              <span className="font-medium text-success" data-testid="gates-verdict">
                {neverRunGates.length > 0
                  ? `all ${gatesData.length - neverRunGates.length} run gates passing · ${neverRunGates.length} never run`
                  : `all ${gatesData.length} passing`}
              </span>
            )
          }
        >
          Gates
        </SectionHeading>
        {mostRecentRunAt !== null && (
          <p
            className="mb-2 text-micro text-muted-foreground"
            data-testid="gates-last-checked"
          >
            Last checked{' '}
            <span title={formatAbsoluteDateTime(mostRecentRunAt)}>
              {relativeTime(mostRecentRunAt)}
            </span>
          </p>
        )}

        {quarantinedRequired.length > 0 && (
          <div
            className="mb-3 rounded border border-error/30 bg-error/5 px-4 py-3"
            data-testid="quarantine-banner"
          >
            <p className="flex items-center gap-1.5 text-label font-semibold text-error">
              <TriangleAlert size={13} strokeWidth={2} aria-hidden="true" />
              {quarantinedRequired.length} required gate{quarantinedRequired.length !== 1 ? 's are' : ' is'} quarantined — merges are proceeding unchecked
            </p>
            <ul className="mt-1 space-y-0.5">
              {quarantinedRequired.map((g) => (
                <li key={g.id} className="font-mono text-micro text-error/70">
                  {g.scope !== '.' ? `${g.scope}: ` : ''}{g.name}
                </li>
              ))}
            </ul>
          </div>
        )}

        {gatesData.length === 0 ? (
          <p className="font-mono text-label text-muted-foreground">
            No gates yet — run <code className="font-mono text-micro bg-surface px-1 rounded">mars verify-gate detect</code>
          </p>
        ) : (
          <ul
            className="divide-y divide-border/70 overflow-hidden rounded-lg border border-border/60 bg-surface shadow-[var(--shadow-e1)]"
          >
            {gatesData.map((gate) => {
              const failing = isCurrentlyFailing(gate)
              const stale = isStale(gate)
              const gateDisplayName = gate.scope !== '.' ? `${gate.scope}: ${gate.name}` : gate.name
              return (
                <li
                  key={gate.id}
                  className="row-actions-host group/gate flex items-center gap-3 px-4 py-2.5 transition-colors duration-[var(--dur-fast)] hover:bg-background/60"
                  data-testid={`gate-row-${gate.id}`}
                >
                  {/* Status is a glyph, not a word: twelve rows each shouting
                      PASSING/FAILING in a coloured pill made the state harder to
                      scan, not easier. The column aligns so a failing gate is
                      findable in one vertical sweep.

                      Three states: passing (green check), failing (red X),
                      stale (amber X — failed, but nothing has run recently so
                      the signal may be outdated). "Stale" sits between failing
                      and never-run: we know it failed once, but we don't know
                      whether it's still broken. */}
                  {gate.lastPassAt !== null || gate.lastFailureAt !== null ? (
                    <span
                      className={[
                        'flex size-3.5 shrink-0 items-center justify-center',
                        failing ? (stale ? 'text-warn' : 'text-error') : 'text-success',
                      ].join(' ')}
                      title={failing ? (stale ? 'stale — last run over 24 h ago' : 'failing') : 'passing'}
                      data-testid={failing ? (stale ? 'gate-status-stale' : 'gate-status-failing') : 'gate-status-passing'}
                    >
                      {failing ? (
                        <X size={12} strokeWidth={3} aria-hidden="true" />
                      ) : (
                        <Check size={12} strokeWidth={3} aria-hidden="true" />
                      )}
                      <span className="sr-only">{failing ? (stale ? 'stale' : 'failing') : 'passing'}</span>
                    </span>
                  ) : (
                    /* Never run. This branch previously rendered a bare grey dot
                       with a title and no sr-only text, so three gates on this
                       page announced nothing whatsoever. */
                    <span
                      className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground"
                      title="never run"
                      data-testid="gate-status-never-run"
                    >
                      <Circle size={10} strokeWidth={2} aria-hidden="true" />
                      <span className="sr-only">never run</span>
                    </span>
                  )}

                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="truncate text-body font-medium text-foreground">
                        {gateDisplayName}
                      </span>
                      {gate.tier === 'integration' && <Chip tone="info">integration</Chip>}
                      {!gate.required && <Chip tone="warn">advisory</Chip>}
                      {gate.state === 'quarantined' && <Chip tone="error">quarantined</Chip>}
                      {/* "Fix the required gate to resume" sent the reader to a
                          list of twelve in which "required" was expressed by the
                          ABSENCE of the advisory chip, with nine gates red and
                          nothing saying which one was holding the baseline. A
                          required gate that is currently failing and not
                          quarantined is exactly the thing that pauses dispatch —
                          so name it, positively, on the row. */}
                      {gate.required && failing && gate.state !== 'quarantined' && (
                        <Chip tone="error" data-testid="gate-blocking">blocking merges</Chip>
                      )}
                    </div>
                    <p className="truncate font-mono text-micro text-muted-foreground">
                      {[gate.cmd, ...gate.args].join(' ')}
                      {gate.scope !== '.' && (
                        <span className="text-muted-foreground"> in {gate.scope}</span>
                      )}
                    </p>
                  </div>

                  {/* Timing sits in its own right-aligned column so the eye can
                      read "when did this last break" down the list. */}
                  <div className="hidden shrink-0 flex-col items-end gap-0.5 text-micro tabular-nums sm:flex">
                    {/* A gate with neither timestamp left this column
                        completely blank. In a list where every other row ends
                        in "failed 6d ago", a blank cell reads as "fine" — and
                        a gate that has never run is materially WORSE than one
                        that failed six days ago, because nothing has ever
                        checked what it checks. It is the only state on this
                        page that was presented as unremarkable. */}
                    {gate.lastPassAt === null && gate.lastFailureAt === null && (
                      <span className="text-warn" data-testid="gate-never-run">
                        never run
                      </span>
                    )}
                    {!failing && gate.lastPassAt !== null && (
                      <span className="text-muted-foreground" data-testid="gate-last-pass">
                        passed{' '}
                        <span title={formatAbsoluteDateTime(gate.lastPassAt)}>
                          {relativeTime(gate.lastPassAt)}
                        </span>
                      </span>
                    )}
                    {stale && (
                      <span className="text-warn" data-testid="gate-status-stale-label">
                        stale — last run{' '}
                        <span
                          title={formatAbsoluteDateTime(
                            Math.max(gate.lastPassAt ?? 0, gate.lastFailureAt ?? 0),
                          )}
                        >
                          {relativeTime(Math.max(gate.lastPassAt ?? 0, gate.lastFailureAt ?? 0))}
                        </span>
                      </span>
                    )}
                    {gate.lastFailureAt !== null && (
                      <span
                        className={failing ? (stale ? 'text-warn/80' : 'text-error/80') : 'text-muted-foreground'}
                        data-testid="gate-last-failure"
                      >
                        failed{' '}
                        <span title={formatAbsoluteDateTime(gate.lastFailureAt)}>
                          {relativeTime(gate.lastFailureAt)}
                        </span>
                      </span>
                    )}
                  </div>

                  {/* Actions stay mounted (so they are keyboard-reachable and
                      never reflow the row) but fade up on row hover / focus, so
                      a list of twelve gates is not also a list of twenty-four
                      competing buttons — twelve of them a destructive `Retire`
                      in the stop colour, on a page whose job is to report gate
                      health. The comment above said this before the round-7
                      review; only the comment did. `.row-actions` (index.css)
                      carries the opacity, and pins it to 1 where hover does not
                      exist so this is not a desktop-only affordance. */}
                  <div className="row-actions flex shrink-0 items-center gap-1">
                    {gate.state === 'quarantined' ? (
                      <ActionButton
                        size="sm"
                        variant="ghost"
                        onClick={() => { openDialog('restore', gate) }}
                        data-testid="gate-restore-btn"
                      >
                        Restore
                      </ActionButton>
                    ) : (
                      <ActionButton
                        size="sm"
                        variant="secondary"
                        onClick={() => { openDialog('quarantine', gate) }}
                        data-testid="gate-quarantine-btn"
                      >
                        Quarantine
                      </ActionButton>
                    )}
                    <ActionButton
                      size="sm"
                      variant="danger"
                      onClick={() => { openDialog('retire', gate) }}
                      data-testid="gate-retire-btn"
                    >
                      Retire
                    </ActionButton>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* Confirm dialog for quarantine / restore / retire */}
      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="">{copy?.title}</DialogTitle>
            <DialogDescription className="text-label">
              {pending && (
                <span className="font-medium text-foreground">
                  {pending.gate.scope !== '.' ? `${pending.gate.scope}: ` : ''}{pending.gate.name}
                </span>
              )}
              {' — '}{copy?.body}
            </DialogDescription>
          </DialogHeader>
          {actError && (
            <p className="text-label text-error">{actError}</p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <button
                className="rounded-md border border-border px-4 py-2 text-label text-foreground hover:bg-surface transition-colors"
                disabled={acting}
              >
                Cancel
              </button>
            </DialogClose>
            <button
              onClick={() => { void handleConfirm() }}
              disabled={acting}
              className={[
                'rounded-md px-4 py-2 text-label font-medium text-white transition-colors disabled:opacity-50',
                pending?.kind === 'retire'
                  ? 'bg-error hover:bg-error/90'
                  : pending?.kind === 'quarantine'
                    ? 'bg-warn hover:bg-warn/90'
                    : 'bg-primary hover:bg-primary/90',
              ].join(' ')}
              data-testid="gate-action-confirm-btn"
            >
              {acting ? 'Working…' : (copy?.button ?? 'Confirm')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ---------------------------------------------------------------------------
// Section 3 — Now (dispatch state + task counts)
// ---------------------------------------------------------------------------

const NowSection = () => {
  const { tasks, connected } = useProgress()
  const { running: inProgress, failed, doneToday } = useStatusCounts()
  const dispatch = useDispatchState()

  const queued = tasks?.filter((t) => t.cluster === 'Queued').length ?? 0
  const blocked = tasks?.filter((t) => t.cluster === 'Blocked').length ?? 0
  // Recovery tasks that failed. They are excluded from `failed` above and
  // included on the board; naming them here is what makes both numbers add up.
  const failedRetries =
    tasks?.filter((t) => t.cluster === 'Failed' && t.fixForTaskId != null).length ?? 0

  return (
    <section>
      <SectionHeading>Now</SectionHeading>

      <div className="mars-card rounded bg-surface px-4 py-3">
        {/* The top stripe's indicator links here; both now say the same thing. */}
        <ConnectionStatus
          className="mb-4"
          connected={connected}
          paused={dispatch.paused}
          pauseLabel={dispatch.paused ? pauseReasonLabel(dispatch) : null}
          pauseDetail={dispatch.detail}
        />

        {/* Failed counts the work YOU asked for: `status = 'failed' AND
            fix_for_task_id IS NULL` (view/status-counts.ts). The board on
            #/progress has no such filter, so a failed recovery attempt is a
            card there and not a unit here — that is the whole of the 23-vs-24
            the two surfaces showed at the same instant, under a label saying
            "Live". Rather than explain the gap in prose, the Failed stat now
            carries the retries as a second number, so both totals are
            reachable from this strip and the board stops being a surprise. */}
        <p className="mb-3 text-label text-muted-foreground">Tasks right now.</p>

        <div className="grid grid-cols-3 gap-x-4 gap-y-3 sm:grid-cols-5">
          <Stat
            label="Queued"
            value={queued}
            colorClass={queued > 0 ? 'text-foreground' : undefined}
          />
          <Stat
            label="In progress"
            value={inProgress}
            colorClass={inProgress > 0 ? 'text-foreground' : undefined}
          />
          <Stat
            label="Blocked"
            value={blocked}
            colorClass={blocked > 0 ? 'text-foreground' : undefined}
          />
          <Stat
            label="Failed"
            value={failed}
            colorClass={failed > 0 ? 'text-status-failed' : undefined}
            note={
              failedRetries > 0
                ? `+${failedRetries} ${failedRetries === 1 ? 'retry' : 'retries'} also failed`
                : undefined
            }
            noteTitle={
              failedRetries > 0
                ? `Mars spawns one recovery attempt per failure. ${failedRetries} of those failed too, and the board on #/progress counts ${failed + failedRetries} cards because it shows them.`
                : undefined
            }
          />
          <Stat
            label="Done · 24h"
            value={doneToday}
            colorClass={doneToday > 0 ? 'text-status-done' : undefined}
          />
        </div>
      </div>
    </section>
  )
}

interface StatProps {
  label: string
  value: number
  colorClass?: string
  /** A second, smaller number this one deliberately excludes. */
  note?: string
  noteTitle?: string
}

const Stat = ({ label, value, colorClass, note, noteTitle }: StatProps) => (
  <div className="flex flex-col">
    <span
      className={[
        'text-title font-semibold leading-none tabular-nums',
        colorClass ?? 'text-muted-foreground',
      ].join(' ')}
    >
      {value}
    </span>
    <span className="eyebrow mt-0.5 text-muted-foreground">
      {label}
    </span>
    {note != null && (
      <span className="mt-0.5 text-micro text-muted-foreground" title={noteTitle}>
        {note}
      </span>
    )}
  </div>
)

// ---------------------------------------------------------------------------
// Section 4 — Engine (daemon-code-drift restart button)
// ---------------------------------------------------------------------------

/**
 * Shows when the daemon has drifted behind the code on disk.
 * Mirrors the `daemon-code-drift` card's restart action so the operator does
 * not have to leave the Control Room and open a terminal.
 *
 * Before firing the restart the component checks how many tasks are currently
 * running and names them (by human title, not id — DEC-18):
 *  - Zero tasks → one click: restart fires immediately.
 *  - N tasks → confirm dialog that quotes the count so the cost is explicit.
 *
 * After the restart fires the component polls the action-queue cache until the
 * daemon-code-drift condition disappears or a 30-second deadline expires; if
 * the deadline is hit it surfaces a terminal-command fallback.
 */
const EngineSection = () => {
  const queryClient = useQueryClient()
  const { items } = useActionQueue()
  const { byCluster } = useProgress()

  const driftItem = items.find((i) => i.kind === 'daemon-code-drift') ?? null
  const runningTasks = byCluster?.['In progress'] ?? []
  const runningCount = runningTasks.length

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)
  const [timedOut, setTimedOut] = useState(false)

  const doRestart = async () => {
    setRestarting(true)
    setRestartError(null)
    setTimedOut(false)
    setConfirmOpen(false)
    try {
      await invokeAction('restart-daemon')
      // Poll until the daemon-code-drift condition clears, up to 30 seconds.
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 1_500))
        await queryClient.invalidateQueries({ queryKey: ['action-queue'] })
        const cached = queryClient.getQueryData<{ items: Array<{ kind: string }> }>(
          ['action-queue'],
        )
        if (!cached?.items?.some((i) => i.kind === 'daemon-code-drift')) break
      }
      if (Date.now() >= deadline) setTimedOut(true)
    } catch (err) {
      setRestartError(err instanceof Error ? err.message : String(err))
    } finally {
      setRestarting(false)
    }
  }

  const handleRestartClick = () => {
    if (runningCount > 0) {
      setConfirmOpen(true)
    } else {
      void doRestart()
    }
  }

  // All hooks must be called above this point (Rules of Hooks).
  if (!driftItem) return null

  return (
    <>
      <section data-testid="engine-drift-section">
        <SectionHeading>Engine</SectionHeading>
        <div className="mars-card rounded border border-warn/30 bg-warn/5 px-4 py-3">
          <p className="text-body font-medium text-warn">
            {driftItem.title ?? 'Engine update available'}
          </p>
          {driftItem.body && (
            <p className="mt-1 text-micro text-muted-foreground">
              {driftItem.body}
            </p>
          )}
          {runningCount > 0 && (
            <p
              className="mt-2 text-micro text-muted-foreground"
              data-testid="engine-running-count"
            >
              {runningCount} task{runningCount !== 1 ? 's are' : ' is'} currently running — will be
              stopped and re-queued on restart.
            </p>
          )}
          {timedOut && (
            <p
              className="mt-2 text-label text-error"
              data-testid="engine-timeout-msg"
            >
              Daemon did not respond. Run{' '}
              <code className="font-mono text-micro bg-surface px-1 rounded">
                mars daemon restart
              </code>{' '}
              in a terminal to retry.
            </p>
          )}
          {restartError && (
            <p className="mt-2 text-label text-error" data-testid="engine-restart-error">
              {restartError}
            </p>
          )}
          <div className="mt-3">
            <button
              onClick={handleRestartClick}
              disabled={restarting}
              className="rounded-md border border-warn/50 bg-warn/10 px-3 py-1.5 text-label text-warn hover:bg-warn/20 disabled:opacity-50 transition-colors"
              data-testid="restart-engine-btn"
            >
              {restarting ? 'Restarting…' : 'Restart engine'}
            </button>
          </div>
        </div>
      </section>

      {/* Confirm dialog — only shown when tasks are in flight */}
      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) setConfirmOpen(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-title">Restart engine?</DialogTitle>
            <DialogDescription
              className="text-body text-foreground"
              data-testid="engine-restart-confirm-body"
            >
              {runningCount} task{runningCount !== 1 ? 's are' : ' is'} currently running and will
              be stopped and re-queued. Restart anyway?
            </DialogDescription>
          </DialogHeader>
          <ul className="mt-1 space-y-0.5" data-testid="engine-running-tasks-list">
            {runningTasks.slice(0, 5).map((t) => (
              <li key={t.id} className="font-mono text-micro text-muted-foreground">
                · {t.intent ?? t.prompt.slice(0, 60)}
              </li>
            ))}
            {runningTasks.length > 5 && (
              <li className="text-micro text-muted-foreground">
                … and {runningTasks.length - 5} more
              </li>
            )}
          </ul>
          {restartError && (
            <p className="text-label text-error">{restartError}</p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <button className="rounded border border-border px-3 py-1.5 text-label text-foreground hover:border-border/80">
                Cancel
              </button>
            </DialogClose>
            <button
              onClick={() => {
                void doRestart()
              }}
              disabled={restarting}
              className="rounded border border-warn/50 bg-warn/10 px-3 py-1.5 text-label text-warn hover:bg-warn/20 disabled:opacity-50"
              data-testid="engine-restart-confirm-btn"
            >
              {restarting ? 'Restarting…' : 'Restart anyway'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ---------------------------------------------------------------------------
// Section 5 — Advisories (section numbering offset by new EngineSection)
// ---------------------------------------------------------------------------

const ADVISORY_LABELS: Record<string, string> = {
  'reflect-recommended': 'Reflect',
  'scorer-suggested': 'Scorer',
  'gate-enrichment': 'Gate',
}

const AdvisorySection = () => {
  const { items } = useActionQueue()
  const advisories = items.filter(isAdvisory)

  return (
    <section>
      <SectionHeading>Advisories</SectionHeading>

      <div className="mb-4 flex gap-4">
        <ActionLink href="#/steward" variant="ghost" size="sm">
            <ArrowRight size={12} strokeWidth={2} aria-hidden="true" />
            Steward ledgers
          </ActionLink>
        <ActionLink href="#/reflections" variant="ghost" size="sm">
            <ArrowRight size={12} strokeWidth={2} aria-hidden="true" />
            Deep reflections
          </ActionLink>
      </div>

      {advisories.length === 0 ? (
        <p className="text-label text-muted-foreground">No pending advisories.</p>
      ) : (
        <ul className="space-y-2">
          {advisories.map((item) => (
            <li
              key={item.id}
              className="mars-card rounded bg-surface px-3 py-2"
            >
              <div className="flex items-start gap-2">
                <span className="eyebrow mt-0.5 shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-muted-foreground">
                  {ADVISORY_LABELS[item.kind] ?? item.kind.replace(/-/g, ' ')}
                </span>
                <span className="text-body text-foreground">{item.title}</span>
              </div>
              {item.body && (
                <p className="mt-1 text-label text-muted-foreground leading-snug">
                  {item.body}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Section 6 — Rules & Language (collapsed, searchable)
// ---------------------------------------------------------------------------

const RulesSection = () => {
  const { focusedProjectId: projectId } = useFocusedProject()
  const [expanded, setExpanded] = useState(false)
  const [search, setSearch] = useState('')

  const { data: terms = [] } = useQuery({
    queryKey: ['glossary'],
    queryFn: fetchGlossary,
    enabled: expanded,
  })

  const { data: adrs = [] } = useQuery({
    queryKey: ['adrs', projectId],
    queryFn: () => fetchAdrs(projectId ?? undefined),
    enabled: expanded,
  })

  const q = search.toLowerCase().trim()
  const filteredTerms = q ? terms.filter((t) => t.term.toLowerCase().includes(q) || t.definition.toLowerCase().includes(q)) : terms
  const filteredAdrs = q ? adrs.filter((a) => a.title.toLowerCase().includes(q) || String(a.number).includes(q)) : adrs

  return (
    <section>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="mb-3 -mx-2 flex w-full items-center justify-between rounded-md px-2 py-1.5 transition-colors hover:bg-foreground/5"
        aria-expanded={expanded}
      >
        <SectionLabel>Rules &amp; Language</SectionLabel>
        <span
          className={[
            'text-micro text-muted-foreground transition-transform duration-200',
            expanded ? 'rotate-180' : '',
          ].join(' ')}
          aria-hidden="true"
        >
          <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
        </span>
      </button>

      {expanded && (
        <div className="space-y-4">
          <input
            type="search"
            placeholder="Filter glossary + ADRs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded border border-border bg-transparent px-3 py-1.5 text-label text-foreground placeholder:text-muted-foreground focus:border-border"
          />

          {filteredTerms.length > 0 && (
            <div>
              <SectionHeading>Glossary</SectionHeading>
              <div className="flex flex-wrap gap-1.5">
                {filteredTerms.map((t) => (
                  <span
                    key={t.term}
                    title={t.definition}
                    className="rounded border border-border px-2 py-0.5 text-label text-foreground hover:border-border hover:text-foreground"
                  >
                    {t.term}
                  </span>
                ))}
              </div>
            </div>
          )}

          {filteredAdrs.length > 0 && (
            <div>
              <SectionHeading>Decisions (ADRs)</SectionHeading>
              <ul className="space-y-0.5">
                {filteredAdrs.map((adr) => (
                  <li key={adr.slug} className="flex items-baseline gap-2">
                    <span className="w-10 shrink-0 font-mono text-micro text-muted-foreground">
                      {String(adr.number).padStart(4, '0')}
                    </span>
                    <span className="text-label text-foreground">{adr.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {filteredTerms.length === 0 && filteredAdrs.length === 0 && (
            <p className="text-label text-muted-foreground">
              {q ? 'No matches.' : 'No glossary terms or ADRs found.'}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Section 7 — Steward, in one line
// ---------------------------------------------------------------------------

/**
 * What the Steward has been doing, as a sentence. Not the Steward page.
 *
 * This section used to re-render StewardPage's two main components in place —
 * it imported `CapRatchet` from StewardPage and mounted `StewardLedgerPanel`
 * whole — under the heading "Steward history", beside a "Full view →" link
 * back to the page they came from. Roughly 600px of chart plus an unbounded
 * Recipe/Version/Rationale/Outcome log, on a page whose own subtitle promises
 * "levers, gates and engine health".
 *
 * The two copies had also drifted into different vocabularies for one object:
 * Control Room said `ui: typecheck — failed 5d ago` where Steward said
 * `Scope: ui → typecheck → Active → Last failed on 4 Sep 2026, 20:20`. Two
 * name shapes, two status words, relative against absolute time. Nothing was
 * wrong in either, but a reader could not tell which surface was
 * authoritative — which is what made the app read as assembled rather than
 * designed.
 *
 * So Control Room states the outcome and hands over. The chart, the ledger
 * and the acknowledgment log live on #/steward, once.
 */
const StewardSummarySection = () => {
  const { data } = useStewardView()

  // The heading and the link render unconditionally. Returning null while the
  // fetch is in flight made the whole section appear late and shift every
  // section above it, and it took the only route to #/steward with it.
  const paired = (data?.runtimeTuning.acks ?? []).filter((a) => a.pair !== null)
  const bumps = paired.filter((a) => a.pair!.to > a.pair!.from).length
  const sheds = paired.filter((a) => a.pair!.to < a.pair!.from).length
  const levels = paired.flatMap((a) => [a.pair!.from, a.pair!.to])
  const lo = levels.length > 0 ? Math.min(...levels) : null
  const hi = levels.length > 0 ? Math.max(...levels) : null

  return (
    <section data-testid="steward-summary-section">
      <div className="mb-3 flex items-center justify-between">
        <SectionLabel>Steward</SectionLabel>
        <ActionLink href="#/steward" variant="ghost" size="sm">
          <ArrowRight size={12} strokeWidth={2} aria-hidden="true" />
          Open Steward
        </ActionLink>
      </div>
      <p className="text-label text-muted-foreground" data-testid="steward-summary-line">
        {data === undefined
          ? 'Reading the Steward…'
          : paired.length === 0
            ? 'The Steward has not adjusted concurrency yet.'
            : `${bumps} bump${bumps === 1 ? '' : 's'}, ${sheds} shed${sheds === 1 ? '' : 's'}` +
              (lo !== null && hi !== null && lo !== hi
                ? `, holding between ${lo} and ${hi} workers.`
                : '.')}
        {data !== undefined && (
          <span className="text-foreground"> Cap is {data.runtimeTuning.liveCap} now.</span>
        )}
      </p>
    </section>
  )
}


// ---------------------------------------------------------------------------
// Page root
// ---------------------------------------------------------------------------

export const ControlRoomPage = () => (
  <main className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-background" data-testid="control-page">
    <PageHeader
      title="Control Room"
      subtitle="Levers, gates and engine health for this repo"
      className="sticky top-0 z-10"
    />
    <div className="flex flex-col gap-8 p-6">
    <LeversSection />
    <GatesSection />
    <NowSection />
    <EngineSection />
    <AdvisorySection />
    <RulesSection />
    <StewardSummarySection />
    </div>
  </main>
)
