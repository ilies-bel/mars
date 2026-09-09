import { Check } from 'lucide-react'
import { SelectField } from '@/components/SelectField'
import { useState, useMemo } from 'react'
import { useScorerWorkflows } from '@/entities/watchtower/useScorerWorkflows'
import { useLoopLedger } from '@/entities/watchtower/useLoopLedger'
import { SkeletonList } from '@/components/Skeleton'
import { useTasks } from '@/hooks/useTasks'
import { formatAbsoluteDateTime, relativeTime } from '@/shared/time'
import { studioHash } from '@/shared/routing'

/**
 * Renders the Loop ledger subsection of the Watchtower panel.
 *
 * A workflow-kind <SelectField> (defaulting to the first known workflow) sits above
 * a table with columns [Run, Scored at, Score, Recorded, Suggest, Review].
 * Each row corresponds to one pass through the run→score→record→suggest→review
 * loop. Stages that have not yet completed render '—'.
 *
 * The <SelectField> depends only on `workflows`, not the ledger query, so it is
 * rendered unconditionally. The isLoading guard is moved to the table body
 * so the workflow selector stays visible while ledger data loads.
 */
export const LoopLedgerPanel = () => {
  const { data: workflows } = useScorerWorkflows()

  // `selected` is the user's explicit pick; null means "use the first workflow
  // from the list" so the panel auto-populates when workflows first load.
  const [selected, setSelected] = useState<string | null>(null)
  const workflow = selected ?? workflows?.[0] ?? null

  const { entries, isLoading, error } = useLoopLedger(workflow)

  // Build an id→title map so each run row can show a human label instead of a
  // bare task id. The snapshot is almost always already cached from the Progress
  // tab, so this adds zero network requests in the common case.
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

  // Which loop stages actually carry data in this window. A stage that has not
  // run for ANY visible row contributes a full column of em-dashes: N rows of
  // nothing, competing for width with the rows that do say something. Those
  // columns are dropped — but dropping alone is lossy (a missing column reads
  // as "this stage does not exist" rather than "it has not run"), so the names
  // are restated in a caption below the table.
  const present = useMemo(
    () => ({
      scoredAt: entries.some((e) => e.scoredAt !== null),
      score: entries.some((e) => e.score !== null),
      recorded: entries.some((e) => e.recorded),
      suggestion: entries.some((e) => e.suggestion !== null),
      review: entries.some((e) => e.review !== null),
    }),
    [entries],
  )

  const dormant = (
    [
      ['Scored at', present.scoredAt],
      ['Score', present.score],
      ['Recorded', present.recorded],
      ['Suggest', present.suggestion],
      ['Review', present.review],
    ] as const
  )
    .filter(([, has]) => !has)
    .map(([label]) => label)

  return (
    <div className="flex flex-col gap-2">
      <SelectField
        value={workflow ?? ''}
        onChange={(e) => setSelected(e.target.value || null)}
        className="self-start rounded border border-border bg-card px-2 py-0.5 text-body"
      >
        {(workflows ?? []).map((kind) => (
          <option key={kind} value={kind}>
            {kind}
          </option>
        ))}
      </SelectField>
      {isLoading ? (
        <SkeletonList rows={3} rowClassName="h-5 w-full mb-1" label="Loading loop ledger" />
      ) : error ? (
        <p role="alert" className="text-error text-body">Couldn't load loop ledger</p>
      ) : entries.length === 0 ? (
        <p className="text-muted-foreground text-body">No loop runs yet</p>
      ) : (
        <table className="w-full text-body">
          <thead>
            <tr className="eyebrow text-left text-muted-foreground">
              <th className="whitespace-nowrap pb-1 pr-2">Run</th>
              {present.scoredAt && <th className="whitespace-nowrap pb-1 pr-2">Scored at</th>}
              {present.score && <th className="whitespace-nowrap pb-1 pr-2">Score</th>}
              {present.recorded && <th className="whitespace-nowrap pb-1 pr-2">Recorded</th>}
              {present.suggestion && <th className="whitespace-nowrap pb-1 pr-2">Suggest</th>}
              {present.review && <th className="whitespace-nowrap pb-1">Review</th>}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const title = taskTitleMap.get(entry.runId) ?? entry.runId
              return (
                <tr
                  key={entry.runId}
                  className="transition-colors hover:bg-foreground/[0.035]"
                >
                  <td className="py-0.5 pr-2">
                    <div className="flex flex-col">
                      {/* This panel and the Studio index (#/studio) read the
                          same GET /api/loop-ledger and name the same runs, but
                          neither offered a way to the other: the ledger could
                          tell you the loop stalled at "suggest" and then leave
                          you to find that run by hand. The run title is the
                          natural exit — Studio links the identical
                          studioHash(entry.runId) from the identical data, so
                          this is the drill-in the ledger was missing, not a
                          new destination. */}
                      <a
                        href={studioHash(entry.runId)}
                        className="text-foreground decoration-muted-foreground decoration-1 underline-offset-2 transition-colors hover:underline"
                      >
                        {title}
                      </a>
                      {title !== entry.runId && (
                        <span
                          className="text-micro text-muted-foreground"
                          title={entry.runId}
                        >
                          {entry.runId}
                        </span>
                      )}
                    </div>
                  </td>
                  {present.scoredAt && (
                    <td className="py-0.5 pr-2" title={entry.scoredAt !== null ? formatAbsoluteDateTime(entry.scoredAt) : undefined}>
                      {entry.scoredAt !== null ? relativeTime(entry.scoredAt) : '—'}
                    </td>
                  )}
                  {present.score && (
                    <td className="py-0.5 pr-2">
                      {entry.score !== null ? entry.score.toFixed(2) : '—'}
                    </td>
                  )}
                  {present.recorded && (
                    <td className="py-0.5 pr-2">
                      {entry.recorded ? <Check size={11} strokeWidth={2.5} aria-hidden="true" /> : '—'}
                    </td>
                  )}
                  {present.suggestion && (
                    <td className="py-0.5 pr-2">
                      {entry.suggestion !== null
                        ? `${entry.suggestion.version} (${entry.suggestion.decisionKind})`
                        : '—'}
                    </td>
                  )}
                  {present.review && (
                    <td className="py-0.5">
                      {entry.review !== null
                        ? `${entry.review.decision} · ${relativeTime(entry.review.decidedAt)}`
                        : '—'}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {dormant.length > 0 && entries.length > 0 && (
        <p className="text-micro text-muted-foreground">
          {`Not reached yet in this window: ${dormant.join(', ')}.`}
        </p>
      )}
    </div>
  )
}
