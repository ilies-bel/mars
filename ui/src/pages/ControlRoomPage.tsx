/**
 * ControlRoomPage — operator levers first, reference data below.
 *
 * Sections (top → bottom):
 *   1. Levers — dispatch pause/resume, recovery kill-switch, and concurrency
 *      caps. All controls show a confirm dialog before firing.
 *   2. Now — SSE liveness dot + task counts by lifecycle cluster.
 *   3. Advisory Digest — collapsed advisory action-queue items.
 *   4. Rules & Language — glossary chips and ADR list, collapsed by default
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
  postOperatorDispatch,
  postOperatorRecovery,
  type OperatorState,
} from '@/shared/api'
import { useProgress } from '@/hooks/useProgress'
import { useStatusCounts } from '@/hooks/useStatusCounts'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { useDispatchState, pauseReasonLabel } from '@/entities/operator/useDispatchState'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { ActionQueueItem } from '@/shared/schemas'
import { PageHeader, SectionLabel } from '@/widgets/primitives/DensityPrimitives'
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

        <div className="space-y-4">
          {/* Dispatch lever */}
          <div className="flex items-start justify-between gap-4 rounded border border-primary/20 px-3 py-3">
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
                    'rounded px-1.5 py-0.5 font-mono text-micro uppercase tracking-wide',
                    isDispatchPaused
                      ? 'bg-warn/15 text-warn'
                      : 'bg-success/15 text-success',
                  ].join(' ')}
                >
                  {isDispatchPaused ? 'paused' : 'running'}
                </span>
              </div>
              {isDispatchPaused && dispatch.reason && (
                <p className="mt-1 font-mono text-micro text-foreground/50">
                  Reason: {pauseReasonLabel(dispatch)}
                  {dispatch.since ? ` · since ${new Date(dispatch.since).toLocaleTimeString()}` : ''}
                </p>
              )}
            </div>
            <button
              onClick={() =>
                openConfirm(isDispatchPaused ? { kind: 'dispatch-on' } : { kind: 'dispatch-off' })
              }
              className={[
                'shrink-0 rounded border px-3 py-1.5 font-mono text-label transition-colors',
                isDispatchPaused
                  ? 'border-success/40 text-success hover:border-success/80 hover:text-success/80'
                  : 'border-primary/30 text-primary hover:border-primary/60 hover:text-foreground',
              ].join(' ')}
            >
              {isDispatchPaused ? 'Resume' : 'Pause'}
            </button>
          </div>

          {/* Recovery lever */}
          <div className="flex items-start justify-between gap-4 rounded border border-primary/20 px-3 py-3">
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
                    'rounded px-1.5 py-0.5 font-mono text-micro uppercase tracking-wide',
                    controlLevers.recovery === 'off'
                      ? 'bg-error/15 text-error'
                      : 'bg-success/15 text-success',
                  ].join(' ')}
                >
                  {controlLevers.recovery}
                </span>
              </div>
              <p className="mt-1 font-mono text-micro text-foreground/50">
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
              className={[
                'shrink-0 rounded border px-3 py-1.5 font-mono text-label transition-colors',
                controlLevers.recovery === 'off'
                  ? 'border-success/40 text-success hover:border-success/80 hover:text-success/80'
                  : 'border-error/40 text-error hover:border-error/80 hover:text-error/80',
              ].join(' ')}
            >
              {controlLevers.recovery === 'off' ? 'Enable' : 'Disable'}
            </button>
          </div>

          {/* Caps — read-only */}
          <div className="rounded border border-primary/20 px-3 py-3">
            <div className="mb-2">
              <span className="font-mono text-micro uppercase tracking-wide text-primary/50">
                Concurrency caps
              </span>
            </div>
            <div className="grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-5">
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
                  <button className="rounded border border-primary/30 px-3 py-1.5 font-mono text-label text-foreground/70 hover:border-primary/60">
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
  <div className="flex flex-col">
    <span className="font-mono text-base leading-none tabular-nums text-foreground">
      {value}
    </span>
    <span className="mt-0.5 font-mono text-micro uppercase tracking-wide text-primary/50">
      {label}
    </span>
  </div>
)

