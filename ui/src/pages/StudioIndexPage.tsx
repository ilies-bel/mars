import { SelectField } from '@/components/SelectField'
import { EmptyState } from '@/components/EmptyState'
import { ScoreBar } from '@/components/ScoreBar'
/**
 * StudioIndexPage — the Scores landing at `#/scores` (bare, no task id).
 *
 * Lists recent scored runs for the selected scorer workflow, showing the
 * task's human title (via `taskTitle`, per DEC-18), when it was scored,
 * and its score. Each row links to `#/scores/<taskId>` so the operator
 * can drill into the full step-execution tree.
 *
 * Data source: GET /api/loop-ledger — the same endpoint used by the Loop
 * Ledger panel on `#/kpi` (removed — the scored runs live here now).
 * pattern; the first known workflow is selected by default.
 *
 * `#/scores/` (trailing slash, no id) remains an unknown route and is
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
import { scoresHash } from '@/shared/routing'
import { relativeTime, formatAbsoluteDateTime } from '@/shared/time'

type SortKey = 'task' | 'scored' | 'score'

/**
 * The score threshold that drives the bar's green colour.
 * Kept in one place so the header subtitle, filter label, and any
 * future gate all stay consistent with what ScoreBar renders.
 */
const THRESHOLD = 0.8

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

  // Search and below-threshold filter controls.
  const [search, setSearch] = useState('')
  const [belowOnly, setBelowOnly] = useState(false)

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

  // Apply the search query and the below-threshold filter before sorting.
  // Aggregates (count, median, belowCount) are computed from this set so they
  // always match what the table shows — no divergence between the summary line
  // and the rows the operator is actually looking at.
  const visibleEntries = useMemo(() => {
    let rows = filtered
    const q = search.trim().toLowerCase()
    if (q) {
      rows = rows.filter((e) => {
        const title = (taskTitleMap.get(e.runId) ?? e.runId).toLowerCase()
        return title.includes(q) || e.runId.toLowerCase().includes(q)
      })
    }
    if (belowOnly) {
      rows = rows.filter((e) => (e.score as number) < THRESHOLD)
    }
    return rows
  }, [filtered, search, belowOnly, taskTitleMap])

  const scoredEntries = useMemo(() => {
    const rows = [...visibleEntries]
    rows.sort((a, b) => {
      const mul = sort.dir === 'asc' ? 1 : -1
      if (sort.key === 'score') return ((a.score ?? 0) - (b.score ?? 0)) * mul
      if (sort.key === 'scored') return ((a.scoredAt ?? 0) - (b.scoredAt ?? 0)) * mul
      const at = taskTitleMap.get(a.runId) ?? a.runId
      const bt = taskTitleMap.get(b.runId) ?? b.runId
      return at.localeCompare(bt) * mul
    })
    return rows
  }, [visibleEntries, sort, taskTitleMap])

  const toggleSort = (key: SortKey) =>
    setSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'task' ? 'asc' : 'desc' },
    )

  // Aggregates derived from the current visible set — recomputed whenever the
  // search or filter changes so they can never be stale relative to the table.
  const { medianScore, belowCount } = useMemo(() => {
    const scores = visibleEntries
      .map((e) => e.score as number)
      .sort((a, b) => a - b)
    const n = scores.length
    const medianScore =
      n === 0
        ? null
        : n % 2 === 0
          ? (scores[n / 2 - 1]! + scores[n / 2]!) / 2
          : scores[Math.floor(n / 2)]!
    const belowCount = scores.filter((s) => s < THRESHOLD).length
    return { medianScore, belowCount }
  }, [visibleEntries])

  // Controls are only relevant when there is something to filter.
  const hasScored = filtered.length > 0

  return (
    <div data-testid="studio-index-page" className="flex h-full flex-col overflow-hidden bg-background">
      <PageHeader
        title="Scores"
        subtitle={`How recent runs were graded — scored 0–1, passing threshold ${THRESHOLD}`}
        toolbar={
          hasScored ? (
            <div className="flex items-center gap-3">
              <input
                type="search"
                data-testid="studio-index-search"
                aria-label="Search runs"
                placeholder="Search runs…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-48 rounded border border-border bg-card px-2 py-0.5 text-body placeholder:text-muted-foreground focus:outline-none"
              />
              <button
                type="button"
                data-testid="studio-index-below-filter"
                aria-pressed={belowOnly}
                onClick={() => setBelowOnly((v) => !v)}
                className={cn(
                  'rounded border px-2 py-0.5 text-label transition-colors',
                  belowOnly
                    ? 'border-foreground/30 bg-foreground/8 text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                Below {THRESHOLD}
              </button>
            </div>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {/* Workflow selector — rendered only when there is a choice to make.
            The guard used to be `> 0`, so with a single scored workflow the
            page showed a dropdown containing exactly one option: a control
            that looks actionable, opens, and can only reselect what is
            already selected. */}
        {(workflows ?? []).length > 1 && (
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
        ) : filtered.length === 0 ? (
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
          <>
            {/* Aggregate line — count, median, and how many fall below the
                threshold. Recomputes whenever the search or filter narrows the
                set. */}
            <p
              data-testid="studio-index-aggregate"
              className="mb-3 text-label text-muted-foreground"
            >
              {visibleEntries.length} {visibleEntries.length === 1 ? 'run' : 'runs'}
              {medianScore !== null ? ` · median ${medianScore.toFixed(2)}` : ''}
              {` · ${belowCount} below ${THRESHOLD}`}
              <span className="ml-3 text-micro">
                Scores grade the work, not whether the steps ran.
              </span>
            </p>

            {scoredEntries.length === 0 ? (
              <p className="text-body text-muted-foreground">
                No runs match the current filter.{' '}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() => {
                    setSearch('')
                    setBelowOnly(false)
                  }}
                >
                  Clear filters
                </button>
              </p>
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
                            href={scoresHash(entry.runId)}
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
                          <ScoreBar score={entry.score} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  )
}
