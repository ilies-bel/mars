import { SelectField } from '@/components/SelectField'
import { EmptyState } from '@/components/EmptyState'
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
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useScorerWorkflows } from '@/entities/watchtower/useScorerWorkflows'
import { useLoopLedger } from '@/entities/watchtower/useLoopLedger'
import { useTasks } from '@/hooks/useTasks'
import { SkeletonList } from '@/components/Skeleton'
import { PageHeader } from '@/widgets/primitives/DensityPrimitives'
import { studioHash } from '@/shared/routing'
import { relativeTime, formatAbsoluteDateTime } from '@/shared/time'

type SortKey = 'task' | 'scored' | 'score'

/**
 * A column header that is actually a control. The previous <th> were inert
 * text with `cursor: auto` and no aria-sort, so the table announced itself as
 * static to assistive tech and offered no affordance to sighted users either.
 */
const SortHeader = ({
  label,
  col,
  sort,
  onSort,
  className,
}: {
  label: string
  col: SortKey
  sort: { key: SortKey; dir: 'asc' | 'desc' }
  onSort: (k: SortKey) => void
  className?: string
}) => {
  const active = sort.key === col
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn('pb-2 font-normal', className)}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        className={cn(
          'inline-flex items-center gap-1 eyebrow transition-colors',
          active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {label}
        {active
          ? (sort.dir === 'asc'
              ? <ArrowUp size={10} strokeWidth={2.5} aria-hidden="true" />
              : <ArrowDown size={10} strokeWidth={2.5} aria-hidden="true" />)
          : <ChevronsUpDown size={10} strokeWidth={2} aria-hidden="true" className="opacity-0 transition-opacity group-hover:opacity-100" />}
      </button>
    </th>
  )
}

/**
 * A score rendered as a value, not just a number. 0.35 and 0.85 used to be the
 * same 13px black text, so the table encoded its most important column in
 * digits alone — you had to read every row to find the bad ones.
 */
const ScoreCell = ({ score }: { score: number | null }) => {
  if (score === null) return <span className="text-muted-foreground">—</span>
  const pct = Math.max(0, Math.min(1, score)) * 100
  const tone =
    score >= 0.8 ? 'bg-success' : score >= 0.5 ? 'bg-warn' : 'bg-error'
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-foreground/8">
        <span className={cn('block h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
      </span>
      <span className="tabular-nums text-label text-foreground">{score.toFixed(2)}</span>
    </span>
  )
}

export const StudioIndexPage = () => {
  const { data: workflows } = useScorerWorkflows()

  // `selected` is the user's explicit pick; null means "use the first workflow
  // from the list" so the panel auto-populates when workflows first load.
  const [selected, setSelected] = useState<string | null>(null)
  const workflow = selected ?? workflows?.[0] ?? null

  const { entries, isLoading, error } = useLoopLedger(workflow)

  // Only show runs that have actually been scored.
  const filtered = useMemo(() => entries.filter((e) => e.score !== null), [entries])

  // A scored-runs table you cannot sort by score is a list of numbers, not a
  // ranking — the one question this page exists to answer ("which runs scored
  // badly?") required reading every row. Sorting defaults to worst-first.
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'score',
    dir: 'asc',
  })
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

  const scoredEntries = useMemo(() => {
    const rows = [...filtered]
    rows.sort((a, b) => {
      const mul = sort.dir === 'asc' ? 1 : -1
      if (sort.key === 'score') return ((a.score ?? 0) - (b.score ?? 0)) * mul
      if (sort.key === 'scored') return ((a.scoredAt ?? 0) - (b.scoredAt ?? 0)) * mul
      const at = taskTitleMap.get(a.runId) ?? a.runId
      const bt = taskTitleMap.get(b.runId) ?? b.runId
      return at.localeCompare(bt) * mul
    })
    return rows
  }, [filtered, sort, taskTitleMap])

  const toggleSort = (key: SortKey) =>
    setSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'task' ? 'asc' : 'desc' },
    )


  return (
    <div data-testid="studio-index-page" className="flex h-full flex-col overflow-hidden bg-background">
      <PageHeader title="Scores" subtitle="How recent runs were graded" />

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
          // Name what this page is for, then hand over the one move that
          // fills it. The old copy buried that move as an inline link in the
          // middle of a second paragraph.
          <EmptyState
            data-testid="studio-index-empty"
            title="No scored runs yet"
            action={
              <a
                href="#/kpi"
                className="inline-flex items-center gap-1 rounded border border-border px-3 py-1.5 text-label text-foreground hover:bg-foreground/5"
              >
                Accept a scorer on the KPI page →
              </a>
            }
          >
            This page lists runs a scorer has graded, worst first. Opening one
            shows the run's full step-execution tree — every tool call,
            intermediate output, and step result, in the order they happened —
            so a low score can be traced to the step that earned it. Nothing
            has been graded yet.
          </EmptyState>
        ) : (
          <table className="w-full text-body">
            <thead>
              <tr className="text-left">
                <SortHeader label="Task" col="task" sort={sort} onSort={toggleSort} className="pr-4" />
                <SortHeader label="Scored" col="scored" sort={sort} onSort={toggleSort} className="pr-4" />
                <SortHeader label="Score" col="score" sort={sort} onSort={toggleSort} className="w-40" />
              </tr>
            </thead>
            <tbody>
              {scoredEntries.map((entry) => {
                const title = taskTitleMap.get(entry.runId) ?? entry.runId
                return (
                  <tr
                    key={entry.runId}
                    className="border-t border-border/40 transition-colors hover:bg-foreground/[0.035]"
                  >
                    <td className="py-2 pr-4">
                      <a
                        href={studioHash(entry.runId)}
                        className="text-foreground decoration-muted-foreground decoration-1 underline-offset-2 transition-colors hover:underline"
                      >
                        {title}
                      </a>
                      {title !== entry.runId && (
                        <span
                          className="block text-label text-muted-foreground"
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
                    <td className="py-2">
                      <ScoreCell score={entry.score} />
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
