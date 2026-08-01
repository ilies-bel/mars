import { useState, useCallback } from 'react'
import type { KpiKey, KpiArc } from '@/shared/schemas'
import { FallbackSurface } from '@/components/FallbackSurface'
import { SkeletonList } from '@/components/Skeleton'
import { useKpis } from '@/entities/kpi/useKpis'
import { useKpiArcs } from '@/entities/kpi/useKpiArcs'
import { kpiBand, kpiBandCue } from '@/entities/kpi/bands'
import { kpiDriftDirection } from '@/entities/kpi/types'
import { formatKpiValue, KPI_DESCRIPTIONS } from '@/widgets/KpiTile'
import { Sparkline } from '@/widgets/Sparkline'
import { taskHash } from '@/shared/routing'

const KPI_LABELS: Record<KpiKey, string> = {
  cost_per_arc: 'Cost per Arc',
  failure_rate: 'Failure Rate',
  autonomous_completion_rate: 'Autonomous Completion',
  recovery_success_rate: 'Recovery Success',
}


// ---------------------------------------------------------------------------
// Diagnostic analysis
// ---------------------------------------------------------------------------

interface DiagnosticFinding {
  label: string
  detail: string
  severity: 'info' | 'warn' | 'action'
}

interface DiagnosticReport {
  summary: string
  findings: DiagnosticFinding[]
  runAt: string
}

type DiagnosticState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; report: DiagnosticReport }
  | { status: 'error'; message: string }

