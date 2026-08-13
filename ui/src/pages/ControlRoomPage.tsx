/**
 * ControlRoomPage — operator overview: project language, live dispatch state,
 * and a collapsed advisory digest.
 *
 * Three sections:
 *   1. Rules & Language — glossary terms (compact chips) + ADR list (linked).
 *   2. Now — one-line dispatch state (paused/running + reason) and task counts
 *      by lifecycle cluster from the progress aggregates.
 *   3. Advisory Digest — collapsed pull-based list of advisory action-queue
 *      kinds (reflect-recommended, scorer-suggested, gate-enrichment) with
 *      entry links into the steward ledgers and deep-reflection reports.
 *
 * Steward and Reflections remain fully functional pages — this page demotes
 * them from the top-level nav by surfacing their entry points here.
 *
 * Reachable at #/control.
 */

import { useQuery } from '@tanstack/react-query'
import { fetchGlossary, fetchAdrs } from '@/shared/api'
import { useProgress } from '@/hooks/useProgress'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { ActionQueueItem } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Advisory kinds shown in the digest (not in the main alert queue)
// ---------------------------------------------------------------------------

const ADVISORY_KINDS = new Set(['reflect-recommended', 'scorer-suggested', 'gate-enrichment'])

const isAdvisory = (item: ActionQueueItem): boolean => ADVISORY_KINDS.has(item.kind)

// ---------------------------------------------------------------------------
// Small layout helpers
// ---------------------------------------------------------------------------

const SectionHeader = ({ children }: { children: React.ReactNode }) => (
  <h2 className="mb-3 font-mono text-[11px] uppercase tracking-widest text-primary/70">
    {children}
  </h2>
)

// ---------------------------------------------------------------------------
// Section 1 — Rules & Language
// ---------------------------------------------------------------------------

const RulesSection = () => {
  const { focusedProjectId: projectId } = useFocusedProject()

  const { data: terms = [] } = useQuery({
    queryKey: ['glossary'],
    queryFn: fetchGlossary,
  })

  const { data: adrs = [] } = useQuery({
    queryKey: ['adrs', projectId],
    queryFn: () => fetchAdrs(projectId ?? undefined),
  })

  return (
    <section>
      <SectionHeader>Rules &amp; Language</SectionHeader>

      {terms.length > 0 && (
        <div className="mb-4">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-wide text-primary/50">
            Glossary
          </p>
          <div className="flex flex-wrap gap-1.5">
            {terms.map((t) => (
              <span
                key={t.term}
                title={t.definition}
                className="rounded border border-primary/20 px-2 py-0.5 font-mono text-[11px] text-foreground/80 hover:border-primary/50 hover:text-foreground"
              >
                {t.term}
              </span>
            ))}
          </div>
        </div>
      )}

      {adrs.length > 0 && (
        <div>
          <p className="mb-2 font-mono text-[10px] uppercase tracking-wide text-primary/50">
            Decisions (ADRs)
          </p>
          <ul className="space-y-0.5">
            {adrs.map((adr) => (
              <li key={adr.slug} className="flex items-baseline gap-2">
                <span className="w-10 shrink-0 font-mono text-[10px] text-primary/40">
                  {String(adr.number).padStart(4, '0')}
                </span>
                <span className="font-mono text-[11px] text-foreground/70">{adr.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {terms.length === 0 && adrs.length === 0 && (
        <p className="font-mono text-[11px] text-primary/40">
          No glossary terms or ADRs found.
        </p>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Section 2 — Now (dispatch state + task counts)
// ---------------------------------------------------------------------------

const NowSection = () => {
  const { tasks, aggregates, connected } = useProgress()

  const queued = tasks?.filter((t) => t.cluster === 'Queued').length ?? 0
  const inProgress = tasks?.filter((t) => t.cluster === 'In progress').length ?? 0
  const blocked = tasks?.filter((t) => t.cluster === 'Blocked').length ?? 0
  const failed = aggregates.failedOpen
  const doneToday = aggregates.doneToday

  return (
    <section>
      <SectionHeader>Now</SectionHeader>

      <div className="mb-3 flex items-center gap-2">
        <span
          className={[
            'h-2 w-2 rounded-full',
            connected ? 'bg-green-500' : 'bg-primary/30',
          ].join(' ')}
          aria-hidden="true"
        />
        <span className="font-mono text-[11px] text-foreground/70">
          {connected ? 'Live' : 'Connecting…'}
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
        highlight ? 'text-red-400' : 'text-foreground',
      ].join(' ')}
    >
      {value}
    </span>
    <span className="mt-0.5 font-mono text-[10px] uppercase tracking-wide text-primary/50">
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
      <SectionHeader>Advisory Digest</SectionHeader>

      <div className="mb-4 flex gap-3">
        <a
          href="#/steward"
          className="rounded border border-primary/30 px-3 py-1.5 font-mono text-[11px] text-primary hover:border-primary/60 hover:text-foreground"
        >
          → Steward ledgers
        </a>
        <a
          href="#/reflections"
          className="rounded border border-primary/30 px-3 py-1.5 font-mono text-[11px] text-primary hover:border-primary/60 hover:text-foreground"
        >
          → Deep reflections
        </a>
      </div>

      {advisories.length === 0 ? (
        <p className="font-mono text-[11px] text-primary/40">No pending advisories.</p>
      ) : (
        <ul className="space-y-2">
          {advisories.map((item) => (
            <li
              key={item.id}
              className="rounded border border-primary/20 px-3 py-2"
            >
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-primary/60">
                  {ADVISORY_LABELS[item.kind] ?? item.kind}
                </span>
                <span className="font-mono text-[11px] text-foreground/80">{item.title}</span>
              </div>
              {item.body && (
                <p className="mt-1 font-mono text-[11px] text-foreground/50 leading-snug">
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
// Page root
// ---------------------------------------------------------------------------

export const ControlRoomPage = () => (
  <main className="flex h-full min-h-0 flex-1 flex-col gap-8 overflow-y-auto bg-background p-6">
    <RulesSection />
    <NowSection />
    <AdvisorySection />
  </main>
)
