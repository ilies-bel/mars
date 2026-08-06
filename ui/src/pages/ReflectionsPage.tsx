/**
 * ReflectionsPage — list and detail view for arc reflection reports.
 *
 * Arc reflections are the most expensive analysis the product performs.
 * Each report contains:
 *   - a summary and root cause at the top (headline, not buried)
 *   - dissonant calls ordered by severity (high before low)
 *   - verify mismatches and thrashing patterns
 *   - tool-call statistics as a compact breakdown
 *   - suggestions that were filed as proposals (linked to the proposal drawer)
 *
 * The page states when reflection last ran and what would trigger the next run,
 * so the surface is honest about whether anything feeds it.
 *
 * Reachable at #/reflections (list) and #/reflections/<originId> (detail).
 * Renders on cold load — no click or SSE event required.
 */

import { useQuery } from '@tanstack/react-query'
import { fetchDeepReflections, fetchDeepReflection } from '@/shared/api'
import type {
  DeepReflectionSummary,
  DeepReflectionDetail,
  DeepReflectionsListResponse,
  ReflectionDissonantCall,
} from '@/shared/api'
import { useFocusedProject } from '@/shared/useFocusedProject'
import { FallbackSurface } from '@/components/FallbackSurface'
import { parseReflectionDetailRoute, reflectionDetailHash, proposalHash } from '@/shared/routing'
import { useHashRoute } from '@/shared/useHashRoute'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fmt = (iso: string): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

const fmtRelative = (iso: string | null): string => {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const diffMs = Date.now() - d.getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 2) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}

/** Sort dissonant calls: high → medium → low → other. */
const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 }
const sortBySeverity = (calls: ReflectionDissonantCall[]): ReflectionDissonantCall[] =>
  [...calls].sort((a, b) => {
    const ao = SEVERITY_ORDER[a.severity] ?? 3
    const bo = SEVERITY_ORDER[b.severity] ?? 3
    return ao - bo
  })

const severityClass = (severity: string): string => {
  if (severity === 'high') return 'text-error'
  if (severity === 'medium') return 'text-warn'
  return 'text-muted-foreground'
}

const severityLabel = (severity: string): string =>
  severity.charAt(0).toUpperCase() + severity.slice(1)

// ---------------------------------------------------------------------------
// RunState banner — when did reflection last run, what triggers the next?
// ---------------------------------------------------------------------------

interface RunStateBannerProps {
  autoReflect: 'on' | 'off'
  autoTrigger: boolean
  lastReflectedAt: string | null
}