function runDiagnostic(key: KpiKey, arcs: KpiArc[], currentValue: number): DiagnosticReport {
  const findings: DiagnosticFinding[] = []
  const total = arcs.length
  const failed = arcs.filter((a) => !a.passed)
  const passed = arcs.filter((a) => a.passed)

  if (key === 'failure_rate') {
    findings.push({
      label: `${failed.length} of ${total} arcs failed`,
      detail: `Failure rate: ${(currentValue * 100).toFixed(1)}%. ${passed.length} arcs completed successfully.`,
      severity: failed.length === 0 ? 'info' : 'warn',
    })
    if (failed.length > 0) {
      const titleWords = new Map<string, number>()
      failed.forEach((a) => {
        const words = (a.title || '').toLowerCase().split(/\s+/).filter((w) => w.length > 4)
        words.forEach((w) => titleWords.set(w, (titleWords.get(w) ?? 0) + 1))
      })
      const common = [...titleWords.entries()]
        .filter(([, c]) => c >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
      if (common.length > 0) {
        findings.push({
          label: 'Recurring patterns in failed arcs',
          detail: common.map(([w, c]) => `"${w}" appears in ${c} failures`).join('. '),
          severity: 'action',
        })
      }
    }
    if (failed.length > 0) {
      findings.push({
        label: 'Recommended action',
        detail: 'Review the failed arcs below. Check if failures share a common verify command or merge mode. Tighten prompts with explicit file paths and done-criteria.',
        severity: 'action',
      })
    }
  } else if (key === 'autonomous_completion_rate') {
    const nonAutonomous = failed.length
    findings.push({
      label: `${nonAutonomous} of ${total} arcs required intervention`,
      detail: `Autonomous rate: ${(currentValue * 100).toFixed(1)}%. These arcs needed recovery tasks or manual unblocking.`,
      severity: nonAutonomous > total * 0.3 ? 'warn' : 'info',
    })
    if (nonAutonomous > 0) {
      findings.push({
        label: 'Recommended action',
        detail: 'Check if blocked tasks had correct blockers set. Ensure the coder emits --blocked-by follow-ups instead of bailing. Review recovery task prompts for clarity.',
        severity: 'action',
      })
    }
  } else if (key === 'recovery_success_rate') {
    findings.push({
      label: `${passed.length} of ${total} recoveries succeeded`,
      detail: `Recovery success: ${(currentValue * 100).toFixed(1)}%. Failed recoveries indicate the fix task couldn't resolve the original failure.`,
      severity: failed.length > total * 0.2 ? 'warn' : 'info',
    })
    if (failed.length > 0) {
      findings.push({
        label: 'Recommended action',
        detail: 'Check if failed recoveries share the same failure signature as the origin. Consider marking non-recoverable failures (quota, auth) to skip recovery attempts.',
        severity: 'action',
      })
    }
  } else if (key === 'cost_per_arc') {
    const costs = arcs.map((a) => a.costTokens ?? 0).filter((c) => c > 0).sort((a, b) => a - b)
    if (costs.length > 0) {
      const p50 = costs[Math.floor(costs.length * 0.5)]
      const p90 = costs[Math.floor(costs.length * 0.9)]
      const max = costs[costs.length - 1]
      findings.push({
        label: 'Cost distribution',
        detail: `p50: ${formatKpiValue('cost_per_arc', p50)}, p90: ${formatKpiValue('cost_per_arc', p90)}, max: ${formatKpiValue('cost_per_arc', max)}`,
        severity: p90 > 150_000 ? 'warn' : 'info',
      })
      const expensive = arcs.filter((a) => (a.costTokens ?? 0) > 150_000)
      if (expensive.length > 0) {
        findings.push({
          label: `${expensive.length} arcs exceed 150k tokens`,
          detail: 'These arcs are driving up the median. Check for context bloat, missing cache utilisation, or overly broad verify sweeps.',
          severity: 'action',
        })
      }
    }
    findings.push({
      label: 'Recommended action',
      detail: 'Use --files in task prompts to scope reads. Enable prompt caching by keeping system prompt stable. Break large arcs into smaller tasks.',
      severity: 'action',
    })
  }

  return {
    summary: `Analyzed ${total} arcs in the 7-day window.`,
    findings,
    runAt: new Date().toISOString(),
  }
}

type ArcFilter = 'all' | 'pass' | 'fail'

interface KpiDetailPageProps {
  kpiKey: KpiKey
}

export const KpiDetailPage = ({ kpiKey }: KpiDetailPageProps) => {
  const { data: kpis, isLoading: kpisLoading, error: kpisError } = useKpis()
  const { arcs, isLoading: arcsLoading, error: arcsError } = useKpiArcs(kpiKey)
  const [arcFilter, setArcFilter] = useState<ArcFilter>('all')
  const [diagnostic, setDiagnostic] = useState<DiagnosticState>({ status: 'idle' })

  const kpi = kpis?.find((k) => k.key === kpiKey)
  const label = KPI_LABELS[kpiKey]

  const isLoading = kpisLoading || arcsLoading
  const error = kpisError ?? arcsError

  const band = kpi && !kpi.lowConfidence ? kpiBand(kpiKey, kpi.currentValue) : null
  const cue = band ? kpiBandCue(band) : null
  const drift = kpi && !kpi.lowConfidence ? kpiDriftDirection(kpi) : null

  const onRunDiagnostic = useCallback(() => {
    if (diagnostic.status === 'running') return
    if (!kpi || kpi.lowConfidence) return
    setDiagnostic({ status: 'running' })
    setTimeout(() => {
      try {
        const report = runDiagnostic(kpiKey, arcs, kpi.currentValue)
        setDiagnostic({ status: 'done', report })
      } catch {
        setDiagnostic({ status: 'error', message: 'Diagnostic failed unexpectedly.' })
      }
    }, 600)
  }, [kpiKey, arcs, kpi, diagnostic.status])

  const filteredArcs =
    arcFilter === 'all' || kpiKey === 'cost_per_arc'
      ? arcs
      : arcs.filter((a) => (arcFilter === 'pass') === a.passed)

  const arcRowClass = (passed: boolean): string => {
    if (kpiKey === 'cost_per_arc') return 'border-b border-primary/10 hover:bg-primary/5'
    return passed
      ? 'border-b border-success/20 bg-success/[0.03] hover:bg-success/[0.06]'
      : 'border-b border-error/20 bg-error/[0.03] hover:bg-error/[0.06]'
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {/* KPI summary card — min-h reserves space while kpi data loads */}
        <div className="mb-4 min-h-[110px]">
          {kpi && !kpi.lowConfidence && cue ? (
            <div className="flex flex-col gap-2 rounded border border-primary/20 bg-card p-4">
              <div className="flex flex-wrap items-baseline gap-4">
                <span className="font-mono text-3xl font-bold text-foreground">
                  {formatKpiValue(kpiKey, kpi.currentValue)}
                </span>
                <span className={`flex items-center gap-1 text-sm ${cue.colorClass}`}>
                  <span aria-hidden="true">{cue.glyph}</span>
                  <span>{cue.label}</span>
                </span>
                {drift && drift !== 'flat' && (
                  <span
                    className={`flex items-center gap-1 text-sm ${
                      drift === 'improved' ? 'text-success' : 'text-error'
                    }`}
                  >
                    <span aria-hidden="true">{drift === 'improved' ? '↑' : '↓'}</span>
                    <span>{drift === 'improved' ? 'Improved' : 'Regressed'}</span>
                    <span className="text-muted-foreground">
                      ({kpi.delta >= 0 ? '+' : ''}
                      {kpiKey === 'cost_per_arc'
                        ? formatKpiValue(kpiKey, kpi.delta)
                        : `${(kpi.delta * 100).toFixed(1)}pp`}
                      )
                    </span>
                  </span>
                )}
                <span className="ml-auto text-xs text-muted-foreground">
                  {kpi.sampleCount} sample{kpi.sampleCount !== 1 ? 's' : ''}
                </span>
              </div>
              <Sparkline points={(kpi.series ?? []).map((p) => p.value)} width={240} height={32} />
            </div>
          ) : kpi?.lowConfidence ? (
            <div className="rounded border border-primary/20 bg-card p-4 text-sm text-muted-foreground">
              {label}: insufficient samples
            </div>
          ) : null}
        </div>

        {/* Description */}
        <p className="mb-4 font-mono text-[11px] text-muted-foreground">
          {KPI_DESCRIPTIONS[kpiKey]}
        </p>

        {/* Diagnostic action */}
        <div className="mb-6 rounded border border-primary/20 bg-card">
          <div className="flex items-center justify-between px-4 py-2.5">
            <span className="font-mono text-[11px] uppercase tracking-wide text-primary">
              Diagnostic
            </span>
            <button
              type="button"
              disabled={diagnostic.status === 'running' || arcsLoading || arcs.length === 0}
              onClick={onRunDiagnostic}
              className="rounded border border-primary/40 px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-foreground transition-colors hover:bg-primary/15 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {diagnostic.status === 'running'
                ? 'Analyzing…'
                : diagnostic.status === 'done'
                  ? 'Re-run diagnostic'
                  : 'Run diagnostic'}
            </button>
          </div>
          {diagnostic.status === 'done' && (
            <div className="border-t border-primary/20 px-4 py-3">
              <p className="mb-3 font-mono text-[11px] text-muted-foreground">
                {diagnostic.report.summary}
              </p>
              <div className="flex flex-col gap-2">
                {diagnostic.report.findings.map((f, i) => (
                  <div
                    key={i}
                    className={`rounded border px-3 py-2 ${
                      f.severity === 'action'
                        ? 'border-warn/30 bg-warn/[0.04]'
                        : f.severity === 'warn'
                          ? 'border-error/30 bg-error/[0.04]'
                          : 'border-primary/20 bg-primary/[0.03]'
                    }`}
                  >
                    <p className={`font-mono text-[11px] font-semibold ${
                      f.severity === 'action' ? 'text-warn' : f.severity === 'warn' ? 'text-error' : 'text-foreground'
                    }`}>
                      {f.severity === 'action' ? '→ ' : ''}{f.label}
                    </p>
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                      {f.detail}
                    </p>
                  </div>
                ))}
              </div>
              <p className="mt-2 font-mono text-[9px] text-muted-foreground">
                Run at {new Date(diagnostic.report.runAt).toLocaleTimeString()}
              </p>
            </div>
          )}
          {diagnostic.status === 'error' && (
            <div className="border-t border-primary/20 px-4 py-2">
              <p className="font-mono text-[10px] text-error">{diagnostic.message}</p>
            </div>
          )}
        </div>

        {/* Arc list */}
        <div>
          <div className="mb-3 flex items-center gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {kpiKey === 'cost_per_arc' ? 'Arcs (by cost)' : 'Arcs'}
            </h2>
            {kpiKey !== 'cost_per_arc' && (
              <div className="ml-auto flex gap-1">
                {(['all', 'pass', 'fail'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setArcFilter(f)}
                    className={[
                      'rounded px-2 py-0.5 font-mono text-[10px] uppercase transition-colors',
                      arcFilter === f
                        ? 'bg-primary/30 text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    ].join(' ')}
                  >
                    {f}
                  </button>
                ))}
              </div>
            )}
          </div>

          {isLoading && (
            <SkeletonList rows={6} rowClassName="h-8 w-full mb-0.5" label="Loading arcs" />
          )}

          {error && !isLoading && (
            <FallbackSurface error={error} of="arcs" variant="inline" />
          )}

          {!isLoading && !error && filteredArcs.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {arcs.length === 0
                ? 'No arcs in this window.'
                : 'No arcs match this filter.'}
            </p>
          )}

          {!isLoading && filteredArcs.length > 0 && (
            <div className="flex flex-col gap-0.5" role="list">
              {/* Header */}
              <div className="flex items-center border-b border-primary/20 pb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                <span className="w-16 shrink-0">Status</span>
                <span className="w-24 shrink-0">
                  {kpiKey === 'cost_per_arc' ? 'Cost' : 'Result'}
                </span>
                <span className="min-w-0 flex-1">Arc</span>
              </div>
              {/* Rows — each fully clickable */}
              {filteredArcs.map((arc) => (
                <a
                  key={arc.arcId}
                  href={taskHash(arc.originTaskId, 'kpi', undefined, kpiKey)}
                  role="listitem"
                  title={arc.arcId}
                  data-testid={`arc-row-${arc.arcId}`}
                  className={`flex items-center rounded px-1 py-1.5 font-mono text-sm no-underline transition-colors cursor-pointer ${arcRowClass(arc.passed)}`}
                >
                  <span className="w-16 shrink-0 text-muted-foreground">{arc.status}</span>
                  {kpiKey === 'cost_per_arc' ? (
                    <span className="w-24 shrink-0 text-foreground">
                      {arc.costTokens !== undefined
                        ? formatKpiValue('cost_per_arc', arc.costTokens)
                        : '—'}
                    </span>
                  ) : (
                    <span className="w-24 shrink-0">
                      <span className={arc.passed ? 'text-success' : 'text-error'}>
                        {arc.passed ? '✓ PASS' : '✗ FAIL'}
                      </span>
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {arc.title || arc.arcId}
                  </span>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