// ---------------------------------------------------------------------------
// Section 2 — Now (dispatch state + task counts)
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

      <div className="mb-3 flex items-center gap-2">
        <span
          className={[
            'h-2 w-2 rounded-full',
            dispatch.paused ? 'bg-warn' : connected ? 'bg-success' : 'bg-primary/30',
          ].join(' ')}
          aria-hidden="true"
        />
        <span className="font-mono text-label text-foreground/70">
          {dispatch.paused
            ? `⏸ Paused · ${pauseReasonLabel(dispatch)}`
            : connected
              ? 'Live'
              : 'Connecting…'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Stat label="Queued" value={queued} />
        <Stat label="In progress" value={inProgress} />
        <Stat label="Blocked" value={blocked} />
        <Stat label="Failed" value={failed} highlight={failed > 0} />
        <Stat label="Done today" value={doneToday} />
      </div>
    </section>
  )
}

interface StatProps {
  label: string
  value: number
  highlight?: boolean
}

const Stat = ({ label, value, highlight }: StatProps) => (
  <div className="flex flex-col">
    <span
      className={[
        'font-mono text-lg leading-none tabular-nums',
        highlight ? 'text-error' : 'text-foreground',
      ].join(' ')}
    >
      {value}
    </span>
    <span className="mt-0.5 font-mono text-micro uppercase tracking-wide text-primary/50">
      {label}
    </span>
  </div>
)

// ---------------------------------------------------------------------------
// Section 3 — Advisory Digest
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

      <div className="mb-4 flex gap-3">
        <a
          href="#/steward"
          className="rounded border border-primary/30 px-3 py-1.5 font-mono text-label text-primary hover:border-primary/60 hover:text-foreground"
        >
          → Steward ledgers
        </a>
        <a
          href="#/reflections"
          className="rounded border border-primary/30 px-3 py-1.5 font-mono text-label text-primary hover:border-primary/60 hover:text-foreground"
        >
          → Deep reflections
        </a>
      </div>

      {advisories.length === 0 ? (
        <p className="font-mono text-label text-primary/40">No pending advisories.</p>
      ) : (
        <ul className="space-y-2">
          {advisories.map((item) => (
            <li
              key={item.id}
              className="rounded border border-primary/20 px-3 py-2"
            >
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-micro uppercase tracking-wide text-primary/60">
                  {ADVISORY_LABELS[item.kind] ?? item.kind}
                </span>
                <span className="font-mono text-label text-foreground/80">{item.title}</span>
              </div>
              {item.body && (
                <p className="mt-1 font-mono text-label text-foreground/50 leading-snug">
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
// Section 4 — Rules & Language (collapsed, searchable)
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
      <div className="mb-3 flex items-center justify-between">
        <SectionLabel>Rules &amp; Language</SectionLabel>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="font-mono text-micro text-primary/50 hover:text-primary"
          aria-expanded={expanded}
        >
          {expanded ? '▲ collapse' : '▼ expand'}
        </button>
      </div>

      {expanded && (
        <div className="space-y-4">
          <input
            type="search"
            placeholder="Filter glossary + ADRs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded border border-primary/20 bg-transparent px-3 py-1.5 font-mono text-label text-foreground placeholder:text-primary/30 focus:border-primary/50 focus:outline-none"
          />

          {filteredTerms.length > 0 && (
            <div>
              <div className="mb-2"><SectionLabel>Glossary</SectionLabel></div>
              <div className="flex flex-wrap gap-1.5">
                {filteredTerms.map((t) => (
                  <span
                    key={t.term}
                    title={t.definition}
                    className="rounded border border-primary/20 px-2 py-0.5 font-mono text-label text-foreground/80 hover:border-primary/50 hover:text-foreground"
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
                    <span className="w-10 shrink-0 font-mono text-micro text-primary/40">
                      {String(adr.number).padStart(4, '0')}
                    </span>
                    <span className="font-mono text-label text-foreground/70">{adr.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {filteredTerms.length === 0 && filteredAdrs.length === 0 && (
            <p className="font-mono text-label text-primary/40">
              {q ? 'No matches.' : 'No glossary terms or ADRs found.'}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Page root
// ---------------------------------------------------------------------------

export const ControlRoomPage = () => (
  <main className="flex h-full min-h-0 flex-1 flex-col gap-8 overflow-y-auto bg-background p-6">
    <PageHeader title="Control Room" />
    <LeversSection />
    <NowSection />
    <AdvisorySection />
    <RulesSection />
  </main>
)
