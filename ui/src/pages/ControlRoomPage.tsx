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

import { useState, useMemo } from 'react'
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
import { SectionLabel } from '@/widgets/primitives/DensityPrimitives'
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
import { StewardLedgerPanel } from '@/widgets/StewardLedgerPanel'
import { useStewardView } from './useStewardView'
import { CapRatchet } from './StewardPage'
import { useHotPaths } from '@/hooks/useHotPaths'
import type { HotPathEntry } from '@/shared/schemas'

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
      body: 'Dispatch paused. In-flight tasks unaffected.',
      button: 'Pause dispatch',
    },
    'dispatch-on': {
      title: 'Resume dispatch?',
      body: 'Queued tasks will dispatch. Storm-breaker flag cleared.',
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
                  {dispatch.since ? ` · since ${relativeTime(dispatch.since)}` : ''}
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
                        <>{' '}<span className="text-muted-foreground/40">in {gate.scope}</span></>
                      )}
                    </p>
                    {/* Show last pass when gate is currently passing */}
                    {!failing && gate.lastPassAt !== null && (
                      <p className="mt-0.5 font-mono text-micro text-success/60" data-testid="gate-last-pass">
                        Last passed: <span title={formatAbsoluteDateTime(gate.lastPassAt)}>{relativeTime(gate.lastPassAt)}</span>
                      </p>
                    )}
                    {/* Show last failure as secondary detail when passing, or primary when failing */}
                    {gate.lastFailureAt !== null && (
                      <p className={`mt-0.5 font-mono text-micro ${failing ? 'text-error/60' : 'text-muted-foreground/40'}`} data-testid="gate-last-failure">
                        Last failure: <span title={formatAbsoluteDateTime(gate.lastFailureAt)}>{relativeTime(gate.lastFailureAt)}</span>
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
        <div className="mb-3"><SectionLabel>Engine</SectionLabel></div>
        <div className="mars-card rounded border border-warn/30 bg-warn/5 px-4 py-3">
          <p className="font-mono text-body font-medium text-warn">
            {driftItem.title ?? 'Engine update available'}
          </p>
          {driftItem.body && (
            <p className="mt-1 font-mono text-micro text-muted-foreground">
              {driftItem.body}
            </p>
          )}
          {runningCount > 0 && (
            <p
              className="mt-2 font-mono text-micro text-muted-foreground/70"
              data-testid="engine-running-count"
            >
              {runningCount} task{runningCount !== 1 ? 's are' : ' is'} currently running — will be
              stopped and re-queued on restart.
            </p>
          )}
          {timedOut && (
            <p
              className="mt-2 font-mono text-label text-error"
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
            <p className="mt-2 font-mono text-label text-error" data-testid="engine-restart-error">
              {restartError}
            </p>
          )}
          <div className="mt-3">
            <button
              onClick={handleRestartClick}
              disabled={restarting}
              className="rounded-md border border-warn/50 bg-warn/10 px-3 py-1.5 font-mono text-label text-warn hover:bg-warn/20 disabled:opacity-50 transition-colors"
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
            <DialogTitle className="font-mono text-title">Restart engine?</DialogTitle>
            <DialogDescription
              className="font-mono text-body text-foreground/70"
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
              <li className="font-mono text-micro text-muted-foreground/60">
                … and {runningTasks.length - 5} more
              </li>
            )}
          </ul>
          {restartError && (
            <p className="font-mono text-label text-error">{restartError}</p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <button className="rounded border border-border px-3 py-1.5 font-mono text-label text-foreground/70 hover:border-border/80">
                Cancel
              </button>
            </DialogClose>
            <button
              onClick={() => {
                void doRestart()
              }}
              disabled={restarting}
              className="rounded border border-warn/50 bg-warn/10 px-3 py-1.5 font-mono text-label text-warn hover:bg-warn/20 disabled:opacity-50"
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
// Section 5 — Advisory Digest (section numbering offset by new EngineSection)
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
// Section 7 — Steward history
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
// Section 8 — HOT PATH (circle-packing churn visualisation)
// ---------------------------------------------------------------------------

const HOT_PATH_WINDOWS = ['30d', '90d', 'all'] as const
type HotPathWindow = (typeof HOT_PATH_WINDOWS)[number]

/** SVG viewport dimensions for the circle-packing diagram. */
const HP_W = 560
const HP_H = 300
/** Minimum circle radius — prevents single-commit files from being invisible. */
const HP_MIN_R = 5
/**
 * Maximum number of leaf circles rendered in the SVG. The top-60 cap keeps
 * first-paint bounded (the data cap from the API is also 60).
 */
const HP_MAX_LEAVES = 60

/**
 * Map a recency value 0→1 (oldest→newest) to an HSL fill colour.
 *
 * Uses a single-hue orange ramp. Saturation encodes recency so the meaning
 * survives light/dark themes; lightness is fixed at 52% so the circles read
 * against both a white and a near-black background.
 *
 * A tooltip always carries the numeric count so colour is never the sole
 * channel for data.
 */
function hotPathColor(recency: number): string {
  const s = Math.round(15 + recency * 68) // 15 % → 83 %
  return `hsl(28,${s}%,52%)`
}

interface HotPackedCircle {
  x: number
  y: number
  r: number
  path: string
  changes: number
  recency: number
}

/**
 * Greedy outward circle-packing. Circles are sorted largest-first and placed
 * at positions tangent to existing circles, choosing the one closest to the
 * centre of mass.
 *
 * Complexity: O(n² × ANGLE_STEPS) — comfortably fast for n ≤ 60.
 */
function packHotCircles(entries: HotPathEntry[], maxEntries: number): HotPackedCircle[] {
  const capped = entries.slice(0, maxEntries)
  if (capped.length === 0) return []

  // Compute recency: normalise lastChangedAt timestamps to [0, 1]
  const dates = capped.map((e) =>
    e.lastChangedAt ? new Date(e.lastChangedAt).getTime() : 0,
  )
  const validDates = dates.filter((d) => d > 0)
  const minDate = validDates.length > 0 ? Math.min(...validDates) : 0
  const maxDate = validDates.length > 0 ? Math.max(...validDates) : 1
  const dateRange = maxDate - minDate || 1

  // Scale: r ∝ sqrt(changes) so area ∝ changes.
  // Target ~55 % of the SVG rectangle.
  const totalChanges = capped.reduce((s, e) => s + e.changes, 0)
  const usableArea = HP_W * HP_H * 0.55
  const areaScale = usableArea / totalChanges

  const circles: HotPackedCircle[] = []

  const STEP = Math.PI / 24 // 48 candidate angles per existing circle

  for (const entry of capped) {
    const r = Math.max(HP_MIN_R, Math.sqrt(entry.changes * areaScale))
    const ts = entry.lastChangedAt ? new Date(entry.lastChangedAt).getTime() : minDate
    const recency = maxDate === minDate ? 1 : (ts - minDate) / dateRange

    const circle: HotPackedCircle = {
      x: 0,
      y: 0,
      r,
      path: entry.path,
      changes: entry.changes,
      recency,
    }

    if (circles.length === 0) {
      circles.push(circle)
      continue
    }

    // Default fallback: place to the right of the first circle.
    let bestX = circles[0].x + circles[0].r + r
    let bestY = 0
    let bestDist = bestX * bestX + bestY * bestY

    for (const c of circles) {
      const d = c.r + r
      for (let angle = 0; angle < 2 * Math.PI; angle += STEP) {
        const x = c.x + d * Math.cos(angle)
        const y = c.y + d * Math.sin(angle)

        const overlaps = circles.some((o) => {
          const dx = x - o.x
          const dy = y - o.y
          return dx * dx + dy * dy < (o.r + r - 0.5) ** 2
        })

        if (!overlaps) {
          const dist = x * x + y * y
          if (dist < bestDist) {
            bestDist = dist
            bestX = x
            bestY = y
          }
        }
      }
    }

    circle.x = bestX
    circle.y = bestY
    circles.push(circle)
  }

  // Translate so the pack is centred in the SVG viewport.
  const xs = circles.flatMap((c) => [c.x - c.r, c.x + c.r])
  const ys = circles.flatMap((c) => [c.y - c.r, c.y + c.r])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const offsetX = (HP_W - (maxX - minX)) / 2 - minX
  const offsetY = (HP_H - (maxY - minY)) / 2 - minY

  return circles.map((c) => ({ ...c, x: c.x + offsetX, y: c.y + offsetY }))
}

/** Shorten a file path to just the filename for circle labels. */
function leafLabel(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

const HotPathSection = () => {
  const [win, setWin] = useState<HotPathWindow>('90d')
  const { data, isLoading, error } = useHotPaths({ window: win, group: 'file' })
  const [tooltip, setTooltip] = useState<{
    path: string
    changes: number
    x: number
    y: number
  } | null>(null)
  const [copiedPath, setCopiedPath] = useState<string | null>(null)

  const circles = useMemo(
    () => packHotCircles(data?.paths ?? [], HP_MAX_LEAVES),
    [data],
  )

  const top10 = data?.paths.slice(0, 10) ?? []

  const toggleBtn = (active: boolean): string =>
    [
      'px-2 py-0.5 font-mono text-label rounded border transition-colors',
      active
        ? 'border-highlight bg-highlight/10 text-foreground'
        : 'border-border text-muted-foreground hover:text-foreground hover:border-highlight/40',
    ].join(' ')

  const handleCircleClick = (path: string): void => {
    navigator.clipboard.writeText(path).catch(() => {})
    setCopiedPath(path)
    setTimeout(() => setCopiedPath((p) => (p === path ? null : p)), 1500)
  }

  const windowLabel = win === 'all' ? 'all time' : win

  return (
    <section data-testid="hot-path-section">
      {/* Header row */}
      <div className="mb-3 flex items-center justify-between">
        <SectionLabel>Hot path</SectionLabel>
        <div className="flex items-center gap-2">
          {HOT_PATH_WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              data-testid={`hot-path-window-${w}`}
              className={toggleBtn(w === win)}
              onClick={() => setWin(w)}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      {error ? (
        <div className="font-mono text-label text-destructive">
          Failed to load hot paths.
        </div>
      ) : isLoading || !data ? (
        <div className="font-mono text-label text-muted-foreground">Loading…</div>
      ) : data.paths.length === 0 ? (
        <div
          data-testid="hot-path-empty"
          className="font-mono text-label text-muted-foreground"
        >
          No changes found in {windowLabel}.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* ── Circle-packing diagram ───────────────────────────────────── */}
          <div className="relative overflow-hidden rounded bg-surface">
            <svg
              width={HP_W}
              height={HP_H}
              viewBox={`0 0 ${HP_W} ${HP_H}`}
              aria-label="Hot path churn diagram"
              role="img"
              style={{ display: 'block', width: '100%', height: 'auto' }}
            >
              <title>
                Hot path churn — circle area proportional to commit count, colour encodes
                recency (darker orange = more recently changed)
              </title>
              <desc>
                Packed circles where each circle represents a file. Circle area is proportional
                to the number of commits that touched the file. Colour encodes recency: darker
                orange means the file was changed more recently; lighter beige-orange means
                it was last touched longer ago. Hover for the full path and count. Click to
                copy the path to the clipboard.
              </desc>

              {circles.map((c) => (
                <g
                  key={c.path}
                  style={{ cursor: 'pointer' }}
                  role="button"
                  tabIndex={0}
                  aria-label={`${c.path}: ${c.changes} commits — click to copy path`}
                  onClick={() => handleCircleClick(c.path)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') handleCircleClick(c.path)
                  }}
                  onMouseEnter={() =>
                    setTooltip({ path: c.path, changes: c.changes, x: c.x, y: c.y })
                  }
                  onMouseLeave={() =>
                    setTooltip((t) => (t?.path === c.path ? null : t))
                  }
                >
                  <circle
                    cx={c.x.toFixed(1)}
                    cy={c.y.toFixed(1)}
                    r={c.r.toFixed(1)}
                    fill={hotPathColor(c.recency)}
                    fillOpacity={0.88}
                    stroke="var(--color-background, white)"
                    strokeWidth={1}
                  />
                  {/* Label only when the circle is large enough to fit text */}
                  {c.r > 20 && (
                    <text
                      x={c.x.toFixed(1)}
                      y={(c.y + 4).toFixed(1)}
                      textAnchor="middle"
                      fontSize={Math.min(11, c.r * 0.38)}
                      fill="white"
                      style={{ pointerEvents: 'none', fontFamily: 'monospace', fontWeight: 500 }}
                    >
                      {leafLabel(c.path)}
                    </text>
                  )}
                  {/* Transient "copied" badge */}
                  {copiedPath === c.path && (
                    <text
                      x={c.x.toFixed(1)}
                      y={(c.y - c.r - 5).toFixed(1)}
                      textAnchor="middle"
                      fontSize={9}
                      fill="currentColor"
                      fillOpacity={0.7}
                      style={{ pointerEvents: 'none', fontFamily: 'monospace' }}
                    >
                      copied
                    </text>
                  )}
                </g>
              ))}

              {/* SVG tooltip on hover */}
              {tooltip && (() => {
                const tx = Math.min(tooltip.x + 10, HP_W - 200)
                const ty = Math.max(tooltip.y - 36, 4)
                const shortTooltipPath =
                  tooltip.path.length > 40
                    ? `…${tooltip.path.slice(-39)}`
                    : tooltip.path
                return (
                  <g style={{ pointerEvents: 'none' }}>
                    <rect
                      x={tx}
                      y={ty}
                      width={190}
                      height={40}
                      rx={4}
                      fill="var(--color-surface, #111)"
                      fillOpacity={0.95}
                      stroke="var(--color-border, #444)"
                      strokeWidth={1}
                    />
                    <text
                      x={tx + 8}
                      y={ty + 16}
                      fontSize={10}
                      fill="currentColor"
                      style={{ fontFamily: 'monospace' }}
                    >
                      {shortTooltipPath}
                    </text>
                    <text
                      x={tx + 8}
                      y={ty + 30}
                      fontSize={10}
                      fill="currentColor"
                      fillOpacity={0.55}
                      style={{ fontFamily: 'monospace' }}
                    >
                      {tooltip.changes} commits
                    </text>
                  </g>
                )
              })()}
            </svg>
          </div>

          {/* ── Top-10 text list ─────────────────────────────────────────── */}
          <div data-testid="hot-path-top10">
            <div className="mb-1 font-mono text-micro uppercase tracking-widest text-muted-foreground">
              Top files by commit count
            </div>
            <ol className="flex flex-col gap-0.5">
              {top10.map((entry, i) => (
                <li
                  key={entry.path}
                  className="flex items-center gap-2 font-mono text-label"
                >
                  <span className="w-5 shrink-0 text-right text-muted-foreground tabular-nums">
                    {i + 1}.
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-foreground"
                    title={entry.path}
                  >
                    {entry.path}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {entry.changes}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Page root
// ---------------------------------------------------------------------------

export const ControlRoomPage = () => (
  <main className="flex h-full min-h-0 flex-1 flex-col gap-8 overflow-y-auto bg-background p-6" data-testid="control-page">
    <h1 className="font-mono text-title font-semibold text-foreground">Control Room</h1>
    <LeversSection />
    <GatesSection />
    <NowSection />
    <EngineSection />
    <AdvisorySection />
    <RulesSection />
    <StewardHistorySection />
    <HotPathSection />
  </main>
)
