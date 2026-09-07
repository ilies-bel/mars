/**
 * ControlRoomPage — operator levers first, reference data below.
 *
 * Sections (top → bottom):
 *   1. Levers — dispatch pause/resume, recovery kill-switch, and concurrency
 *      caps. All controls show a confirm dialog before firing.
 *   2. Gates — verify-gate registry: name, tier, command, last failure, and a
 *      Restore button for quarantined gates. Empty state links to detect command.
 *   3. Now — SSE liveness dot + task counts by lifecycle cluster.
 *   4. Advisory Digest — collapsed advisory action-queue items.
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
import { SectionLabel } from '@/widgets/primitives/DensityPrimitives'
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
import { StewardLedgerPanel } from '@/widgets/StewardLedgerPanel'
import { useStewardView } from './useStewardView'
import { CapRatchet } from './StewardPage'

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

const CONFIRM_COPY: Record<ConfirmAction['kind'], { title: string; body: string; button: string }> =
  {
    'dispatch-off': {
      title: 'Pause dispatch?',
      body: 'No new tasks will be dispatched. In-flight tasks continue to completion. Resume at any time.',
      button: 'Pause dispatch',
    },
    'dispatch-on': {
      title: 'Resume dispatch?',
      body: 'Queued tasks will start dispatching again. Any storm-breaker flag is cleared.',
      button: 'Resume dispatch',
    },
    'recovery-off': {
      title: 'Disable recovery?',
      body: 'The orchestrator will stop spawning fix tasks when a worker fails. Failed tasks will accumulate until recovery is re-enabled.',
      button: 'Disable recovery',
    },
    'recovery-on': {
      title: 'Enable recovery?',
      body: 'The orchestrator will resume spawning fix tasks when a worker fails.',
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
        <div className="mb-3"><SectionLabel>Levers</SectionLabel></div>
        <SkeletonList rows={2} rowClassName="h-16 w-full mb-3" label="Loading levers" />
      </section>
    )
  }

  if (isError || !state) {
    return (
      <section>
        <div className="mb-3"><SectionLabel>Levers</SectionLabel></div>
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
        <div className="mb-4"><SectionLabel>Levers</SectionLabel></div>

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
                <span className="font-mono text-body font-medium text-foreground">
                  Dispatch
                </span>
                <span
                  className={[
                    'rounded-full px-2 py-0.5 font-mono text-micro font-medium uppercase tracking-wide',
                    isDispatchPaused
                      ? 'bg-warn/10 text-warn'
                      : 'bg-success/10 text-success',
                  ].join(' ')}
                >
                  {isDispatchPaused ? 'paused' : 'running'}
                </span>
              </div>
              {isDispatchPaused && dispatch.reason && (
                <p className="mt-1 font-mono text-micro text-muted-foreground/70">
                  Reason: {pauseReasonLabel(dispatch)}
                  {dispatch.since ? ` · since ${new Date(dispatch.since).toLocaleTimeString()}` : ''}
                </p>
              )}
            </div>
            <button
              onClick={() =>
                openConfirm(isDispatchPaused ? { kind: 'dispatch-on' } : { kind: 'dispatch-off' })
              }
              className="shrink-0 rounded-md border border-border px-3 py-1.5 font-mono text-label text-foreground hover:bg-surface transition-colors"
            >
              {isDispatchPaused ? 'Resume' : 'Pause'}
            </button>
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
                <span className="font-mono text-body font-medium text-foreground">
                  Recovery
                </span>
                <span
                  className={[
                    'rounded-full px-2 py-0.5 font-mono text-micro font-medium uppercase tracking-wide',
                    controlLevers.recovery === 'off'
                      ? 'bg-error/10 text-error'
                      : 'bg-success/10 text-success',
                  ].join(' ')}
                >
                  {controlLevers.recovery}
                </span>
              </div>
              <p className="mt-1 font-mono text-micro text-muted-foreground/70">
                {controlLevers.recovery === 'off'
                  ? 'Fix-task spawning disabled — failures will accumulate.'
                  : 'Fix tasks spawn automatically on worker failure.'}
              </p>
            </div>
            <button
              onClick={() =>
                openConfirm(
                  controlLevers.recovery === 'off'
                    ? { kind: 'recovery-on' }
                    : { kind: 'recovery-off' },
                )
              }
              className="shrink-0 rounded-md border border-border px-3 py-1.5 font-mono text-label text-foreground hover:bg-surface transition-colors"
            >
              {controlLevers.recovery === 'off' ? 'Enable' : 'Disable'}
            </button>
          </div>

          {/* Caps — read-only */}
          <div className="mars-card rounded bg-surface px-4 py-3">
            <div className="mb-3">
              <span className="font-mono text-micro uppercase tracking-widest text-muted-foreground">
                Concurrency caps
              </span>
            </div>
            <div className="grid grid-cols-5 gap-4">
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
                <DialogTitle className="font-mono text-title">{copy.title}</DialogTitle>
                <DialogDescription className="font-mono text-body text-foreground/70">
                  {copy.body}
                </DialogDescription>
              </DialogHeader>
              {actError && (
                <p className="font-mono text-label text-error">{actError}</p>
              )}
              <DialogFooter>
                <DialogClose asChild>
                  <button className="rounded border border-border px-3 py-1.5 font-mono text-label text-foreground/70 hover:border-border/80">
                    Cancel
                  </button>
                </DialogClose>
                <button
                  onClick={() => { void confirm() }}
                  disabled={acting}
                  className="rounded border border-primary/50 bg-primary/10 px-3 py-1.5 font-mono text-label text-foreground hover:bg-primary/20 disabled:opacity-50"
                >
                  {acting ? 'Working…' : copy.button}
                </button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

