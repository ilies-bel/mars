import { SelectField } from '@/components/SelectField'
/**
 * StudioIndexPage — the Studio landing at `#/studio` (bare, no task id).
 *
 * Lists recent scored runs for the selected scorer workflow, showing the
 * task's human title (via `taskTitle`, per DEC-18), when it was scored,
 * and its score. Each row links to `#/studio/<taskId>` so the operator
 * can drill into the full step-execution tree.
 *
 * Data source: GET /api/loop-ledger — the same endpoint used by the Loop
 * Ledger panel on `#/kpi`. A workflow selector mirrors the LoopLedgerPanel
 * pattern; the first known workflow is selected by default.
 *
 * `#/studio/` (trailing slash, no id) remains an unknown route and is
 * redirected by the App before this component is ever rendered.
 */

import { useState, useMemo } from 'react'
import { useScorerWorkflows } from '@/entities/watchtower/useScorerWorkflows'
import { useLoopLedger } from '@/entities/watchtower/useLoopLedger'
import { useTasks } from '@/hooks/useTasks'
import { SkeletonList } from '@/components/Skeleton'
import { PageHeader } from '@/widgets/primitives/DensityPrimitives'
import { studioHash } from '@/shared/routing'
import { relativeTime, formatAbsoluteDateTime } from '@/shared/time'

export const StudioIndexPage = () => {
  const { data: workflows } = useScorerWorkflows()

  // `selected` is the user's explicit pick; null means "use the first workflow
  // from the list" so the panel auto-populates when workflows first load.
  const [selected, setSelected] = useState<string | null>(null)
  const workflow = selected ?? workflows?.[0] ?? null

  const { entries, isLoading, error } = useLoopLedger(workflow)

  // Only show runs that have actually been scored.
  const scoredEntries = useMemo(() => entries.filter((e) => e.score !== null), [entries])

  // Build an id→title map from the Progress snapshot. Almost always already
  // cached from the Progress tab, so this adds zero extra network requests.
  const { snapshot } = useTasks()
  const taskTitleMap = useMemo((): Map<string, string> => {
    if (!snapshot) return new Map()
    const map = new Map<string, string>()
    for (const col of Object.values(snapshot.columns)) {
      for (const t of col) {
        map.set(t.id, t.title)
      }
    }
    return map
  }, [snapshot])

  return (
    <div data-testid="studio-index-page" className="flex h-full flex-col overflow-hidden bg-background">
      <PageHeader title="Studio" subtitle="Recent scored runs" />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {/* Workflow selector — mirrors LoopLedgerPanel; hidden when no workflows known yet */}
        {(workflows ?? []).length > 0 && (
          <div className="mb-4">
            <SelectField
              value={workflow ?? ''}
              onChange={(e) => setSelected(e.target.value || null)}
              aria-label="Select workflow"
              className="rounded border border-border bg-card px-2 py-0.5 text-body"
            >
              {(workflows ?? []).map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </SelectField>
          </div>
        )}

        {isLoading ? (
          <div aria-busy="true" aria-label="Loading scored runs">
            <SkeletonList rows={5} rowClassName="h-8 w-full mb-2" label="Loading scored runs" />
          </div>
        ) : error !== null ? (
          <p role="alert" className="text-error text-body">
            Couldn't load scored runs.
          </p>
        ) : scoredEntries.length === 0 ? (
          // Empty state — name what Studio is for so operators understand the page.
          <div
            data-testid="studio-index-empty"
            className="flex flex-col gap-3 rounded border border-border p-6"
          >
            <p className="text-title font-semibold text-foreground">
              No scored runs yet
            </p>
            <p className="text-body text-muted-foreground">
              Studio shows the live step-execution tree for a task's workflow run —
              every tool call, intermediate output, and step result, in the order
              they happened. Runs appear here once a scorer has graded them.
            </p>
            <p className="text-body text-muted-foreground">
              Accept a scorer on the{' '}
              <a
                href="#/kpi"
                className="text-primary underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                KPI page
              </a>{' '}
              to start grading merged tasks. Once runs are graded they will
              appear here, with links into their execution trees.
            </p>
          </div>
        ) : (
          <table className="w-full text-body">
            <thead>
              <tr className="text-left text-micro font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                <th className="pb-2 pr-4 font-normal">Task</th>
                <th className="pb-2 pr-4 font-normal">Scored</th>
                <th className="pb-2 font-normal">Score</th>
              </tr>
            </thead>
            <tbody>
              {scoredEntries.map((entry) => {
                const title = taskTitleMap.get(entry.runId) ?? entry.runId
                return (
                  <tr key={entry.runId} className="border-t border-border/40">
                    <td className="py-2 pr-4">
                      <a
                        href={studioHash(entry.runId)}
                        className="text-foreground hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
                      >
                        {title}
                      </a>
                      {title !== entry.runId && (
                        <span
                          className="block text-micro text-muted-foreground/60"
                          title={entry.runId}
                        >
                          {entry.runId}
                        </span>
                      )}
                    </td>
                    <td
                      className="py-2 pr-4 text-muted-foreground"
                      title={entry.scoredAt !== null ? formatAbsoluteDateTime(entry.scoredAt) : undefined}
                    >
                      {entry.scoredAt !== null ? relativeTime(entry.scoredAt) : '—'}
                    </td>
                    <td className="py-2 tabular-nums">
                      {entry.score !== null ? entry.score.toFixed(2) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