const RunStateBanner = ({ autoReflect, autoTrigger, lastReflectedAt }: RunStateBannerProps) => {
  const lastRan = lastReflectedAt ? `Last reflection: ${fmt(lastReflectedAt)} (${fmtRelative(lastReflectedAt)})` : 'No reflection has run yet.'
  const triggerDesc =
    autoReflect === 'off'
      ? 'auto-reflect is OFF — reflection will not run automatically. Run manually with `mars arc reflect <originId>`.'
      : autoTrigger
        ? 'auto-reflect is ON and auto-trigger is ON — reflection runs automatically after each arc.'
        : 'auto-reflect is ON but auto-trigger is OFF — reflection must be triggered manually with `mars arc reflect <originId>`.'

  return (
    <div
      data-testid="run-state-banner"
      className="border border-primary/20 bg-card p-3 font-mono text-[11px]"
    >
      <span className="text-muted-foreground">{lastRan}</span>
      {' · '}
      <span className={autoReflect === 'on' && autoTrigger ? 'text-success' : 'text-warn'}>
        {triggerDesc}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

interface ReflectionRowProps {
  report: DeepReflectionSummary
}

const statusClass = (status: string): string => {
  if (status === 'complete') return 'text-success'
  if (status === 'pending') return 'text-warn'
  return 'text-error'
}

const ReflectionRow = ({ report }: ReflectionRowProps) => (
  <a
    href={reflectionDetailHash(report.originId)}
    data-testid={`reflection-row-${report.originId}`}
    className="flex flex-col gap-1 border border-primary/20 bg-card p-3 hover:border-primary/50 hover:bg-card/80 transition-colors"
  >
    <div className="flex items-center gap-2">
      <span className="font-mono text-[11px] text-foreground truncate flex-1">
        {report.originId}
      </span>
      <span className={`font-mono text-[10px] uppercase ${statusClass(report.status)}`}>
        {report.status}
      </span>
    </div>
    <div className="flex items-center gap-4 font-mono text-[10px] text-muted-foreground">
      <span>{fmt(report.recordedAt)}</span>
      {report.dissonantCallCount > 0 && (
        <span className="text-error">{report.dissonantCallCount} dissonant</span>
      )}
      {report.verifyMismatchCount > 0 && (
        <span className="text-warn">{report.verifyMismatchCount} verify mismatch{report.verifyMismatchCount !== 1 ? 'es' : ''}</span>
      )}
      {report.thrashingPatternCount > 0 && (
        <span>{report.thrashingPatternCount} thrashing</span>
      )}
      <span>{report.totalToolCalls.toLocaleString()} tool calls</span>
      {report.verdictResult.saved > 0 && (
        <span className="text-primary">{report.verdictResult.saved} saved</span>
      )}
    </div>
  </a>
)

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

interface DissonantCallCardProps {
  call: ReflectionDissonantCall
  index: number
}

const DissonantCallCard = ({ call, index }: DissonantCallCardProps) => (
  <div
    data-testid={`dissonant-call-${index}`}
    className="border border-primary/20 bg-card p-3 font-mono text-[11px]"
  >
    <div className="flex items-center gap-2 mb-1">
      <span className={`uppercase font-semibold ${severityClass(call.severity)}`}>
        {severityLabel(call.severity)}
      </span>
      <span className="text-muted-foreground">·</span>
      <span className="text-primary">{call.tool}</span>
      {call.taskId && (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">task {call.taskId} · event #{call.eventIndex}</span>
        </>
      )}
    </div>
    <div className="grid grid-cols-2 gap-2 mt-2">
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Stated intent</div>
        <div className="text-foreground">{call.statedIntent}</div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Actual outcome</div>
        <div className="text-foreground">{call.actualOutcome}</div>
      </div>
    </div>
    {call.evidence && (
      <div className="mt-2 text-[10px] text-muted-foreground border-t border-primary/10 pt-2">
        <span className="uppercase tracking-wide">Evidence:</span>{' '}
        {call.evidence}
      </div>
    )}
  </div>
)

interface ReflectionDetailViewProps {
  detail: DeepReflectionDetail
}

const ReflectionDetailView = ({ detail }: ReflectionDetailViewProps) => {
  const sortedCalls = detail.report ? sortBySeverity(detail.report.dissonantCalls) : []
  const byNameEntries: Array<[string, number]> = detail.report
    ? (Object.entries(detail.report.toolCallStats.byName) as Array<[string, number]>)
        .sort(([, a], [, b]) => b - a)
    : []

  const savedSuggestions = detail.report?.suggestions.filter(
    (s) => s.verdict === 'save' && s.targetId,
  ) ?? []

  return (
    <div className="flex flex-col gap-4">
      {/* Header: run state */}
      <RunStateBanner
        autoReflect={detail.autoReflect}
        autoTrigger={detail.autoTrigger}
        lastReflectedAt={detail.recordedAt}
      />

      {/* Origin and metadata */}
      <div className="border border-primary/20 bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Arc</div>
            <div className="font-mono text-[12px] text-foreground break-all">{detail.originId}</div>
          </div>
          <div className="text-right shrink-0">
            <div className={`font-mono text-[11px] uppercase font-semibold ${statusClass(detail.status)}`}>
              {detail.status}
            </div>
            <div className="font-mono text-[10px] text-muted-foreground">{fmt(detail.recordedAt)}</div>
          </div>
        </div>
        {detail.status !== 'complete' && (
          <div
            data-testid="non-complete-notice"
            className="mt-3 border border-warn/30 bg-warn/5 p-2 font-mono text-[11px] text-warn"
          >
            This report has status <strong>{detail.status}</strong> — the full report body is not yet available.
          </div>
        )}
      </div>

      {detail.report !== null ? (
        <>
          {/* Summary + root cause — the headline, not buried */}
          <section>
            <h3 className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
              Summary
            </h3>
            <p className="font-mono text-[12px] text-foreground leading-relaxed border border-primary/20 bg-card p-3">
              {detail.report.summary}
            </p>
          </section>

          <section>
            <h3 className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
              Root Cause
            </h3>
            <p className="font-mono text-[11px] text-primary border border-primary/30 bg-primary/5 p-3 leading-relaxed">
              {detail.report.rootCause}
            </p>
          </section>

          {/* Dissonant calls — ordered by severity, intent vs outcome side-by-side */}
          {sortedCalls.length > 0 && (
            <section>
              <h3 className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
                Dissonant Calls ({sortedCalls.length})
              </h3>
              <div className="flex flex-col gap-2">
                {sortedCalls.map((call, i) => (
                  <DissonantCallCard key={i} call={call} index={i} />
                ))}
              </div>
            </section>
          )}

          {/* Verify mismatches */}
          {detail.report.verifyMismatches.length > 0 && (
            <section>
              <h3 className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
                Verify Mismatches ({detail.report.verifyMismatches.length})
              </h3>
              <div className="flex flex-col gap-2">
                {detail.report.verifyMismatches.map((mm, i) => (
                  <div
                    key={i}
                    data-testid={`verify-mismatch-${i}`}
                    className="border border-warn/30 bg-warn/5 p-3 font-mono text-[11px]"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`uppercase font-semibold ${severityClass(mm.severity)}`}>
                        {severityLabel(mm.severity)}
                      </span>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground">task {mm.taskId}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-1">
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Claimed</div>
                        <div className="text-foreground">{mm.claimed}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Actual</div>
                        <div className="text-foreground">{mm.actual}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Thrashing patterns */}
          {detail.report.thrashingPatterns.length > 0 && (
            <section>
              <h3 className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
                Thrashing Patterns ({detail.report.thrashingPatterns.length})
              </h3>
              <div className="flex flex-col gap-2">
                {detail.report.thrashingPatterns.map((p, i) => (
                  <div
                    key={i}
                    data-testid={`thrashing-pattern-${i}`}
                    className="border border-primary/20 bg-card p-3 font-mono text-[11px]"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-foreground">{p.pattern}</span>
                      <span className="text-muted-foreground shrink-0">× {p.occurrences}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground">{p.evidence}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Tool call statistics — compact breakdown, not a raw object dump */}
          <section>
            <h3 className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
              Tool Calls ({detail.report.toolCallStats.total.toLocaleString()} total)
            </h3>
            <div className="flex flex-wrap gap-2">
              {byNameEntries.map(([tool, count]) => (
                <div
                  key={tool}
                  className="border border-primary/20 bg-card px-2 py-1 font-mono text-[11px]"
                >
                  <span className="text-primary">{tool}</span>
                  <span className="text-muted-foreground"> {count}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Filed proposals — link arc → proposals */}
          {savedSuggestions.length > 0 && (
            <section>
              <h3 className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
                Proposals Filed ({savedSuggestions.length})
              </h3>
              <div className="flex flex-col gap-1">
                {savedSuggestions.map((s, i) => (
                  <a
                    key={i}
                    href={proposalHash(s.targetId!, 'reflections')}
                    data-testid={`filed-proposal-${i}`}
                    className="flex items-center gap-2 border border-primary/20 bg-card p-2 hover:border-primary/50 transition-colors font-mono text-[11px]"
                  >
                    <span className="text-primary flex-1">{s.title}</span>
                    <span className="text-muted-foreground text-[10px]">→ proposal {s.targetId}</span>
                  </a>
                ))}
              </div>
            </section>
          )}
        </>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const useDeepReflections = (projectId: string | null): {
  data: DeepReflectionsListResponse | undefined
  isLoading: boolean
  error: Error | null
} => {
  // Option (a) fallback: fire without project when registry is empty.
  const query = useQuery({
    queryKey: ['deep-reflections', projectId],
    queryFn: () => fetchDeepReflections(projectId ?? undefined),
    // Always enabled — renders on cold load, no click or SSE required.
    enabled: true,
  })
  return { data: query.data, isLoading: query.isLoading, error: query.error as Error | null }
}

const useDeepReflection = (originId: string | null, projectId: string | null): {
  data: DeepReflectionDetail | undefined
  isLoading: boolean
  error: Error | null
} => {
  const query = useQuery({
    queryKey: ['deep-reflection', originId, projectId],
    queryFn: () => fetchDeepReflection(originId!, projectId ?? undefined),
    enabled: originId !== null,
  })
  return { data: query.data, isLoading: query.isLoading, error: query.error as Error | null }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Reflection page — list view at #/reflections, detail view at
 * #/reflections/<originId>.
 *
 * The list loads on cold render with no user interaction required.
 */
export const ReflectionsPage = () => {
  const hash = useHashRoute()
  const { focusedProjectId: projectId, projectsSettled, projectsError, projects } = useFocusedProject()
  // Fire without ?project= when the registry is empty (no multi-project setup).
  const projectsEmpty = projectsSettled && projectsError === null && projects.length === 0
  const resolvedProjectId = projectId ?? (projectsEmpty ? undefined : null)

  const originId = parseReflectionDetailRoute(hash)
  const isDetail = originId !== null

  const { data: listData, isLoading: listLoading, error: listError } = useDeepReflections(resolvedProjectId ?? null)
  const { data: detailData, isLoading: detailLoading, error: detailError } = useDeepReflection(
    isDetail ? originId : null,
    resolvedProjectId ?? null,
  )

  if (listError) {
    return <FallbackSurface error={listError} of="reflections" variant="pane" />
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {isDetail ? (
          // ── Detail view ──
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <a
                href="#/reflections"
                className="font-mono text-[11px] text-primary hover:text-foreground"
              >
                ← Reflections
              </a>
            </div>

            {detailError ? (
              <FallbackSurface error={detailError} of="reflection detail" variant="inline" />
            ) : detailLoading || detailData === undefined ? (
              <div className="font-mono text-[11px] text-muted-foreground" data-testid="detail-loading">
                Loading…
              </div>
            ) : (
              <ReflectionDetailView detail={detailData} />
            )}
          </div>
        ) : (
          // ── List view ──
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="font-mono text-[11px] uppercase tracking-wide text-primary">
                Reflections
              </h2>
              {listData && (
                <span className="font-mono text-[10px] text-muted-foreground">
                  {listData.reports.length} report{listData.reports.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            {listData && (
              <RunStateBanner
                autoReflect={listData.autoReflect}
                autoTrigger={listData.autoTrigger}
                lastReflectedAt={listData.lastReflectedAt}
              />
            )}

            {listLoading && listData === undefined ? (
              <div className="font-mono text-[11px] text-muted-foreground" data-testid="list-loading">
                Loading…
              </div>
            ) : listData?.reports.length === 0 ? (
              <div
                data-testid="empty-state"
                className="font-mono text-[11px] text-muted-foreground border border-primary/20 bg-card p-4 text-center"
              >
                No reflection reports yet. Run <code>mars arc reflect {'<originId>'}</code> to generate one.
              </div>
            ) : (
              <div className="flex flex-col gap-2" data-testid="reflection-list">
                {(listData?.reports ?? []).map((report) => (
                  <ReflectionRow key={report.originId} report={report} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