const CapStat = ({ label, value }: { label: string; value: number }) => (
  <div className="flex flex-col items-center gap-1">
    <span className="font-mono text-title font-semibold leading-none tabular-nums text-foreground">
      {value}
    </span>
    <span className="font-mono text-micro uppercase tracking-widest text-muted-foreground text-center">
      {label}
    </span>
  </div>
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
    body: 'The gate will become active again and run on all future verifications.',
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
        <div className="mb-3"><SectionLabel>Gates</SectionLabel></div>
        <SkeletonList rows={2} rowClassName="h-10 w-full mb-2" label="Loading gates" />
      </section>
    )
  }

  if (isError || !gatesData) {
    return (
      <section data-testid="gates-section">
        <div className="mb-3"><SectionLabel>Gates</SectionLabel></div>
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

  // Required gates that are quarantined — merges are proceeding without them.
  const quarantinedRequired = gatesData.filter(
    (g) => g.state === 'quarantined' && g.required,
  )

  const copy = pending ? GATE_ACTION_COPY[pending.kind] : null

  return (
    <>
      <section data-testid="gates-section">
        <div className="mb-3"><SectionLabel>Gates</SectionLabel></div>

        {quarantinedRequired.length > 0 && (
          <div
            className="mb-3 rounded border border-error/30 bg-error/5 px-4 py-3"
            data-testid="quarantine-banner"
          >
            <p className="font-mono text-label font-medium text-error">
              ⚠ {quarantinedRequired.length} required gate{quarantinedRequired.length !== 1 ? 's are' : ' is'} quarantined — merges are proceeding unchecked
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
          <p className="font-mono text-label text-muted-foreground/50">
            No gates yet — run <code className="font-mono text-micro bg-surface px-1 rounded">mars verify-gate detect</code>
          </p>
        ) : (
          <ul className="space-y-2">
            {gatesData.map((gate) => {
              const failing = isCurrentlyFailing(gate)
              const gateDisplayName = gate.scope !== '.' ? `${gate.scope}: ${gate.name}` : gate.name
              return (
                <li
                  key={gate.id}
                  className="mars-card flex items-start justify-between gap-3 rounded bg-surface px-4 py-3"
                  data-testid={`gate-row-${gate.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-body font-medium text-foreground">
                        {gateDisplayName}
                      </span>
                      {/* Current run status badge */}
                      {gate.lastPassAt !== null || gate.lastFailureAt !== null ? (
                        <span
                          className={[
                            'shrink-0 rounded-full px-2 py-0.5 font-mono text-micro font-medium uppercase tracking-wide',
                            failing
                              ? 'bg-error/10 text-error'
                              : 'bg-success/10 text-success',
                          ].join(' ')}
                          data-testid={failing ? 'gate-status-failing' : 'gate-status-passing'}
                        >
                          {failing ? 'failing' : 'passing'}
                        </span>
                      ) : null}
                      <span
                        className={[
                          'shrink-0 rounded-full px-2 py-0.5 font-mono text-micro font-medium uppercase tracking-wide',
                          gate.tier === 'integration'
                            ? 'bg-primary/10 text-primary/70'
                            : 'bg-surface-elevated text-muted-foreground',
                        ].join(' ')}
                      >
                        {gate.tier}
                      </span>
                      {!gate.required && (
                        <span className="shrink-0 rounded-full px-2 py-0.5 font-mono text-micro font-medium uppercase tracking-wide bg-warn/10 text-warn">
                          advisory
                        </span>
                      )}
                      {gate.state === 'quarantined' && (
                        <span className="shrink-0 rounded-full px-2 py-0.5 font-mono text-micro font-medium uppercase tracking-wide bg-error/10 text-error">
                          quarantined
                        </span>
                      )}
                    </div>
                    <p className="mt-1 font-mono text-micro text-muted-foreground/70">
                      <span className="font-mono">{[gate.cmd, ...gate.args].join(' ')}</span>
                      {gate.scope !== '.' && (
                        <span className="ml-2 text-muted-foreground/40">in {gate.scope}</span>
                      )}
                    </p>
                    {/* Show last pass when gate is currently passing */}
                    {!failing && gate.lastPassAt !== null && (
                      <p className="mt-0.5 font-mono text-micro text-success/60" data-testid="gate-last-pass">
                        Last passed: {new Date(gate.lastPassAt).toLocaleString()}
                      </p>
                    )}
                    {/* Show last failure as secondary detail when passing, or primary when failing */}
                    {gate.lastFailureAt !== null && (
                      <p className={`mt-0.5 font-mono text-micro ${failing ? 'text-error/60' : 'text-muted-foreground/40'}`} data-testid="gate-last-failure">
                        Last failure: {new Date(gate.lastFailureAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col gap-1.5">
                    {gate.state === 'quarantined' ? (
                      <button
                        onClick={() => { openDialog('restore', gate) }}
                        className="rounded-md border border-border px-3 py-1.5 font-mono text-label text-foreground hover:bg-surface transition-colors"
                        data-testid="gate-restore-btn"
                      >
                        Restore
                      </button>
                    ) : (
                      <button
                        onClick={() => { openDialog('quarantine', gate) }}
                        className="rounded-md border border-warn/40 px-3 py-1.5 font-mono text-label text-warn hover:bg-warn/5 transition-colors"
                        data-testid="gate-quarantine-btn"
                      >
                        Quarantine
                      </button>
                    )}
                    <button
                      onClick={() => { openDialog('retire', gate) }}
                      className="rounded-md border border-error/30 px-3 py-1.5 font-mono text-label text-error/70 hover:bg-error/5 transition-colors"
                      data-testid="gate-retire-btn"
                    >
                      Retire
                    </button>
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
            <DialogTitle className="font-mono">{copy?.title}</DialogTitle>
            <DialogDescription className="font-mono text-label">
              {pending && (
                <span className="font-medium text-foreground">
                  {pending.gate.scope !== '.' ? `${pending.gate.scope}: ` : ''}{pending.gate.name}
                </span>
              )}
              {' — '}{copy?.body}
            </DialogDescription>
          </DialogHeader>
          {actError && (
            <p className="font-mono text-label text-error">{actError}</p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <button
                className="rounded-md border border-border px-4 py-2 font-mono text-label text-foreground hover:bg-surface transition-colors"
                disabled={acting}
              >
                Cancel
              </button>
            </DialogClose>
            <button
              onClick={() => { void handleConfirm() }}
              disabled={acting}
              className={[
                'rounded-md px-4 py-2 font-mono text-label font-medium text-white transition-colors disabled:opacity-50',
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

  return (
    <section>
      <div className="mb-3"><SectionLabel>Now</SectionLabel></div>

      <div className="mars-card rounded bg-surface px-4 py-3">
        <div className="mb-4 flex items-center gap-1.5">
          <span
            className={[
              'h-1.5 w-1.5 rounded-full',
              dispatch.paused ? 'bg-warn' : connected ? 'bg-success' : 'bg-primary/30',
            ].join(' ')}
            aria-hidden="true"
          />
          <span className="font-mono text-micro text-muted-foreground">
            {dispatch.paused
              ? `⏸ Paused · ${pauseReasonLabel(dispatch)}`
              : connected
                ? 'Live'
                : 'Connecting…'}
          </span>
        </div>

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
          />
          <Stat
            label="Done today"
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
}

const Stat = ({ label, value, colorClass }: StatProps) => (
  <div className="flex flex-col">
    <span
      className={[
        'font-mono text-title font-semibold leading-none tabular-nums',
        colorClass ?? 'text-muted-foreground/50',
      ].join(' ')}
    >
      {value}
    </span>
    <span className="mt-0.5 font-mono text-micro uppercase tracking-widest text-muted-foreground">
      {label}
    </span>
  </div>
)

// ---------------------------------------------------------------------------
// Section 4 — Advisory Digest
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
      <div className="mb-3"><SectionLabel>Advisory Digest</SectionLabel></div>

      <div className="mb-4 flex gap-4">
        <a
          href="#/steward"
          className="font-mono text-label text-muted-foreground hover:text-foreground transition-colors"
        >
          → Steward ledgers
        </a>
        <a
          href="#/reflections"
          className="font-mono text-label text-muted-foreground hover:text-foreground transition-colors"
        >
          → Deep reflections
        </a>
      </div>

      {advisories.length === 0 ? (
        <p className="font-mono text-label text-muted-foreground/50">No pending advisories.</p>
      ) : (
        <ul className="space-y-2">
          {advisories.map((item) => (
            <li
              key={item.id}
              className="mars-card rounded bg-surface px-3 py-2"
            >
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-micro uppercase tracking-wide text-primary/60">
                  {ADVISORY_LABELS[item.kind] ?? item.kind.replace(/-/g, ' ')}
                </span>
                <span className="font-mono text-body text-foreground/80">{item.title}</span>
              </div>
              {item.body && (
                <p className="mt-1 font-mono text-label text-muted-foreground leading-snug">
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
// Section 5 — Rules & Language (collapsed, searchable)
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
        className="mb-3 flex w-full items-center justify-between"
        aria-expanded={expanded}
      >
        <SectionLabel>Rules &amp; Language</SectionLabel>
        <span
          className={[
            'font-mono text-micro text-muted-foreground transition-transform duration-200',
            expanded ? 'rotate-180' : '',
          ].join(' ')}
          aria-hidden="true"
        >
          ▾
        </span>
      </button>

      {expanded && (
        <div className="space-y-4">
          <input
            type="search"
            placeholder="Filter glossary + ADRs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded border border-border bg-transparent px-3 py-1.5 font-mono text-label text-foreground placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none"
          />

          {filteredTerms.length > 0 && (
            <div>
              <div className="mb-2"><SectionLabel>Glossary</SectionLabel></div>
              <div className="flex flex-wrap gap-1.5">
                {filteredTerms.map((t) => (
                  <span
                    key={t.term}
                    title={t.definition}
                    className="rounded border border-border px-2 py-0.5 font-mono text-label text-foreground/80 hover:border-primary/40 hover:text-foreground"
                  >
                    {t.term}
                  </span>
                ))}
              </div>
            </div>
          )}

          {filteredAdrs.length > 0 && (
            <div>
              <div className="mb-2"><SectionLabel>Decisions (ADRs)</SectionLabel></div>
              <ul className="space-y-0.5">
                {filteredAdrs.map((adr) => (
                  <li key={adr.slug} className="flex items-baseline gap-2">
                    <span className="w-10 shrink-0 font-mono text-micro text-muted-foreground/50">
                      {String(adr.number).padStart(4, '0')}
                    </span>
                    <span className="font-mono text-label text-foreground/70">{adr.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {filteredTerms.length === 0 && filteredAdrs.length === 0 && (
            <p className="font-mono text-label text-muted-foreground/50">
              {q ? 'No matches.' : 'No glossary terms or ADRs found.'}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Section 6 — Steward history
// ---------------------------------------------------------------------------

/**
 * Embeds the Steward's intervention ledger and the concurrency-cap ratchet
 * sparkline from StewardPage. The #/steward route remains navigable for the
 * full view; this section surfaces the essential history directly inside
 * Control Room so operators don't have to leave the lever panel.
 */
const StewardHistorySection = () => {
  const { data } = useStewardView()

  const ratchetEntries = data
    ? data.runtimeTuning.acks
        .filter((a) => a.pair !== null)
        .map((a) => ({
          from: a.pair!.from,
          to: a.pair!.to,
          timestamp: a.timestamp,
          text: a.text,
        }))
        .slice()
        .reverse() // oldest-first for the ratchet
    : []

  return (
    <section data-testid="steward-history-section">
      <div className="mb-3">
        <div className="flex items-center justify-between">
          <SectionLabel>Steward history</SectionLabel>
          <a
            href="#/steward"
            className="font-mono text-label text-muted-foreground hover:text-foreground transition-colors"
          >
            → Full view
          </a>
        </div>
      </div>

      {data && (
        <div className="mars-card mb-4 rounded bg-surface px-4 py-3">
          <div className="mb-1 font-mono text-micro uppercase tracking-widest text-muted-foreground">
            Concurrency cap ratchet
          </div>
          <CapRatchet
            entries={ratchetEntries}
            baseline={data.runtimeTuning.baselineCap}
            ceiling={data.runtimeTuning.ceiling}
            liveCap={data.runtimeTuning.liveCap}
          />
        </div>
      )}

      <StewardLedgerPanel />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Page root
// ---------------------------------------------------------------------------

export const ControlRoomPage = () => (
  <main className="flex h-full min-h-0 flex-1 flex-col gap-8 overflow-y-auto bg-background p-6">
    <h1 className="font-mono text-title font-semibold text-foreground">Control Room</h1>
    <LeversSection />
    <GatesSection />
    <NowSection />
    <AdvisorySection />
    <RulesSection />
    <StewardHistorySection />
  </main>
)
